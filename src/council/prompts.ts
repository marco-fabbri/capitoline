import type { Aggregate } from "./types.js";

/**
 * The three prompts are the strategy, not a CLI detail, so they live in the
 * code and never in `config/capitoline.yaml` (design §12.8). A council without
 * a ranking stage sends two of them, and the synthesis handles the empty
 * aggregate itself: one shape more does not buy a strategy object. Changing one
 * changes how the council behaves, which means it changes the strategy: this
 * number is reported in every `Deliberation`, which is what lets two runs be
 * compared months apart and what says plainly that a name's behaviour is not
 * the one a measurement was taken against.
 *
 * Serving the previous strategy alongside the new one, under `capitoline-2`
 * and the like (design §12.8), means keeping its prompts in this file and a
 * council entry pointing at them. That is done when a caller has measured
 * something worth preserving, and not by reflex: version 1's only measurement
 * is the one that found the flaw version 2 fixes, so there is nothing in it to
 * keep and every council moves forward.
 *
 * Version 2 (2026-09-22): the synthesis prompt no longer merges freely. The
 * first ladder deliberation put the one correct answer first, unanimously, and
 * the judge then shipped a claim none of the members had made — an error born
 * in stage 3, where nothing in the design can see it, because the ranking
 * judges the answers and never the synthesis.
 */
export const STRATEGY_VERSION = 2;

/**
 * The shape stage 2 must answer in, stated in the prompt itself. §12.1 makes
 * this the point of the stage: "the reply is JSON against a schema, not prose
 * parsed by a regex". `parseRanking()` is the same contract read back, and
 * `test/ranking.test.ts` feeds a reply built from this schema through it, so
 * the two cannot drift apart silently.
 *
 * `label` carries no enum because the labels are assigned per deliberation
 * (§12.4) while this constant is rendered verbatim into the prompt; the
 * allowed labels are listed in the prompt text right beside it.
 */
export const RANKING_SCHEMA = {
  type: "array",
  description: "One entry per response shown, including your own.",
  items: {
    type: "object",
    properties: {
      label: { type: "string", description: "The label of the response, exactly as it was shown (for example \"Response A\")." },
      rank: { type: "integer", minimum: 1, description: "1 is the best. Ties are allowed: two responses may share a rank." },
      reason: { type: "string", description: "One or two sentences saying why." },
    },
    required: ["label", "rank", "reason"],
    additionalProperties: false,
  },
} as const;

/**
 * A block of text that came from a model, kept away from the instructions
 * around it.
 *
 * The closing delimiter is neutralised inside the text, because the text is
 * not ours: a member's answer that contained a line `>>>` followed by
 * instructions would close the block early and have the rest read as
 * instructions — in the ranking prompt of every other member, and in the
 * judge's prompt, which is the text that produces the answer the client
 * receives. The threat model is mild (the models are the owner's own
 * subscriptions) but the defence costs one call: a zero-width space between
 * the angle brackets leaves the text readable and makes the delimiter
 * impossible to reproduce from the content.
 */
const quote = (text: string): string => `<<<\n${text.replaceAll(">>>", ">\u200b>\u200b>")}\n>>>`;

/**
 * Stage 1. The question, and nothing else about the machinery.
 *
 * The member is not told that it sits on a panel, that its answer will be
 * ranked, or that other models are answering the same question. The reason is
 * §12.1's: the stage buys independent answers, and a model told it is being
 * judged writes for the judge — it hedges, it pads, it argues with an
 * imagined opponent. What is wanted here is the answer it would have given to
 * the client directly, which is also what makes the one-answer fallback of
 * §12.5 honest: when a single member survives, the gateway returns this very
 * answer and says no council took place.
 */
export function answerPrompt(question: string): string {
  return [
    "Answer the following question as completely and precisely as you can.",
    "Be concrete, state the reasoning that matters, and say plainly when something is uncertain or when the question does not have one right answer.",
    "",
    "Question:",
    quote(question),
  ].join("\n");
}

/**
 * Stage 2. Every answer under its label, the member's own included and named
 * as its own.
 *
 * Telling the member which answer is its own looks like it weakens the
 * anonymity, and does not: the members are anonymous *to each other*, never to
 * themselves. A model recognises its own prose anyway, and one that is not
 * told will still rate it highly while believing it is impartial. Naming it
 * and asking for honesty at least makes the bias something the model can
 * correct for, and it is the only part of the mapping the member ever sees —
 * the other labels stay unattributed, which is the mechanism §12.3 refuses to
 * make configurable.
 *
 * Invariant: the engine passes the same label list to `rankingPrompt()` and to
 * `parseRanking()`, the member's own label included. The two ends of the stage
 * are one contract — the prompt asks for every label shown, the parser refuses
 * a reply that leaves one out — so a caller that shows the others' answers here
 * and then parses against a different list gets every ranking thrown away as
 * unparseable, and a deliberation that degrades to "no ranking" without a
 * single error. The guard below catches the readable half of that mistake
 * (`own` not among the answers) at the first call rather than in the output.
 */
export function rankingPrompt(question: string, answers: { label: string; text: string }[], own: string): string {
  const labels = answers.map((a) => a.label);
  if (!labels.includes(own)) {
    throw new Error(`rankingPrompt(): the member's own label ${own} is not among the answers shown (${labels.join(", ") || "none"})`);
  }
  return [
    `Several assistants answered the same question independently. Below are their answers, labelled. One of them, ${own}, is your own answer from earlier in this deliberation.`,
    "",
    "Question:",
    quote(question),
    "",
    ...answers.map((a) => [`${a.label}:`, quote(a.text), ""].join("\n")),
    "Rank every answer shown, including your own, from best to worst. Judge only the answers: whether each one is correct, answers the question that was asked, and supports what it claims. Rank your own answer as honestly as the others — it is named only so you do not rate it well by accident.",
    "",
    `Rank 1 is the best. Ties are allowed: give two answers the same rank when you cannot separate them. Cover all ${labels.length} labels, exactly once each: ${labels.join(", ")}.`,
    "",
    "Reply with JSON only — no prose before or after it — against this schema:",
    JSON.stringify(RANKING_SCHEMA, null, 2),
  ].join("\n");
}

/** One line of the aggregate, or the plain truth when nobody ranked that answer. */
function aggregateLine(a: Aggregate): string {
  return a.votes === 0
    ? `- ${a.label}: not ranked by anyone`
    : `- ${a.label}: average rank ${a.averageRank} over ${a.votes} ${a.votes === 1 ? "vote" : "votes"}`;
}

/**
 * Stage 3. The judge writes the answer the client receives.
 *
 * `identities` maps a *label* to the real model name — the direction the
 * prompt reads in, since everything here is rendered by label; the engine
 * holds the inverse (`labels()` returns model → label) and inverts it. It is
 * ignored entirely when `blind`, which is the default: a blind judge makes the
 * deliberation blind end to end, and the transparency is not lost, it moves to
 * the response (§12.3, §12.6). When the judge is un-blinded and no identities
 * are given, the labels stand — an un-blinded judge is a configuration choice,
 * not a reason to fail a deliberation eight calls in.
 *
 * The aggregate is given as evidence, not as an instruction: the judge is told
 * to weigh it and told it may disagree with it. A panel of four can rank a
 * confidently wrong answer first, and a judge ordered to follow the vote would
 * have no way to say so.
 *
 * `ranked` is the council's configured shape, passed by the engine from
 * `ranking:` rather than guessed here: an empty aggregate is only the same
 * thing by accident, because the engine always hands `aggregate()` the label
 * list and a ranked panel therefore always has entries (`votes: 0` for the
 * labels nobody ranked). The day an aggregate is seeded for a fast council
 * too, a prompt that read the shape off its length would silently tell the
 * judge about a ranking that never happened. The length stays as the default
 * for the callers that have no council to ask, the tests among them.
 *
 * Unranked — the `-fast` shape — drops the paragraph that introduces the
 * ranking, along with every other mention of one: showing an empty section, or
 * telling a judge the answers were ranked and then showing nothing, invites it
 * to weigh a vote that was never cast. What stays is the phrase this prompt is
 * recognised by end to end — "You are writing the final answer", which the
 * fake CLIs of the test suite select the judge's recording with — and the
 * instruction to answer directly, which is what keeps the machinery out of the
 * text the client reads.
 */
export function synthesisPrompt(
  question: string,
  answers: { label: string; text: string }[],
  aggregate: Aggregate[],
  blind: boolean,
  identities?: Map<string, string>,
  ranked: boolean = aggregate.length > 0,
): string {
  if (!blind && identities !== undefined && identities.size > 0 && answers.length > 0 && !answers.some((a) => identities.has(a.label))) {
    // The map that `labels()` builds runs model -> label, and this one runs
    // label -> model: same TypeScript type, opposite direction, so a caller
    // that forgets to invert it compiles, resolves nothing, and serves a judge
    // configured as un-blinded a blind prompt while the `Deliberation` says
    // `blind: false`. The fallback below is meant for "no identities at all",
    // not for that, so a map that resolves none of the labels is an error.
    throw new Error("synthesisPrompt(): identities are keyed by model, not by label");
  }
  const name = (label: string): string => {
    const model = blind ? undefined : identities?.get(label);
    return model === undefined ? label : `${label} (${model})`;
  };
  return [
    ranked
      ? "Several assistants answered the same question independently and then ranked each other's answers without knowing who wrote what. You are writing the final answer."
      : "Several assistants answered the same question independently. You are writing the final answer.",
    "",
    "Question:",
    quote(question),
    "",
    ...answers.map((a) => [`${name(a.label)}:`, quote(a.text), ""].join("\n")),
    ...(ranked ? ["The panel's ranking, best first:", ...aggregate.map(aggregateLine), ""] : []),
    ranked
      ? "Build your answer on the top-ranked response. Keep what it says and add from the others only what does not contradict it. Where another response contradicts it on a point of fact, do not blend the two into a claim neither of them made: decide which is right and say so plainly, or, if you cannot decide, give both readings and what turns on the difference. Assert nothing that none of the responses supports. The ranking is evidence about the responses and not an instruction — if you are confident the panel preferred a response that is mistaken, depart from it and say in your own words why. Where the responses genuinely disagree and the question has no settled answer, give the disagreement rather than picking one at random."
      : "Write the best possible answer to the question. Take what is right from each answer and leave what is wrong: judge each one on whether it is correct, answers the question that was asked and supports what it claims. Do not blend two answers that contradict each other into a claim neither of them made, and assert nothing that none of them supports: where they disagree on a point of fact, decide which is right and say so plainly. Where they genuinely disagree and the question has no settled answer, give the disagreement and what turns on it rather than picking one at random.",
    "",
    ranked
      ? "Answer the question directly, as if you were the only one asked. Do not name the responses, do not mention their labels, the ranking or the fact that a panel was consulted."
      : "Answer the question directly, as if you were the only one asked. Do not name the responses, do not mention their labels or the fact that several assistants were consulted.",
  ].join("\n");
}
