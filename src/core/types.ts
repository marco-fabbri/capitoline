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

export type ErrorKind = "auth_expired" | "rate_limited" | "timeout" | "cli_crashed" | "bad_output";
export interface RateLimitWindow { utilization: number; resetsAt: number }
export interface Usage { input: number; output: number }

export type ProviderEvent =
  | { type: "text"; delta: string }
  | { type: "done"; usage?: Usage }
  | { type: "error"; kind: ErrorKind; detail: string }
  | { type: "rate_limit"; fiveHour?: RateLimitWindow; sevenDay?: RateLimitWindow };

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
