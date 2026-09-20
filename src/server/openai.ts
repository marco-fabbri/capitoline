import { z } from "zod";
import { CapitolineError, type Attachment, type ErrorKind, type InternalRequest, type Message, type Usage } from "../core/types.js";
import { EffortSchema } from "../config.js";

const Part = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
]);
const Msg = z.object({ role: z.enum(["system", "user", "assistant", "developer"]), content: z.union([z.string(), z.array(Part), z.null()]).default("") });
const Body = z.object({
  model: z.string().min(1),
  messages: z.array(Msg).min(1, "messages must not be empty"),
  stream: z.boolean().default(false),
  reasoning_effort: EffortSchema.optional(),
}).passthrough();

const REJECT = ["tools", "tool_choice", "functions", "function_call", "logprobs", "top_logprobs", "response_format"];
const IGNORE = ["temperature", "top_p", "max_tokens", "max_completion_tokens", "presence_penalty", "frequency_penalty", "stop", "seed", "user"];

export interface Converted { req: InternalRequest; ignored: string[] }

export function convertChatRequest(body: unknown): Converted {
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw new CapitolineError("bad_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  const b = parsed.data as Record<string, unknown> & z.infer<typeof Body>;
  for (const f of REJECT) if (f in b && b[f] !== undefined && b[f] !== null) throw new CapitolineError("bad_request", `"${f}" is not supported by this gateway`);
  if ("n" in b && b.n !== undefined && b.n !== 1) throw new CapitolineError("bad_request", `"n" must be 1`);
  const ignored = IGNORE.filter((f) => f in b && b[f] !== undefined && b[f] !== null);

  const messages: Message[] = [];
  const attachments: Attachment[] = [];
  for (const m of b.messages) {
    const role = m.role === "developer" ? "system" : m.role;
    if (typeof m.content === "string" || m.content === null) { messages.push({ role, text: m.content ?? "" }); continue; }
    const texts: string[] = [];
    for (const part of m.content) {
      if (part.type === "text") texts.push(part.text);
      else {
        const mt = /^data:([^;,]+);base64,(.+)$/s.exec(part.image_url.url);
        if (!mt) throw new CapitolineError("bad_request", "image_url must be a base64 data URL");
        attachments.push({ mime: mt[1], bytes: Buffer.from(mt[2], "base64") });
      }
    }
    messages.push({ role, text: texts.join("\n") });
  }
  return { req: { model: b.model, messages, effort: b.reasoning_effort, attachments: attachments.length ? attachments : undefined, stream: b.stream }, ignored };
}

export function httpStatus(e: CapitolineError | ErrorKind): { status: number; retryAfterS?: number } {
  const kind = typeof e === "string" ? e : e.kind;
  const retry = typeof e === "string" ? undefined : e.retryAfterS;
  switch (kind) {
    case "bad_request": return { status: 400 };
    case "unauthorized": return { status: 401 };
    case "unknown_model": return { status: 404 };
    case "rate_limited": return { status: 429, retryAfterS: retry ?? 60 };
    case "queue_full": return { status: 503, retryAfterS: retry ?? 30 };
    case "auth_expired": case "model_unavailable": return { status: 503, retryAfterS: 300 };
    case "timeout": return { status: 504 };
    default: return { status: 502 };
  }
}

export function usageBlock(u?: Usage) {
  return { prompt_tokens: u?.input ?? 0, completion_tokens: u?.output ?? 0, total_tokens: (u?.input ?? 0) + (u?.output ?? 0) };
}

export function completionResponse(model: string, text: string, usage: Usage | undefined, extra: Record<string, unknown>) {
  return {
    id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: usageBlock(usage), capitoline: extra,
  };
}

export function sseChunk(model: string, id: string, delta: { role?: "assistant"; content?: string }, finish: "stop" | null, usage?: Usage): string {
  const chunk: Record<string, unknown> = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish }] };
  if (finish) chunk.usage = usageBlock(usage);
  return `data: ${JSON.stringify(chunk)}\n\n`;
}
