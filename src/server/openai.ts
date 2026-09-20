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

// Fields the gateway honors. Everything else in the body is either a feature we
// cannot provide (REJECT, 400 when actually requested) or a tuning knob we
// silently drop and report in X-Capitoline-Ignored (spec 6.1: "ignore with a
// warning"), including keys we have never heard of.
const HONORED = new Set(["model", "messages", "stream", "reasoning_effort", "n"]);
const REJECT = ["tools", "tool_choice", "functions", "function_call", "logprobs", "top_logprobs", "response_format"];

// A REJECT field only counts as requested when its value asks for the feature:
// logprobs:false, tools:[], tool_choice:"none"/"auto" and response_format
// {type:"text"} are the gateway's own defaults, and clients send them routinely.
function requested(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v === "none" || v === "auto") return false;
  if (typeof v === "object" && (v as { type?: unknown }).type === "text") return false;
  return true;
}

export interface Converted { req: InternalRequest; ignored: string[] }

export function convertChatRequest(body: unknown): Converted {
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw new CapitolineError("bad_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  const b = parsed.data as Record<string, unknown> & z.infer<typeof Body>;
  for (const f of REJECT) if (f in b && requested(b[f])) throw new CapitolineError("bad_request", `"${f}" is not supported by this gateway`);
  if ("n" in b && b.n !== undefined && b.n !== null && b.n !== 1) throw new CapitolineError("bad_request", `"n" must be 1`);
  const ignored = Object.keys(b).filter((f) => !HONORED.has(f) && !REJECT.includes(f) && b[f] !== undefined && b[f] !== null);

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
    // A request that hit an expired login is a server-side failure worth
    // retrying later; a model already known to be unavailable is simply not
    // offered (it is missing from /v1/models too), so spec 6.1/8.3 say 404.
    case "auth_expired": return { status: 503, retryAfterS: 300 };
    case "model_unavailable": return { status: 404 };
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
