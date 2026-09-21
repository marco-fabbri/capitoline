import type { Effort } from "../config.js";
export type { Effort };

export type Role = "system" | "user" | "assistant";
export interface Message { role: Role; text: string }
export interface Attachment { mime: string; bytes: Buffer }
export interface InternalRequest {
  model: string;
  messages: Message[];
  effort?: Effort;
  attachments?: Attachment[];
  stream: boolean;
}

// An image generation: one prompt, one image back. Size is not a parameter
// (the CLI tool has none); the response reports the real dimensions.
export interface ImageRequest { model: string; prompt: string }

export type ErrorKind = "auth_expired" | "rate_limited" | "timeout" | "cli_crashed" | "bad_output";
export interface RateLimitWindow { utilization: number; resetsAt: number }
export interface Usage { input: number; output: number }
export type ImageMime = "image/jpeg" | "image/png";

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "done"; usage?: Usage }
  // retryAfterS: an explicit wait the CLI reported (quota reset); absent when unknown.
  // scope: what the refusal is about. Absent means the provider, which is the
  // safe reading — a subscription-wide limit must stop every model behind it.
  // "model" is set only when the CLI attributed the refusal to the model that
  // was asked for (Claude's per-model limits, real capture 2026-09-21): pausing
  // the provider would then take down models that still answer.
  | { type: "error"; kind: ErrorKind; detail: string; retryAfterS?: number; scope?: "model" }
  | { type: "rate_limit"; fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow }
  | { type: "image"; mime: ImageMime; bytes: Buffer; width: number; height: number };

// What an adapter's parse() may yield: the provider events plus adapter-internal
// ones (conversation id, tool steps). A Provider only ever yields ProviderEvent,
// so the compiler forces every provider to consume meta/tool before forwarding.
export type AdapterEvent =
  | ProviderEvent
  | { type: "meta"; conversationId: string }
  | { type: "tool"; phase: "call" | "done" | "error"; name: string; raw: string };

export type FailureKind = ErrorKind | "unknown_model" | "model_unavailable" | "queue_full" | "bad_request" | "unauthorized";

export class CapitolineError extends Error {
  readonly kind: FailureKind;
  readonly retryAfterS?: number;
  constructor(kind: FailureKind, message: string, retryAfterS?: number) {
    super(message);
    this.name = "CapitolineError";
    this.kind = kind;
    this.retryAfterS = retryAfterS;
  }
}
