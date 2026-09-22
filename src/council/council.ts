import { randomUUID } from "node:crypto";
import type { Logger } from "../log.js";
import { CapitolineError, type FailureKind, type InternalRequest, type Usage } from "../core/types.js";
import type { ProviderEvent } from "../core/types.js";
import { labels, nextInChain, seat, type ModelState } from "./seating.js";
import { STRATEGY_VERSION, answerPrompt, rankingPrompt, synthesisPrompt } from "./prompts.js";
import { aggregate, parseRanking } from "./ranking.js";
import type { CouncilConfig, Deliberation, DeliberationMember, LostSeat, MemberRanking, Ranking, Seat } from "./types.js";

export type { Deliberation, DeliberationMember, LostSeat, MemberRanking } from "./types.js";

/** The three stages of §12.1, named the same way in the progress the client is shown. */
export type CouncilStage = "answers" | "rankings" | "synthesis";

/**
 * What a running deliberation reports as it goes.
 *
 * `progress` is what §12.6 gives a streaming client while the first two stages
 * run and there is nothing to stream token by token: one event when a stage
 * opens (`done: 0`) and one per completion inside it. `text` is the synthesis,
 * as it is written — or, in the one case of §12.5, the single surviving answer
 * passed through unchanged. Exactly one of `done` or `error` ends the
 * iteration, unless the request was cancelled, which ends it silently.
 *
 * `kind` is a `FailureKind` and not the narrower `ErrorKind`: what ends a
 * council is a member's failure (`RANK` below picks which one speaks for the
 * panel), and a member is refused through
 * `Core.execute()` exactly as an HTTP request is — with `queue_full` when the
 * provider's queue is full and `model_unavailable` when its health went down
 * between the seating and the call. Narrowing those to a provider error would
 * turn a 503 or a 404 into a 502 and tell the client to retry the wrong thing.
 */
export type CouncilEvent =
  | { type: "progress"; stage: CouncilStage; done: number; total: number }
  | { type: "text"; delta: string }
  | { type: "done"; usage: Usage; detail: Deliberation }
  | { type: "error"; kind: FailureKind; detail: string };

/**
 * How a deliberation is asked for, which is how an ordinary request is asked
 * for: the council adds nothing of its own.
 *
 * `caller` is carried for the same reason `Core` carries it on a direct
 * request — it is what `/v1/usage` groups by. A council that dropped it would
 * write the nine most expensive rows of the gateway into the "not attributed"
 * bucket, on the very gateway where several applications share one tunnel and
 * that breakdown is the only thing that says which one spent the quota.
 */
export interface CouncilContext {
  signal?: AbortSignal;
  source: "http" | "mcp";
  caller?: string | null;
}

/**
 * The slice of `Core` the council uses, and the whole of it.
 *
 * Every member call goes through `Core.execute()`, so the queue, the pauses,
 * the health state and the usage rows apply to a council member exactly as to
 * a direct request; the council never talks to a provider or a runner. The
 * interface exists so the engine can be tested without a Core, and so that
 * this list — two methods — is the only coupling between the two modules.
 */
export interface CouncilCore {
  listModels(): { name: string; available: boolean; reason?: string }[];
  execute(req: InternalRequest, ctx: { signal?: AbortSignal; source: "http" | "mcp"; caller?: string | null; deliberation?: string }): AsyncIterable<ProviderEvent>;
}

/**
 * The refusals a seat is allowed to step down from (§12.2, "after an
 * unforeseen refusal"). Both are about the subscription behind the model and
 * not about the question, so the next model of the chain has a real chance of
 * answering. A crash, a timeout or unreadable output would repeat themselves,
 * and retrying them would spend a second call to learn nothing.
 */
const STEP_DOWN = new Set<FailureKind>(["rate_limited", "auth_expired"]);

/** The reasons `Core.listModels()` gives that are already a failure kind, so an unseatable chain reports what the state knew rather than a flat "unavailable". */
const KNOWN_REASONS = new Set<string>(["rate_limited", "auth_expired", "timeout", "cli_crashed", "bad_output", "unknown_model"]);
const kindOfReason = (reason: string | undefined): FailureKind =>
  reason !== undefined && KNOWN_REASONS.has(reason) ? (reason as FailureKind) : "model_unavailable";

/**
 * Which failure speaks for a deliberation that produced nothing.
 *
 * The failures are collected in the order the configuration declares the
 * seats, so taking the first would let a seat the state had already emptied
 * (`model_unavailable`, a 404 the client can do nothing with) speak for a
 * panel whose other seat was refused with `rate_limited` (a 429 with a
 * Retry-After). The client would be sent to retry the wrong thing, which is
 * the very reason the event carries a `FailureKind` and not a provider error.
 * Lowest number wins: what the client can act on first, what is definitive
 * last. A `Record` rather than a list, so a new `FailureKind` does not compile
 * until it has been placed.
 */
const RANK: Record<FailureKind, number> = {
  rate_limited: 0, auth_expired: 1, queue_full: 2, timeout: 3,
  cli_crashed: 4, bad_output: 5, model_unavailable: 6, unknown_model: 7, bad_request: 8, unauthorized: 9,
};
const worstOf = (failures: FailureKind[]): FailureKind | undefined => [...failures].sort((a, b) => RANK[a] - RANK[b])[0];

/** A member of a deliberation in flight. Its label is empty until stage 2 assigns one. */
interface RunningMember {
  seat: Seat;
  model: string;
  label: string;
  answer: string;
  fellBackFrom: string[];
}

type MemberOutcome =
  | { ok: true; member: RunningMember }
  | { ok: false; lost: LostSeat; kind: FailureKind };

/** One call's outcome. The usage is counted either way: a refused call can still have spent tokens. */
type CallResult =
  | { ok: true; text: string; usage: Usage }
  | { ok: false; kind: FailureKind; detail: string; usage: Usage };

/**
 * What `callStream()` is closed with when the synthesis is abandoned mid-flight
 * — a client that disconnected, or a caller that stopped reading. The value is
 * thrown away; what matters is that `return()` resumes the generator inside its
 * own `finally`, which is where the stage timer is cleared and the abort
 * listener removed. Without it a forgotten deliberation would leave both behind.
 */
const ABANDONED: CallResult = { ok: false, kind: "timeout", detail: "the deliberation was abandoned", usage: { input: 0, output: 0 } };

/**
 * The state of one deliberation. It is a value passed around and never a field
 * of `Council`: one `Council` is built per configured council at start-up and
 * serves every request for it, so two deliberations run on the same instance
 * at the same time. A `calls` counter on the object would count the other
 * request's calls and the accounting of §12.7 would be wrong in a way nothing
 * would notice.
 */
interface Run {
  /** The deliberation identifier of §12.7, written to every usage row the run causes, so nine rows under six models can be summed as one question. */
  id: string;
  calls: number;
  usage: Usage;
}

/**
 * The tasks in completion order, each with the index it was given in. The two
 * parallel stages need both: the progress the client sees follows completions,
 * while the deliberation reports the seats in the order the configuration
 * declares them, so that two runs of the same panel read the same way.
 *
 * The tasks must not reject — the engine's own never do, every failure being a
 * value — since a rejection here would leave the other promises unobserved.
 */
async function* settle<T>(tasks: Promise<T>[]): AsyncGenerator<{ index: number; value: T }> {
  const pending = new Map<number, Promise<{ index: number; value: T }>>();
  tasks.forEach((task, index) => pending.set(index, task.then((value) => ({ index, value }))));
  while (pending.size > 0) {
    const first = await Promise.race(pending.values());
    pending.delete(first.index);
    yield first;
  }
}

/**
 * Labels in the order they were handed out — A, B, …, Z, AA — which is not the
 * alphabetical order past Z. The answers are shown in this order in both
 * prompts, so the position an answer appears in says nothing about the seat
 * that wrote it: the label is a seeded shuffle (§12.4) and the order follows
 * the label.
 */
const byLabel = (a: { label: string }, b: { label: string }): number =>
  a.label.length - b.label.length || a.label.localeCompare(b.label);

/**
 * The three stages of the council (design §12.1), over one `CouncilCore`.
 *
 * Nothing here knows what a provider or a CLI is: a member is a model name
 * given to `Core.execute()`, which is what makes a member's call queue, pause,
 * fail and get accounted exactly like a request a client made directly.
 */
export class Council {
  constructor(
    private readonly name: string,
    private readonly cfg: CouncilConfig,
    private readonly core: CouncilCore,
    private readonly log: Logger,
  ) {}

  /**
   * One deliberation. The events are the whole output: the caller renders them
   * as SSE, as MCP progress notifications or as a single JSON body, and the
   * council is the same in all three cases.
   *
   * A cancelled request stops the stage it is in and starts no other. It ends
   * the iteration without a terminal event, because there is nobody left to
   * tell: the client that asked has gone, and `Core` has already recorded every
   * call it made as aborted.
   */
  async *deliberate(question: string, ctx: CouncilContext): AsyncIterable<CouncilEvent> {
    const run: Run = { id: randomUUID(), calls: 0, usage: { input: 0, output: 0 } };
    const state = this.core.listModels();
    const seated = seat(this.cfg.seats, state);

    // Stage 1: every seated member answers the same question, in parallel and
    // knowing nothing of the panel.
    const total = seated.members.length;
    yield { type: "progress", stage: "answers", done: 0, total };
    // A generator is suspended at its yields, so this is where a cancellation
    // that arrives between the seating and the first call lands. Without the
    // check the four member calls would be started for a client that has
    // already gone, and each one would run to its stage timeout.
    if (ctx.signal?.aborted) return;
    const outcomes = new Map<Seat, MemberOutcome>();
    const tasks = seated.members.map(({ seat: s, model }) =>
      this.ask(run, s, model, question, ctx, seated.skipped.filter((k) => k.seat === s).map((k) => `${k.model} (${k.reason})`)));
    let answered = 0;
    for await (const { index, value } of settle(tasks)) {
      outcomes.set(seated.members[index].seat, value);
      yield { type: "progress", stage: "answers", done: ++answered, total };
    }
    if (ctx.signal?.aborted) return;

    // In the order the configuration declares the seats, not the order they
    // came back in: a deliberation is read next to another one.
    const members: RunningMember[] = [];
    const lost: LostSeat[] = [];
    const failures: FailureKind[] = [];
    for (const s of this.cfg.seats) {
      if (seated.empty.includes(s)) {
        const skips = seated.skipped.filter((k) => k.seat === s);
        lost.push({ family: s.family, reason: `no model of the chain is available: ${skips.map((k) => `${k.model} ${k.reason}`).join(", ")}` });
        failures.push(kindOfReason(skips.at(-1)?.reason));
        continue;
      }
      const outcome = outcomes.get(s);
      if (outcome === undefined) continue;
      if (outcome.ok) members.push(outcome.member);
      else { lost.push(outcome.lost); failures.push(outcome.kind); }
    }
    if (lost.length > 0) this.log.warn({ council: this.name, lost }, "seats lost before the ranking");

    // §12.5: below the quorum there is nothing to rank. One answer is returned
    // as the member wrote it and declared as no council at all, rather than
    // dressed as a synthesis; none is reported as the failure that speaks for
    // the panel, which is the one the client can act on (RANK).
    if (members.length < this.cfg.minMembers) {
      if (members.length === 0) {
        const kind = worstOf(failures) ?? "model_unavailable";
        yield { type: "error", kind, detail: `no member answered: ${lost.map((l) => `${l.family} ${l.reason}`).join("; ") || "no seat could be filled"}` };
        return;
      }
      this.log.warn({ council: this.name, answers: members.length, quorum: this.cfg.minMembers }, "below the quorum: the answer is returned without a council");
      this.assignLabels(members, question);
      yield { type: "text", delta: members[0].answer };
      yield this.finish(run, members, lost, [], [], "");
      return;
    }

    // Stage 2: the anonymous peer ranking, each member shown every answer
    // including its own.
    this.assignLabels(members, question);
    const answers = [...members].sort(byLabel).map((m) => ({ label: m.label, text: m.answer }));
    const labelList = answers.map((a) => a.label);
    yield { type: "progress", stage: "rankings", done: 0, total: members.length };
    const votes = new Array<Ranking[] | null>(members.length).fill(null);
    let ranked = 0;
    for await (const { index, value } of settle(members.map((m) => this.rank(run, m, question, answers, labelList, ctx)))) {
      votes[index] = value;
      yield { type: "progress", stage: "rankings", done: ++ranked, total: members.length };
    }
    if (ctx.signal?.aborted) return;
    const rankings: MemberRanking[] = [];
    members.forEach((m, i) => { const v = votes[i]; if (v !== null) rankings.push({ by: m.model, ranking: v }); });
    const verdict = aggregate(rankings.map((r) => r.ranking), labelList);

    // Stage 3: the judge, seated apart from the members and blind by default.
    yield { type: "progress", stage: "synthesis", done: 0, total: 1 };
    // The same window as above, on the other side of a yield: an abort that
    // landed here must not buy the ninth call.
    if (ctx.signal?.aborted) return;
    const judge = this.seatJudge(members);
    if (judge === null) {
      // Eight calls are spent and every one of the answers is real. Failing
      // here would throw the whole deliberation away because the ninth model
      // is missing, which is the opposite of what §12.5 does for the members.
      // So the panel's own best-ranked answer is returned as its member wrote
      // it, and `judge.model: ""` says plainly that nobody synthesised — the
      // client reads the whole council in the `capitoline` field. No
      // `synthesis 1/1` follows: the stage did not happen.
      this.log.warn({ council: this.name, chain: this.cfg.judge.models }, "no judge could be seated: the best-ranked answer is returned unsynthesised");
      const top = members.find((m) => m.label === verdict[0]?.label) ?? members[0];
      yield { type: "text", delta: top.answer };
      yield this.finish(run, members, lost, rankings, verdict, "");
      return;
    }
    const identities = new Map(members.map((m) => [m.label, m.model]));
    const prompt = synthesisPrompt(question, answers, verdict, this.cfg.judgeBlind, identities);
    let model = judge.model;
    let spoken = false;
    for (let attempt = 0; ; attempt++) {
      const call = this.callStream(run, model, prompt, ctx, true);
      let step = await call.next();
      try {
        while (step.done !== true) {
          spoken = true;
          yield { type: "text", delta: step.value };
          step = await call.next();
        }
      } finally {
        await call.return(ABANDONED);
      }
      const result = step.value;
      if (result.ok) break;
      if (ctx.signal?.aborted) return;
      // A judge that refused before writing a word steps down its own chain,
      // once, exactly as a member does. One that failed halfway through cannot:
      // the client has already been given the first half of an answer, and a
      // second judge would write a different one after it.
      const next = !spoken && attempt === 0 && STEP_DOWN.has(result.kind) ? nextInChain(judge.seat, model, this.core.listModels()) : null;
      if (next === null) {
        this.log.error({ council: this.name, model, kind: result.kind, detail: result.detail }, "the judge failed and the deliberation has no synthesis");
        // The kind, never the provider's own words: this event becomes the
        // client's error, and `result.detail` is up to two thousand characters
        // of a CLI's stderr. The line above is where it is kept.
        yield { type: "error", kind: result.kind, detail: `the judge failed: ${result.kind}` };
        return;
      }
      this.log.warn({ council: this.name, from: model, to: next, kind: result.kind }, "the judge steps down its chain");
      model = next;
    }
    yield { type: "progress", stage: "synthesis", done: 1, total: 1 };
    yield this.finish(run, members, lost, rankings, verdict, model);
  }

  /**
   * Whether this council can be served right now, against the state of the real
   * models as `Core.listModels()` reports it: at least `min_members` of its
   * seats must be fillable, because below the quorum there is no council at all
   * (§12.5) and offering one would spend the members' calls to say so.
   *
   * The state is a parameter and not `this.core.listModels()`: this is called
   * from inside that very listing, which is where a council appears as a model
   * of its own. The judge is not counted — its chain is walked after the
   * members are done, and a judge that cannot be seated costs the synthesis,
   * not the deliberation (see `deliberate`).
   *
   * The reason is a count and a quorum. It travels to the client in
   * `/v1/models`, where provider detail never goes; what each chain was refused
   * for is in the log and in the deliberation's `lost`.
   */
  seatable(state: ModelState[]): { available: boolean; reason?: string } {
    const filled = seat(this.cfg.seats, state).members.length;
    if (filled >= this.cfg.minMembers) return { available: true };
    return { available: false, reason: `only ${filled} of ${this.cfg.seats.length} seats can be filled: the quorum is ${this.cfg.minMembers}` };
  }

  /** The label each answer is ranked under (§12.4), assigned once the panel is known and never before. */
  private assignLabels(members: RunningMember[], question: string): void {
    const map = labels(members, question);
    for (const m of members) m.label = map.get(m.model) ?? "";
  }

  /**
   * The judge's seat: its own chain, minus the models the panel took unless
   * `judgeAllowMember` says otherwise (§12.3), walked against the state as any
   * other seat is. null when nothing of it is left.
   */
  private seatJudge(members: RunningMember[]): { seat: Seat; model: string } | null {
    const taken = new Set(members.map((m) => m.model));
    const chain = this.cfg.judgeAllowMember ? this.cfg.judge.models : this.cfg.judge.models.filter((m) => !taken.has(m));
    const judgeSeat: Seat = { family: this.cfg.judge.family, models: chain };
    const seated = seat([judgeSeat], this.core.listModels());
    return seated.members.length === 0 ? null : { seat: judgeSeat, model: seated.members[0].model };
  }

  /** The terminal event, with the usage of every call the deliberation spent and the un-blinded record of it (§12.6, §12.7). */
  private finish(run: Run, members: RunningMember[], lost: LostSeat[], rankings: MemberRanking[], verdict: Deliberation["aggregate"], judgeModel: string): Extract<CouncilEvent, { type: "done" }> {
    const detail: Deliberation = {
      deliberationId: run.id,
      strategyVersion: STRATEGY_VERSION,
      members: members.map((m): DeliberationMember => ({
        family: m.seat.family, model: m.model, label: m.label, answer: m.answer,
        ...(m.fellBackFrom.length > 0 ? { fellBackFrom: m.fellBackFrom } : {}),
      })),
      lost,
      rankings,
      aggregate: verdict,
      judge: { model: judgeModel, blind: this.cfg.judgeBlind },
      calls: run.calls,
    };
    this.log.info({ council: this.name, members: detail.members.length, lost: lost.length, calls: run.calls, usage: run.usage }, "deliberation finished");
    return { type: "done", usage: { ...run.usage }, detail };
  }

  /**
   * Stage 1 for one seat: the answer, or the seat.
   *
   * The one retry of §12.2 is spent here and only on a refusal the state did
   * not predict; `nextInChain` is given a state read *now*, after the refusal,
   * because the refusal itself is what changed it — `Core` has just paused the
   * model or the provider, and stepping onto something that pause covers would
   * waste the retry on a call the gateway would refuse by itself.
   */
  private async ask(run: Run, s: Seat, first: string, question: string, ctx: CouncilContext, skipped: string[]): Promise<MemberOutcome> {
    const fellBackFrom = [...skipped];
    let model = first;
    for (let attempt = 0; ; attempt++) {
      const result = await this.call(run, model, answerPrompt(question), ctx);
      if (result.ok) return { ok: true, member: { seat: s, model, label: "", answer: result.text, fellBackFrom } };
      const next = attempt === 0 && STEP_DOWN.has(result.kind) && ctx.signal?.aborted !== true
        ? nextInChain(s, model, this.core.listModels())
        : null;
      if (next === null) {
        // The classification travels, the detail stays: the `LostSeat` below
        // is serialised into the client's response (§12.6), and what a
        // provider puts in `detail` is its CLI's stderr.
        this.log.warn({ council: this.name, family: s.family, model, kind: result.kind, detail: result.detail }, "a seat was lost");
        return { ok: false, kind: result.kind, lost: { family: s.family, model, reason: result.kind, ...(fellBackFrom.length > 0 ? { fellBackFrom } : {}) } };
      }
      this.log.warn({ council: this.name, family: s.family, from: model, to: next, kind: result.kind }, "a seat steps down its chain");
      fellBackFrom.push(`${model} (${result.kind})`);
      model = next;
    }
  }

  /**
   * Stage 2 for one member, or null. A ranking that fails, or that the parser
   * refuses, is not an error: the member keeps its answer and the others'
   * votes decide the aggregate (§12.5). It is not retried either — a second
   * call would cost as much as an answer and buy one vote.
   */
  private async rank(run: Run, member: RunningMember, question: string, answers: { label: string; text: string }[], labelList: string[], ctx: CouncilContext): Promise<Ranking[] | null> {
    const result = await this.call(run, member.model, rankingPrompt(question, answers, member.label), ctx);
    if (!result.ok) {
      this.log.warn({ council: this.name, model: member.model, kind: result.kind }, "a member did not rank");
      return null;
    }
    try {
      // The same list the prompt showed, the member's own label included: the
      // two ends of the stage are one contract (see rankingPrompt).
      return parseRanking(result.text, labelList);
    } catch (e) {
      this.log.warn({ council: this.name, model: member.model, err: String(e) }, "a member's ranking could not be read");
      return null;
    }
  }

  /** One call, drained. Stage 1 and stage 2 have nothing to stream: their output is read whole before it is used. */
  private async call(run: Run, model: string, prompt: string, ctx: CouncilContext): Promise<CallResult> {
    const it = this.callStream(run, model, prompt, ctx, false);
    let step = await it.next();
    while (step.done !== true) step = await it.next();
    return step.value;
  }

  /**
   * One call through `Core.execute()`, yielding the text as it arrives and
   * returning how it ended. Every call of every stage goes through here, which
   * is what makes a member's call a request like any other: queued on its
   * provider's semaphore, stopped by its pauses, recorded in the usage table
   * under the real model that served it (§12.7).
   *
   * Three things end a call: the provider's own terminal event, the stage
   * timeout, and the client's cancellation. The timeout is per member and per
   * stage, as `stage_timeout_s` says — a deliberation is nine calls over three
   * subscriptions and a single deadline over the whole of it would either be
   * too short for the slowest stage or useless for the others. The timer is
   * unref'd so a forgotten deliberation cannot hold the process open.
   *
   * A `done` with no text is a failure, not an empty answer: nothing can be
   * ranked, and a judge handed a blank would write around it.
   */
  private async *callStream(run: Run, model: string, prompt: string, ctx: CouncilContext, streamed: boolean): AsyncGenerator<string, CallResult, undefined> {
    run.calls++;
    const usage: Usage = { input: 0, output: 0 };
    const controller = new AbortController();
    // A listener added to a signal that is already aborted never fires, so
    // relaying alone would let a cancelled request take a concurrency slot and
    // run to the stage timeout on a real subscription. The state is read once,
    // here, and the listener covers only what arrives afterwards.
    if (ctx.signal?.aborted === true) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.cfg.stageTimeoutS * 1000);
    timer.unref?.();
    const relay = (): void => controller.abort();
    ctx.signal?.addEventListener("abort", relay, { once: true });
    let text = "";
    let failure: { kind: FailureKind; detail: string } | undefined;
    let terminal = false;
    try {
      const req: InternalRequest = { model, messages: [{ role: "user", text: prompt }], stream: streamed };
      for await (const ev of this.core.execute(req, { signal: controller.signal, source: ctx.source, caller: ctx.caller, deliberation: run.id })) {
        if (ev.type === "text") { text += ev.delta; if (streamed) yield ev.delta; }
        else if (ev.type === "done") { terminal = true; usage.input += ev.usage?.input ?? 0; usage.output += ev.usage?.output ?? 0; }
        else if (ev.type === "error") { terminal = true; failure = { kind: ev.kind, detail: ev.detail }; }
        // rate_limit windows and images are Core's business, not the council's.
      }
    } catch (e) {
      // Core throws before the first event for everything it decides itself: an
      // unknown model, a pause already standing, a queue that never opened.
      failure = e instanceof CapitolineError ? { kind: e.kind, detail: e.message } : { kind: "cli_crashed", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", relay);
      run.usage.input += usage.input;
      run.usage.output += usage.output;
    }
    if (timedOut) return { ok: false, kind: "timeout", detail: `no answer within ${this.cfg.stageTimeoutS}s`, usage };
    if (failure !== undefined) return { ok: false, ...failure, usage };
    if (!terminal) return { ok: false, kind: "bad_output", detail: "the call ended without a terminal event", usage };
    if (text.trim() === "") return { ok: false, kind: "bad_output", detail: "the model answered with nothing", usage };
    return { ok: true, text, usage };
  }
}
