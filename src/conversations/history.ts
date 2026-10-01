import { CapitolineError, type Message } from "../core/types.js";
import type { StoredTurn } from "./store.js";

/**
 * How a stored conversation becomes the messages of the next request, one set
 * of rules for the Responses API and for the MCP ask_model tool.
 */
export interface ConversationLimits { maxTurns: number; maxBytes: number }

// Claude Code takes the system prompt as one command-line argument and Codex as
// a -c value, and Linux caps one argument at about 128 KiB (MAX_ARG_STRLEN): an
// instruction past it would make the spawn fail rather than the request.
export const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

/** The turns as messages: each turn's input, then its answer. */
export function historyMessages(chain: StoredTurn[]): Message[] {
  return chain.flatMap((t) => [...t.input, { role: "assistant" as const, text: t.output }]);
}

/**
 * The part of the chain that fits beside a new turn of `newBytes`.
 *
 * "disabled", the Responses API's default, refuses a conversation over its
 * limits, so a client learns it rather than receiving an answer to a history it
 * did not send; "auto" drops the oldest turns until it fits, which is what a
 * client that never sees the limits (an MCP tool call) needs.
 */
export function fitChain(chain: StoredTurn[], newBytes: number, limits: ConversationLimits, truncation: "auto" | "disabled"): StoredTurn[] {
  const over = (c: StoredTurn[]) => c.length + 1 > limits.maxTurns || c.reduce((s, t) => s + t.bytes, 0) + newBytes > limits.maxBytes;
  if (!over(chain)) return chain;
  if (truncation === "disabled") {
    throw new CapitolineError("bad_request", `the conversation is over its limit (${limits.maxTurns} turns, ${limits.maxBytes} bytes): start a new one, or ask for truncation "auto" to drop its oldest turns`);
  }
  let kept = chain;
  while (kept.length > 0 && over(kept)) kept = kept.slice(1);
  if (over(kept)) throw new CapitolineError("bad_request", `this turn alone is over the conversation limit of ${limits.maxBytes} bytes`);
  return kept;
}

/** This turn's input as it is kept: the text, and a line where images were. */
export function storedInput(messages: Message[], images: number): Message[] {
  if (images === 0) return messages;
  const note = images === 1 ? "(an image was attached here)" : `(${images} images were attached here)`;
  const out = messages.map((m) => ({ ...m }));
  const lastUser = out.map((m) => m.role).lastIndexOf("user");
  if (lastUser >= 0) out[lastUser].text = out[lastUser].text ? `${out[lastUser].text}\n${note}` : note;
  else out.push({ role: "user", text: note });
  return out;
}

/** The size a turn will have once stored, before it is: its input text. */
export function inputBytes(messages: Message[]): number {
  return Buffer.byteLength(JSON.stringify(messages));
}
