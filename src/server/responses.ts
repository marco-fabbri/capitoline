import { z } from "zod";
import { decodeBase64 } from "../core/attachments.js";
import { CapitolineError, type Attachment, type Effort, type Message, type Usage } from "../core/types.js";
import { MAX_INSTRUCTIONS_BYTES } from "../conversations/history.js";

/**
 * The Responses API (POST /v1/responses), the subset this gateway serves: a
 * text answer from one model, with the conversation optionally kept on the
 * server (previous_response_id, store). The shapes follow the official OpenAI
 * SDK's types, so a client written for OpenAI reads them unchanged; what the
 * gateway cannot do is refused by name, as on the chat endpoint.
 */
const InputText = z.object({ type: z.enum(["input_text", "output_text", "text"]), text: z.string() });
const InputImage = z.object({ type: z.literal("input_image"), image_url: z.string().optional(), detail: z.string().optional(), file_id: z.string().optional() });
const Item = z.object({
  type: z.literal("message").optional(),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(z.union([InputText, InputImage]))]),
});
const Body = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(Item).min(1, "input must not be empty")]),
  instructions: z.string().nullish(),
  previous_response_id: z.string().min(1).nullish(),
  store: z.boolean().default(true),
  stream: z.boolean().default(false),
  reasoning: z.object({ effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).nullish() }).passthrough().nullish(),
  truncation: z.enum(["auto", "disabled"]).nullish(),
}).passthrough();

const HONORED = new Set(["model", "input", "instructions", "previous_response_id", "store", "stream", "reasoning", "truncation", "metadata"]);
const REJECT = ["tools", "tool_choice", "include", "background", "conversation", "prompt", "text"];

// A REJECT field counts only when its value asks for the feature: an empty
// tools list, tool_choice "none"/"auto", background false, an empty include and
// text.format {type: "text"} are what clients send by default.
function requested(name: string, v: unknown): boolean {
  if (v === undefined || v === null || v === false) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v === "none" || v === "auto") return false;
  if (name === "text" && typeof v === "object") {
    const format = (v as { format?: { type?: unknown } }).format;
    return format !== undefined && format !== null && format.type !== "text";
  }
  return true;
}

export interface ResponsesRequest {
  model: string;
  /** This turn's messages, system ones included. */
  input: Message[];
  attachments: Attachment[];
  instructions?: string;
  previousId?: string;
  store: boolean;
  stream: boolean;
  effort?: Effort;
  truncation: "auto" | "disabled";
  ignored: string[];
}

// The Responses API's names onto the gateway's, which Core then fits to what
// each model offers (nearestEffort): "minimal" has no rung below low here.
const EFFORT: Record<string, Effort> = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh" };

export function convertResponsesRequest(body: unknown): ResponsesRequest {
  const parsed = Body.safeParse(body);
  if (!parsed.success) throw new CapitolineError("bad_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  const b = parsed.data as Record<string, unknown> & z.infer<typeof Body>;
  for (const f of REJECT) if (f in b && requested(f, b[f])) throw new CapitolineError("bad_request", `"${f}" is not supported by this gateway`);
  const ignored = Object.keys(b).filter((f) => !HONORED.has(f) && !REJECT.includes(f) && b[f] !== undefined && b[f] !== null);
  if (b.instructions && Buffer.byteLength(b.instructions) > MAX_INSTRUCTIONS_BYTES) {
    throw new CapitolineError("bad_request", `instructions are limited to ${MAX_INSTRUCTIONS_BYTES} bytes`);
  }

  const input: Message[] = [];
  const attachments: Attachment[] = [];
  if (typeof b.input === "string") input.push({ role: "user", text: b.input });
  else for (const item of b.input) {
    const role = item.role === "developer" ? "system" : item.role;
    if (typeof item.content === "string") { input.push({ role, text: item.content }); continue; }
    const texts: string[] = [];
    for (const part of item.content) {
      if (part.type !== "input_image") { texts.push(part.text); continue; }
      const mt = part.image_url ? /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/s.exec(part.image_url) : null;
      const bytes = mt ? decodeBase64(mt[2]) : null;
      if (!mt || !bytes) throw new CapitolineError("bad_request", "input_image must carry image_url as a base64 data URL");
      attachments.push({ mime: mt[1], bytes });
    }
    input.push({ role, text: texts.join("\n") });
  }
  const effortName = b.reasoning?.effort ?? undefined;
  return {
    model: b.model, input, attachments,
    ...(b.instructions ? { instructions: b.instructions } : {}),
    ...(b.previous_response_id ? { previousId: b.previous_response_id } : {}),
    store: b.store, stream: b.stream,
    ...(effortName ? { effort: EFFORT[effortName] } : {}),
    truncation: b.truncation ?? "disabled",
    ignored,
  };
}

export const newResponseId = () => `resp_${crypto.randomUUID().replace(/-/g, "")}`;
export const newMessageId = () => `msg_${crypto.randomUUID().replace(/-/g, "")}`;

export interface ResponseFields {
  id: string;
  messageId: string;
  model: string;
  createdAt: number;
  status: "in_progress" | "completed" | "failed";
  text: string;
  usage?: Usage;
  previousId?: string;
  instructions?: string;
  store: boolean;
  truncation: "auto" | "disabled";
  error?: { code: string; message: string };
  extra: Record<string, unknown>;
}

function usageObject(u?: Usage) {
  const input = u?.input ?? 0, output = u?.output ?? 0;
  return { input_tokens: input, input_tokens_details: { cached_tokens: 0 }, output_tokens: output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: input + output };
}

function message(f: Pick<ResponseFields, "messageId" | "text">, status: "in_progress" | "completed") {
  return { id: f.messageId, type: "message", role: "assistant", status, content: status === "completed" || f.text ? [outputText(f.text)] : [] };
}

const outputText = (text: string) => ({ type: "output_text", text, annotations: [] as unknown[] });

/** The response object, as the SDK's `Response` type has it. */
export function responseObject(f: ResponseFields) {
  const done = f.status === "completed";
  return {
    id: f.id, object: "response", created_at: Math.floor(f.createdAt / 1000), status: f.status,
    ...(done ? { completed_at: Math.floor(Date.now() / 1000) } : {}),
    model: f.model,
    output: done ? [message(f, "completed")] : [],
    output_text: done ? f.text : "",
    error: f.error ?? null, incomplete_details: null,
    instructions: f.instructions ?? null, metadata: null,
    parallel_tool_calls: false, temperature: null, top_p: null, tool_choice: "none", tools: [],
    previous_response_id: f.previousId ?? null, store: f.store, truncation: f.truncation,
    ...(done ? { usage: usageObject(f.usage) } : {}),
    capitoline: f.extra,
  };
}

/**
 * The typed events of a streamed response. Each carries its own type and a
 * sequence number, and goes out under an `event:` line of the same name, as the
 * official API sends them; a client that reads only the data lines still finds
 * the type there.
 */
export class ResponseEvents {
  private seq = 0;
  constructor(private f: ResponseFields) {}

  private frame(type: string, body: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...body })}\n\n`;
  }

  /** response.created, then the opening of the one message and its one text part. */
  open(): string {
    return this.frame("response.created", { response: responseObject({ ...this.f, status: "in_progress" }) })
      + this.frame("response.in_progress", { response: responseObject({ ...this.f, status: "in_progress" }) })
      + this.frame("response.output_item.added", { output_index: 0, item: message({ messageId: this.f.messageId, text: "" }, "in_progress") })
      + this.frame("response.content_part.added", { item_id: this.f.messageId, output_index: 0, content_index: 0, part: outputText("") });
  }

  delta(text: string): string {
    return this.frame("response.output_text.delta", { item_id: this.f.messageId, output_index: 0, content_index: 0, delta: text, logprobs: [] });
  }

  /** The text's end, the message's, and response.completed with the whole response. */
  complete(done: ResponseFields): string {
    this.f = done;
    return this.frame("response.output_text.done", { item_id: done.messageId, output_index: 0, content_index: 0, text: done.text, logprobs: [] })
      + this.frame("response.content_part.done", { item_id: done.messageId, output_index: 0, content_index: 0, part: outputText(done.text) })
      + this.frame("response.output_item.done", { output_index: 0, item: message(done, "completed") })
      + this.frame("response.completed", { response: responseObject(done) });
  }

  failed(error: { code: string; message: string }): string {
    return this.frame("response.failed", { response: responseObject({ ...this.f, status: "failed", error }) });
  }
}
