import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const EffortSchema = z.enum(["low", "medium", "high"]);
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

const ProviderSchema = z.object({
  binary: z.string().min(1),
  concurrency: z.number().int().min(1),
  timeout_s: z.number().int().min(1),
  budget: z.object({ window_5h_tokens: z.number().int().min(0), window_7d_tokens: z.number().int().min(0) }).strict(),
  health_model: z.string().min(1),
  models: z.record(z.string().min(1), ModelSchema),
  // min(1) on the value: an empty string parses, and the flag then reaches
  // the CLI as `--effort ""` or as a model id ending in "-".
  effort: z.record(EffortSchema, z.string().min(1)),
  args: z.array(z.string()),
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
}).strict();

export const ConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().default(8080),
        access: z.object({ team_domain: z.string().default(""), audience: z.string().default("") }).strict().default({}),
        queue: z.object({ max_wait_s: z.number().int().min(1).default(120) }).strict().default({}),
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
    providers: z.record(z.string().min(1), ProviderSchema),
  })
  .strict()
  .superRefine((cfg, ctx) => {
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
  });

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
  // Both file names in the message: the key the schema rejects is in one of
  // the two, and the reader has to know which file to open.
  return { config: validate(mergeConfig(base, overlay), ` (${path} + ${overlayPath})`), overlayKeys: leafKeys(overlay) };
}

export function loadConfig(path: string, overlayPath?: string): Config {
  return loadConfigWithOverlay(path, overlayPath).config;
}
