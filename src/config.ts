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
});

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
  .default({});

const ProviderSchema = z.object({
  binary: z.string().min(1),
  concurrency: z.number().int().min(1),
  timeout_s: z.number().int().min(1),
  budget: z.object({ window_5h_tokens: z.number().int().min(0), window_7d_tokens: z.number().int().min(0) }),
  health_model: z.string().min(1),
  models: z.record(z.string().min(1), ModelSchema),
  effort: z.record(EffortSchema, z.string()),
  args: z.array(z.string()),
  system_prompt_flag: z.string().nullable(),
  prompt_via: z.literal("stdin"),
  image: ImageSchema,
});

export const ConfigSchema = z
  .object({
    server: z
      .object({
        port: z.number().int().default(8080),
        access: z.object({ team_domain: z.string().default(""), audience: z.string().default("") }).default({}),
        queue: z.object({ max_wait_s: z.number().int().min(1).default(120) }).default({}),
      })
      .default({}),
    runner: z.object({
      user: z.string().nullable().default(null),
      sandbox_root: z.string().min(1),
      kill_grace_s: z.number().int().min(1).default(5),
    }),
    usage: z.object({ db_path: z.string().default("capitoline.sqlite") }).default({}),
    providers: z.record(z.string().min(1), ProviderSchema),
  })
  .superRefine((cfg, ctx) => {
    // Access is on or off as a pair: with only team_domain the gateway would
    // verify against an empty audience and reject every token with a 401
    // that says nothing about the configuration.
    const { team_domain, audience } = cfg.server.access;
    if (!!team_domain !== !!audience) {
      ctx.addIssue({ code: "custom", path: ["server", "access", team_domain ? "audience" : "team_domain"], message: "server.access.team_domain and server.access.audience must be set together (both empty disables Access verification)" });
    }
    const seen = new Map<string, string>();
    for (const [id, p] of Object.entries(cfg.providers)) {
      if (!(p.health_model in p.models)) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "health_model"], message: `health_model "${p.health_model}" is not one of provider ${id}'s models` });
      } else if (p.models[p.health_model].kind !== "text") {
        // The health check is a chat request; an image model would burn image quota and fail.
        ctx.addIssue({ code: "custom", path: ["providers", id, "health_model"], message: `health_model "${p.health_model}" must be a text model` });
      }
      if (Object.values(p.models).some((m) => m.kind === "image") && !p.image.collect) {
        ctx.addIssue({ code: "custom", path: ["providers", id, "image", "collect"], message: `provider ${id} has image models but no image.collect command` });
      }
      for (const name of Object.keys(p.models)) {
        if (name === "capitoline" || name.startsWith("capitoline-")) {
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

export function parseConfig(text: string): Config {
  const result = ConfigSchema.safeParse(parse(text));
  if (!result.success) {
    const lines = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, "utf8"));
}
