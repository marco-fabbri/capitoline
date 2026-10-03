import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { CouncilConfig } from "./council/types.js";

// Ascending, and the order is load-bearing: `nearestEffort` reads it as the
// scale it approximates along. Every level the three CLIs accept is here —
// `claude --effort` takes low..max, Codex's model cache prices low..ultra per
// model, and Antigravity carries the level inside the model id and serves only
// the first three. A provider prices the subset it accepts in its own `effort`
// table, and a model narrows that further with `efforts`, so a value no CLI
// would take can be named here without any provider offering it.
export const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]);
export type Effort = z.infer<typeof EffortSchema>;

export const ModelKindSchema = z.enum(["text", "image"]);
export type ModelKind = z.infer<typeof ModelKindSchema>;

const ModelSchema = z.object({
  cli_model: z.string().min(1),
  effort_suffix: z.boolean().default(false),
  efforts: z.array(EffortSchema).min(1).optional(),
  kind: ModelKindSchema.default("text"),
  // Overrides the provider's timeout_s for this model (image runs are long but bounded).
  timeout_s: z.number().int().min(1).optional(),
}).strict();

// How a provider produces images. The CLI writes the file outside the sandbox,
// so the bytes are collected only through `collect` (command + args; the
// conversation id is appended), never by reading the CLI's home directly.
const ImageSchema = z
  .object({
    args: z.array(z.string()).default([]),
    allowed_tools: z.array(z.string()).default(["generate_image"]),
    collect: z.array(z.string()).min(1).optional(),
    min_bytes: z.number().int().min(0).default(200_000),
    // How many images the short quota window allows, for reporting only: the
    // gateway never blocks on it, and the provider's second, much longer quota
    // cannot be counted at all (it is reported through its reset instant).
    quota_per_window: z.number().int().min(1).optional(),
  })
  .strict()
  .default({});

// How a provider's CLI lists the models it serves, for the daily catalog
// (docs/deploy.md §7.2). Optional: a provider without it — Claude, whose names
// are aliases that already follow the latest model — keeps exactly the models
// this file declares. With it, a listed id no declared model reaches is exposed
// as `<prefix><id>`, and a declared model none of whose ids is listed any more
// is retired: unavailable, never deleted, so the file stays valid.
const DiscoverSchema = z.object({
  // The CLI's own listing command, run as the runner user like any other run.
  args: z.array(z.string().min(1)).min(1),
  // What a discovered id is called: the door's name, as every declared model is.
  prefix: z.string().min(1),
  // Ids never exposed by discovery: a model that is retiring, or one not wanted.
  exclude: z.array(z.string().min(1)).default([]),
}).strict();

const ProviderSchema = z.object({
  binary: z.string().min(1),
  concurrency: z.number().int().min(1),
  // Peak memory of one run of this CLI, in MB, as measured by
  // scripts/measure-cli-resources.py. It changes with every CLI update, which
  // is why it is configuration; the startup check multiplies it by
  // `concurrency` (src/sizing.ts, design §4.1).
  memory_mb: z.number().int().min(1),
  timeout_s: z.number().int().min(1),
  budget: z.object({ window_5h_tokens: z.number().int().min(0), window_7d_tokens: z.number().int().min(0) }).strict(),
  health_model: z.string().min(1),
  // Probed instead of health_model, first still listed wins, when the catalog
  // says health_model's CLI id is gone. Without it a retired probe model would
  // mark every model of the provider unhealthy — the failure GPT-5.5 was
  // heading for on 2026-10-14.
  health_fallback: z.array(z.string().min(1)).default([]),
  discover: DiscoverSchema.optional(),
  // Where to read the installed version and the latest published one, for the
  // daily "a new version exists" notice (src/versions.ts). Optional: without it
  // the provider is never checked. Installing stays a person's decision
  // (scripts/update-cli.sh).
  //
  // `verified` is the version this repository was last checked against: what
  // a new host installs (deploy/ansible, docs/deploy.md §4), and the last row
  // of docs/update-clis.md for that CLI, which a test keeps in step.
  version: z.object({
    args: z.array(z.string().min(1)).min(1),
    verified: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    latest: z.union([
      z.object({ npm: z.string().min(1) }).strict(),
      z.object({ manifest: z.string().url() }).strict(),
    ]),
  }).strict().optional(),
  models: z.record(z.string().min(1), ModelSchema),
  // min(1) on the value: an empty string parses, and the flag then reaches
  // the CLI as `--effort ""` or as a model id ending in "-".
  effort: z.record(EffortSchema, z.string().min(1)),
  args: z.array(z.string()),
  /**
   * What this host adds to the command line, appended after `args`.
   *
   * `mergeConfig` replaces an array wholesale — a command line is one value,
   * not a list to concatenate — so a host that needed one more flag had to
   * copy the whole of `args` into its overlay to append to it. That is the
   * drift the overlay exists to close, turned around: a pull that adds a flag
   * upstream never reached such a host, and `check-config` stayed green
   * because the schema was satisfied either way.
   *
   * With this key the host names only what is its own. Nothing in the
   * repository ever sets it to anything but `[]`, so replacing rather than
   * concatenating costs nothing here.
   *
   * Required and without a default, like the flag keys below and for the same
   * reason: a hand-edited file written before it existed must fail loudly
   * rather than inherit a default and change the command line in silence.
   */
  args_extra: z.array(z.string()),
  /**
   * An instruction put in front of every text run's system prompt, or null.
   *
   * For a CLI whose tools cannot be switched off by flag. Antigravity's agent
   * sees 57 tools whatever it is told on the command line (spike §3); the
   * runner's `strict` permission denies every one of them, and since 1.2.8 a
   * denied tool ends the run at once. The high-reasoning Gemini models, asked
   * something they could check on a machine, reached for `run_command` and
   * answered nothing (measured 2026-09-23). The denial is the safety; this is
   * what stops the attempt, by telling the model what it is before it plans.
   *
   * Never used by the image path, whose one job is to call a tool.
   *
   * Required and without a default, like the other keys of this block: every
   * adapter honours it, so a provider that should not have one says null.
   */
  system_preamble: z.string().min(1).nullable(),
  // The flag that names the model to the CLI: `<model_flag> <cli_model>`.
  // Required, with no default on purpose: a configuration file written before
  // these keys existed — the hand-edited copy in /etc on the host — would
  // otherwise inherit a default and silently change the command line the CLI
  // receives. Without a default it fails `npm run check-config`, which the
  // runbook requires before every restart, and says which key is missing.
  model_flag: z.string().min(1),
  // The flag that carries the effort, or null when the CLI has none
  // (Antigravity encodes it in the model id through effort_suffix). Null is a
  // declared value here, never an omitted key.
  effort_flag: z.string().min(1).nullable(),
  // When set, the effort argument is `<effort_key>="<value>"` instead of the
  // bare value: Codex takes it as a configuration override, -c
  // model_reasoning_effort="high", not as a flag of its own.
  effort_key: z.string().min(1).nullable(),
  // The key the system prompt travels under, or null when the CLI takes no
  // system prompt at all and it is prepended to the user prompt. min(1) for
  // the same reason as the flags above: an empty string parses, and the
  // adapter then builds `-c ="<text>"` — unparsable TOML, which kills every
  // run carrying a system prompt — or a bare empty argument.
  system_prompt_flag: z.string().min(1).nullable(),
  // The flag that introduces the system prompt override, or null when
  // `system_prompt_flag` is passed as a bare flag followed by the text
  // (Claude: `--system-prompt <text>`). Set, the argument becomes
  // `<prefix> <system_prompt_flag>="<text>"`: Codex takes the override as a
  // configuration assignment, `-c developer_instructions="..."`, so the flag
  // that carries it is part of the CLI's shape and belongs here. Required and
  // without a default like the three flag keys above: a default of null would
  // drop Codex's `-c` from a configuration file written before this key
  // existed and pass the override as a bare argument the CLI never sees.
  system_prompt_flag_prefix: z.string().min(1).nullable(),
  prompt_via: z.literal("stdin"),
  image: ImageSchema,
  // For a CLI that keeps every conversation in its home with no option not to
  // (Antigravity): the command, run as the runner after each run has ended,
  // with the conversation id as its last argument, that removes what the run
  // left. Absent for a CLI told by flag not to keep anything.
  forget: z.array(z.string().min(1)).min(1).optional(),
  // How the CLI is handed the images a request carries. `flag`: one flag per
  // image, naming the file the runner wrote into the sandbox (Codex's
  // --image). `stdin_args`: the arguments that switch the prompt to a
  // structured message the adapter writes the images into (Claude Code's
  // --input-format stream-json). Absent: the CLI takes text only, and a request
  // with images is refused rather than answered without them.
  attachments: z.union([
    z.object({ flag: z.string().min(1) }).strict(),
    z.object({ stdin_args: z.array(z.string().min(1)).min(1) }).strict(),
  ]).optional(),
}).strict();

// A seat of a council: a family and the chain of models to try for it, best
// first. min(1) on the chain because a seat with nothing to seat is not a seat
// at all, and the failure would otherwise only show at deliberation time.
const SeatSchema = z.object({
  family: z.string().min(1),
  models: z.array(z.string().min(1)).min(1),
}).strict()
  // A chain that names a model twice is a typo every time: the second entry is
  // unreachable, since a model the state refused on the first pass is refused
  // on the second too, and a seat stepping down mid-flight must never land
  // back on the model that has just refused it. The duplicate check further
  // down is about two *seats* sharing a model, which is a different mistake.
  .refine((s) => new Set(s.models).size === s.models.length, "a seat must not repeat a model in its chain");

// One council. The file is snake_case like the rest of the configuration, and
// the transform hands the code the names it uses (src/council/types.ts), so a
// setting is never spelled two ways in two places. The defaults are the
// design's: a judge seated apart (§12.3) and blind, two members at the very
// least (§12.5). `stage_timeout_s` is per member and per stage, not for the
// whole deliberation, which runs nine calls across three subscriptions.
//
// `ranking` is the one thing that changes the *sequence* of stages, which is
// why it is a flag here and not a second strategy in the code: with false the
// peer ranking does not run, and a four-seat council costs five calls instead
// of nine (the `-fast` shape). It defaults to true, so a council that says
// nothing is the panel of §12.1 exactly as before.
const CouncilSchema = z.object({
  seats: z.array(SeatSchema),
  judge: SeatSchema,
  judge_allow_member: z.boolean().default(false),
  judge_blind: z.boolean().default(true),
  min_members: z.number().int().default(2),
  ranking: z.boolean().default(true),
  stage_timeout_s: z.number().int().min(1).default(300),
}).strict().transform((c): CouncilConfig => ({
  seats: c.seats,
  judge: c.judge,
  judgeAllowMember: c.judge_allow_member,
  judgeBlind: c.judge_blind,
  minMembers: c.min_members,
  ranking: c.ranking,
  stageTimeoutS: c.stage_timeout_s,
}));

// What this host serves, when it is less than the repository declares. A list
// names what is in, so a provider or a council added to the repository later
// stays out of a host that wrote one until the host names it too; with no list
// everything is served. The lists replace the repository's whole in the merge
// (mergeConfig), which is what makes them closed.
const ServeSchema = z.object({
  providers: z.array(z.string().min(1)).min(1).optional(),
  councils: z.array(z.string().min(1)).optional(),
}).strict();

const ConfigObject = z
  .object({
    server: z
      .object({
        port: z.number().int().default(8080),
        // Where the gateway listens. Loopback by default: behind a Cloudflare
        // tunnel, or a reverse proxy on the same host, nothing else should
        // reach the port. Another address serves a network directly, with the
        // gateway's own keys as the only door (docs/deploy.md, "Without
        // Cloudflare"); the service refuses to start on one while it would be
        // open — no Access and no key issued yet.
        host: z.string().min(1).default("127.0.0.1"),
        // OAuth for the MCP clients that cannot hold a key, such as Claude on
        // the web (src/server/oauth.ts). `public_url` is the address those
        // clients reach this gateway at, over HTTPS: the issuer, with /mcp as
        // the one resource its tokens are for. Absent, there is no OAuth.
        // The operator's page under /ui (src/server/ui.ts). Off unless asked for:
      // it holds nothing by itself, but a gateway that never wanted a page
      // should not serve one.
      ui: z.object({ enabled: z.boolean().default(false) }).strict().default({}),
      oauth: z.object({
          public_url: z.string().url().refine((u) => {
            const url = new URL(u);
            const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
            return (url.protocol === "https:" || local) && (url.pathname === "/" || url.pathname === "") && !url.search && !url.hash;
          }, "server.oauth.public_url must be an https origin with no path, query or fragment (https://api.example.com)"),
        }).strict().optional(),
        access: z.object({
          team_domain: z.string().default(""), audience: z.string().default(""),
          /**
           * What to call each service token in the usage table, by its client
           * id. Cloudflare's service-token JWT carries `common_name`, and what
           * it holds is the **client id** (`<32 hex>.access`), not the name
           * typed in the dashboard — that name never leaves the dashboard. So
           * `/v1/usage` grouped two applications correctly and named neither,
           * which is most of what per-application tokens are for.
           *
           * Host-specific by nature, so the overlay sets it and the repository
           * leaves it empty. A client id is the public half of the pair and no
           * more secret than an email address, which is what sits in the same
           * column for a user token.
           */
          callers: z.record(z.string().min(1), z.string().min(1)).default({}),
          /**
           * Who may use `/v1/admin`: caller names as `callerOf` derives them —
           * an email from Access, a service token's name once it is bound, a
           * key's own name. Host-specific, so the overlay sets it. Empty means
           * the admin API answers 403 to everyone, and the keys CLI is the way
           * in (docs/deploy.md §8).
           */
          admins: z.array(z.string().min(1)).default([]),
        }).strict().default({}),
        queue: z.object({ max_wait_s: z.number().int().min(1).default(120) }).strict().default({}),
        // What the host uses with no CLI running — the gateway, the tunnel,
        // the runner's resident services — in MB. 0 = not declared, and the
        // startup check then counts the CLIs alone (design §4.1).
        memory_mb: z.number().int().min(0).default(0),
        // How often the providers that declare `discover` are asked for their
        // models. The listing is free (no quota), a day is what a retirement
        // announced weeks ahead needs, and startup runs one as well.
        discovery_interval_h: z.number().int().min(1).default(24),
        // How often every provider gets its health probe, a real call on its
        // health_model. An hour by default. Longer spends less of a small
        // plan's allowance, at a price: a provider a request marked signed out
        // or down stays marked so until the next probe says otherwise, so
        // there is no "startup only".
        health_interval_s: z.number().int().min(60).default(3600),
        // Optional: where a change in the catalog is announced, as one plain
        // text POST. Any endpoint that takes one works — an ntfy topic is the
        // documented example (docs/deploy.md §7.2). The token, when there is
        // one, is read from the environment variable named here and never
        // written in a file the repository or the overlay holds.
        notify: z.object({
          url: z.string().url(),
          token_env: z.string().min(1).optional(),
          // Which installation is speaking, written at the start of every
          // message, so two installations on one topic are told apart. In the
          // text and not the title: the body is UTF-8, a header ASCII only.
          name: z.string().min(1).max(80).optional(),
        }).strict().optional(),
      })
      .strict()
      .default({}),
    runner: z.object({
      // null disables sudo on purpose (a developer machine); "" would do the
      // same silently, running the CLIs as the gateway user with its own
      // environment, so it is a value the schema has to reject.
      user: z.string().min(1).nullable().default(null),
      sandbox_root: z.string().min(1),
      kill_grace_s: z.number().int().min(1).default(5),
    }).strict(),
    usage: z.object({ db_path: z.string().default("capitoline.sqlite") }).strict().default({}),
    // The conversations kept for the Responses API and the MCP ask_model tool
    // (src/conversations/store.ts): a file of its own, apart from the usage
    // database, because it is the one place the gateway keeps what people
    // wrote. A thread lives ttl_days after its last turn; the two caps bound a
    // replayed history, which no request body limit sees because the gateway
    // assembles it itself.
    conversations: z.object({
      db_path: z.string().default("conversations.sqlite"),
      ttl_days: z.number().int().min(1).default(30),
      max_turns: z.number().int().min(1).default(100),
      max_bytes: z.number().int().min(1024).default(2_000_000),
    }).strict().default({}),
    providers: z.record(z.string().min(1), ProviderSchema),
    // Virtual models, keyed by the name a client asks for in `model`. Empty by
    // default: a gateway with no council is the phase-1 gateway, unchanged.
    council: z.record(z.string().min(1), CouncilSchema).default({}),
    serve: ServeSchema.optional(),
  })
  .strict();
type RawConfig = z.infer<typeof ConfigObject>;

interface Issue { path: (string | number)[]; message: string }

/**
 * The configuration this host serves: `serve` applied. The providers left out
 * are gone, and so are the councils left out. A council that stays loses the
 * models of the providers left out from its chains, and a seat whose whole
 * chain was on them loses the seat. What remains is checked like any
 * configuration, so the rest of the code never sees what this host does not
 * serve: no health call, no listing, no version check, no model in /v1/models.
 *
 * A council that trimming leaves with fewer than two seats, or with no judge,
 * is refused rather than dropped: dropping it would turn a client's request
 * for it into a 404 that nobody decided. The message says which list to edit.
 */
function served(raw: RawConfig): { config: RawConfig; issues: Issue[] } {
  const serve = raw.serve;
  const issues: Issue[] = [];
  if (!serve) return { config: raw, issues };
  serve.providers?.forEach((id, i) => {
    if (!Object.hasOwn(raw.providers, id)) issues.push({ path: ["serve", "providers", i], message: `serve.providers names "${id}", which is not a provider of the configuration` });
  });
  serve.councils?.forEach((name, i) => {
    if (!Object.hasOwn(raw.council, name)) issues.push({ path: ["serve", "councils", i], message: `serve.councils names "${name}", which is not a council of the configuration` });
  });
  const providers = serve.providers
    ? Object.fromEntries(Object.entries(raw.providers).filter(([id]) => serve.providers!.includes(id)))
    : raw.providers;
  // Every model of every provider declared, served or not, so a model of a
  // provider left out is told apart from a typo, which the checks still report.
  const owner = new Map<string, string>();
  for (const [id, p] of Object.entries(raw.providers)) for (const m of Object.keys(p.models)) owner.set(m, id);
  const kept = (m: string): boolean => {
    const id = owner.get(m);
    return id === undefined || Object.hasOwn(providers, id);
  };
  const council: RawConfig["council"] = {};
  for (const [name, c] of Object.entries(raw.council)) {
    if (serve.councils && !serve.councils.includes(name)) continue;
    const seats = c.seats.map((s) => ({ ...s, models: s.models.filter(kept) })).filter((s) => s.models.length > 0);
    const judge = { ...c.judge, models: c.judge.models.filter(kept) };
    const trimmed = seats.length !== c.seats.length || judge.models.length !== c.judge.models.length;
    if (trimmed && (seats.length < 2 || judge.models.length === 0)) {
      issues.push({ path: ["serve", "councils"], message: `council "${name}" keeps ${seats.length} seat(s) and ${judge.models.length > 0 ? "a" : "no"} judge with the providers this host serves (${Object.keys(providers).join(", ")}): name the councils to serve in serve.councils, without it` });
      continue;
    }
    council[name] = { ...c, seats, judge };
  }
  return { config: { ...raw, providers, council }, issues };
}

export const ConfigSchema = ConfigObject
  .superRefine((raw, ctx) => {
    const { config: cfg, issues } = served(raw);
    for (const i of issues) ctx.addIssue({ code: "custom", ...i });
    // Access is on or off as a pair: with only team_domain the gateway would
    // verify against an empty audience and reject every token with a 401
    // that says nothing about the configuration.
    const { team_domain, audience } = cfg.server.access;
    if (!!team_domain !== !!audience) {
      ctx.addIssue({ code: "custom", path: ["server", "access", team_domain ? "audience" : "team_domain"], message: "server.access.team_domain and server.access.audience must be set together (both empty disables Access verification)" });
    }
    // A gateway with no provider starts happily and answers 404 to every
    // request, with nothing pointing at the configuration as the cause.
    if (Object.keys(cfg.providers).length === 0) {
      ctx.addIssue({ code: "custom", path: ["providers"], message: "providers must declare at least one provider" });
    }
    const seen = new Map<string, string>();
    for (const [id, p] of Object.entries(cfg.providers)) {
      // The gateway owns this namespace on both sides of a model entry, not
      // only on the name: a virtual model is listed with `provider:
      // "capitoline"` (core's VIRTUAL_PROVIDER), so a provider carrying that id
      // would stand on /health beside model entries that claim the same owner,
      // with its pause and its health indistinguishable at a glance from the
      // council's own — which has neither.
      if (id.startsWith("capitoline")) {
        ctx.addIssue({ code: "custom", path: ["providers", id], message: `provider id "${id}" is reserved for the council` });
      }
      // `in` would accept an inherited key such as "toString".
      if (!Object.hasOwn(p.models, p.health_model)) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "health_model"], message: `health_model "${p.health_model}" is not one of provider ${id}'s models` });
      } else if (p.models[p.health_model].kind !== "text") {
        // The health check is a chat request; an image model would burn image quota and fail.
        ctx.addIssue({ code: "custom", path: ["providers", id, "health_model"], message: `health_model "${p.health_model}" must be a text model` });
      }
      // The two system-prompt keys are one setting: the prefix exists only to
      // introduce `<system_prompt_flag>="<text>"`, so with no flag to name
      // there is nothing for it to carry. It would be dropped in silence and
      // the system prompt would go back to being prepended to the user
      // prompt, while the file says it travels as a configuration override.
      for (const f of p.health_fallback) {
        if (!Object.hasOwn(p.models, f) || p.models[f].kind !== "text") {
          ctx.addIssue({ code: "custom", path: ["providers", id, "health_fallback"], message: `health_fallback "${f}" is not one of provider ${id}'s text models` });
        }
      }
      if (p.discover && p.discover.prefix.startsWith("capitoline")) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "discover", "prefix"], message: `discover.prefix "${p.discover.prefix}" is reserved for the council` });
      }
      if (p.system_prompt_flag_prefix !== null && p.system_prompt_flag === null) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "system_prompt_flag_prefix"], message: `provider ${id} sets system_prompt_flag_prefix but no system_prompt_flag for it to introduce` });
      }
      if (Object.values(p.models).some((m) => m.kind === "image") && !p.image.collect) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "image", "collect"], message: `provider ${id} has image models but no image.collect command` });
      }
      for (const [name, m] of Object.entries(p.models)) {
        // Every effort a model offers must have a value in the provider's
        // effort table, otherwise the flag is silently dropped at runtime.
        for (const e of m.efforts ?? []) {
          if (!Object.hasOwn(p.effort, e)) {
            ctx.addIssue({ code: "custom", path: ["providers", id, "models", name, "efforts"], message: `model "${name}" declares effort "${e}", which provider ${id}'s effort table does not define` });
          }
        }
        // The other direction: a model that needs an effort value at all, with
        // nothing in the table to take it from. effortValue() returns null and
        // the flag, or the "-<effort>" suffix that completes the model id, is
        // dropped at runtime instead of failing here.
        if (Object.keys(p.effort).length === 0 && (m.effort_suffix || m.efforts)) {
          ctx.addIssue({ code: "custom", path: ["providers", id, "effort"], message: `model "${name}" needs an effort value but provider ${id}'s effort table is empty` });
        }
        if (name.startsWith("capitoline")) {
          ctx.addIssue({ code: "custom", path: ["providers", id, "models", name], message: `model name "${name}" is reserved for the council` });
        }
        const other = seen.get(name);
        if (other) ctx.addIssue({ code: "custom", path: ["providers", id, "models", name], message: `duplicate model name "${name}" (also in ${other})` });
        seen.set(name, id);
      }
    }
    // How many seats each provider serves in each council: filled in below and
    // checked once every council has been read, since one provider is seated
    // by more than one of them.
    const seatsOf = new Map<string, Map<string, number>>();
    // The councils, once every provider model is known. Everything checked
    // here is a mistake that would otherwise surface only in the middle of a
    // deliberation, nine calls deep, as a seat nobody could fill.
    for (const [name, c] of Object.entries(cfg.council)) {
      // A council is asked for in the same `model` field as every other model,
      // so a name held by both would route to one of them and never the other.
      const provider = seen.get(name);
      if (provider) {
        ctx.addIssue({ code: "custom", path: ["council", name], message: `council name "${name}" is also a model of provider ${provider}` });
      }
      // Two seats is the floor for the same reason min_members is: there is
      // nothing to rank or synthesize below two answers (design §12.5).
      if (c.seats.length < 2) {
        ctx.addIssue({ code: "custom", path: ["council", name, "seats"], message: `council "${name}" must declare at least two seats, not ${c.seats.length}` });
      }
      // The floor holds with `ranking: false` too: below two answers there is
      // nothing to synthesize either, and the deliberation would return the
      // single answer it has and declare no council (§12.5).
      if (c.minMembers < 2) {
        ctx.addIssue({ code: "custom", path: ["council", name, "min_members"], message: `council "${name}" sets min_members ${c.minMembers}: below two answers there is nothing to rank or synthesize` });
      }
      // A quorum larger than the panel can never be met, not even with every
      // seat answering: every deliberation would spend its calls and end in
      // the "fewer than min_members" branch, with no council at all.
      if (c.minMembers > c.seats.length) {
        ctx.addIssue({ code: "custom", path: ["council", name, "min_members"], message: `council "${name}" sets min_members ${c.minMembers} but declares only ${c.seats.length} seats, so the quorum can never be met` });
      }
      // One seat per family is what buys independent judgment: models of one
      // lineage share their blind spots, so they fail the same way and rank
      // each other's failures highly (design §12.2). The same model reachable
      // from two seats is the same opinion voting twice, for the same reason.
      const families = new Map<string, number>();
      const seated = new Map<string, number>();
      c.seats.forEach((s, i) => {
        const family = families.get(s.family);
        if (family !== undefined) {
          ctx.addIssue({ code: "custom", path: ["council", name, "seats", i, "family"], message: `council "${name}" seats family "${s.family}" twice (seats ${family} and ${i}): one lineage would hold two votes` });
        } else families.set(s.family, i);
        for (const m of s.models) {
          const other = seated.get(m);
          if (other !== undefined && other !== i) {
            ctx.addIssue({ code: "custom", path: ["council", name, "seats", i, "models"], message: `council "${name}" seats "${m}" in two chains (seats ${other} and ${i}): one model would answer twice` });
          } else seated.set(m, i);
        }
      });
      // Every model of every chain, named against the providers. A chain is
      // written by hand and read only when a fallback happens, so a typo in it
      // can sit unnoticed until the day it is needed.
      const chain = (seat: { family: string; models: string[] }, path: (string | number)[]): void => {
        for (const m of seat.models) {
          // A Map, not the models object: `in` would accept "toString".
          const pid = seen.get(m);
          if (pid === undefined) {
            ctx.addIssue({ code: "custom", path, message: `council "${name}" seats "${m}" for family ${seat.family}, which no provider declares` });
            continue;
          }
          // A deliberation is a chat request, and an image model refuses one
          // with bad_request, which no fallback retries: the seat would be
          // lost mid-deliberation. Same reason health_model must be text.
          if (cfg.providers[pid].models[m].kind !== "text") {
            ctx.addIssue({ code: "custom", path, message: `council "${name}" seats "${m}" for family ${seat.family}, which is not a text model` });
          }
        }
      };
      c.seats.forEach((s, i) => chain(s, ["council", name, "seats", i, "models"]));
      chain(c.judge, ["council", name, "judge", "models"]);
      // The members answer, and (unless `ranking` is off) later rank, in
      // parallel, so every provider must offer one concurrency slot per seat
      // it serves (design §12.1) whatever the shape: a
      // family is not a provider, and the default panel puts Google and open
      // weights on the same Antigravity subscription. The judge is not
      // counted: it is seated alone, after the members are done.
      for (const s of c.seats) {
        // A chain can span providers (`claude-opus` and `antigravity-claude-opus`), and
        // any of them may end up serving the seat, so each needs the slot.
        const providers = new Set(s.models.map((m) => seen.get(m)).filter((pid): pid is string => pid !== undefined));
        for (const pid of providers) {
          const per = seatsOf.get(pid) ?? new Map<string, number>();
          per.set(name, (per.get(name) ?? 0) + 1);
          seatsOf.set(pid, per);
        }
      }
    }
    // One council at a time, and deliberately not the sum over all of them.
    // The seats of a single council start in the same instant, so a provider
    // with fewer slots than that council's seats loses a member to its own
    // queue after server.queue.max_wait_s in every deliberation, in both
    // parallel stages — eight of the nine calls spent to discover a setting.
    // That is a property of the file, and only the file can fix it.
    //
    // Two councils sharing a provider is a different thing. They contend only
    // while two deliberations overlap, which is load, and load is what the
    // queue and max_wait_s answer. Summing the councils would make the slots
    // grow with the number of names declared — the reference panel, the fast
    // one and the Gemini ladder would ask this one Antigravity subscription
    // for seven parallel `agy` processes, a number nobody has measured — and,
    // since the gateway validates at startup, would leave a configuration the
    // service cannot restart with under Restart=always. The sum would also
    // have to count the judges, which do run beside another council's members
    // and which no council counts against itself.
    for (const [pid, per] of seatsOf) {
      const slots = cfg.providers[pid].concurrency;
      // The largest council: the one deliberation these slots must hold alone.
      const [council, seats] = [...per].reduce((a, b) => (b[1] > a[1] ? b : a));
      if (slots >= seats) continue;
      ctx.addIssue({ code: "custom", path: ["providers", pid, "concurrency"], message: `provider ${pid} serves ${seats} seats of council "${council}" with concurrency ${slots}: a member would wait on its own subscription's queue and lose its seat in every parallel stage the council runs (design §12.1)` });
    }
  })
  .transform((raw) => served(raw).config);

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = Config["providers"][string];
export type ModelConfig = ProviderConfig["models"][string];

/** `source` names the files the value came from, and is empty for a single one. */
function validate(value: unknown, source: string): Config {
  const result = ConfigSchema.safeParse(value);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration${source}:\n${lines.join("\n")}`);
  }
  return result.data;
}

export function parseConfig(text: string): Config {
  return validate(parse(text), "");
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Deep merge of a host overlay over the repository configuration, before the
 * schema sees either. The rules, one line each, because the host writes the
 * overlay by hand and has to be able to predict the result:
 *
 * - two objects merge key by key, recursively: an overlay naming one binary
 *   leaves the rest of that provider alone;
 * - anything else in the overlay replaces the base's value entirely. An array
 *   is one value, never a concatenation: `args` is a whole command line, and a
 *   host that changes a flag needs the base's list gone, not extended;
 * - `null` is a value, not a deletion. `effort_flag: null` and `runner.user:
 *   null` are declared values of this schema, so an overlay must be able to
 *   set them, and no key can be removed — there is nothing a host would remove
 *   that it could not instead set.
 *
 * The base is not modified: it stays what the repository file parsed to.
 */
export function mergeConfig(base: unknown, overlay: unknown): unknown {
  if (!isPlain(base) || !isPlain(overlay)) return overlay;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // defineProperty, not assignment: a key literally named "__proto__" in the
    // overlay would otherwise reach the setter and change the prototype of
    // every object in the process, instead of becoming an unknown key that the
    // strict schema rejects by name a few lines below.
    Object.defineProperty(out, key, { value: mergeConfig(out[key], value), writable: true, enumerable: true, configurable: true });
  }
  return out;
}

/** The dotted path of every value the overlay sets; an array is one leaf. */
function leafKeys(value: unknown, prefix = ""): string[] {
  if (!isPlain(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([k, v]) => leafKeys(v, prefix ? `${prefix}.${k}` : k));
}

export interface LoadedConfig {
  config: Config;
  /** The keys the overlay set, for the startup log — keys, never values. */
  overlayKeys: string[];
}

/**
 * The configuration, plus what the overlay contributed.
 *
 * With no overlay path this is exactly what it has always been: one file, one
 * validation. That path has to stay, because the deployed host runs a full
 * hand-made copy of the configuration until its runbook step is applied.
 *
 * With one, both files are parsed, the overlay is merged over the base and the
 * result is validated once by the same strict schema — so a key the overlay
 * mistypes is rejected by name, and a key added upstream arrives with the pull
 * that carries it instead of being retyped on the host.
 *
 * A missing overlay file is an error, never a silent skip: naming a file that
 * is not there is a mistake, and skipping it would start the gateway on the
 * repository's own paths, sandboxes, database and user.
 */
export function loadConfigWithOverlay(path: string, overlayPath?: string): LoadedConfig {
  const base = parse(readFileSync(path, "utf8"));
  if (overlayPath === undefined) return { config: validate(base, ""), overlayKeys: [] };
  let text: string;
  try {
    text = readFileSync(overlayPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read the configuration overlay ${overlayPath}: ${(e as Error).message}`, { cause: e });
  }
  const overlay = parse(text);
  // An overlay that is not a mapping never reaches the schema. By the merge
  // rules anything that is not an object replaces the base whole, so an empty
  // file — the operator who creates /etc/capitoline/overlay.yaml and fills it
  // afterwards, a write cut short — would throw the entire configuration away
  // and be reported as `: Invalid input: expected object, received null`, with
  // no key and no file name. Named here instead.
  if (!isPlain(overlay)) {
    const why = overlay === null || overlay === undefined ? "is empty" : "must be a mapping of configuration keys";
    throw new Error(`the configuration overlay ${overlayPath} ${why}`);
  }
  // Both file names in the message: the key the schema rejects is in one of
  // the two, and the reader has to know which file to open.
  return { config: validate(mergeConfig(base, overlay), ` (${path} + ${overlayPath})`), overlayKeys: leafKeys(overlay) };
}

export function loadConfig(path: string, overlayPath?: string): Config {
  return loadConfigWithOverlay(path, overlayPath).config;
}
