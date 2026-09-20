import type { ErrorKind } from "../core/types.js";

// Patterns come from the CLIs' known messages. Real captures from an expired
// token or an exhausted window (spike open item 3) must be added to the tests
// when they happen; until then these are the documented strings.
const AUTH = /login expired|not logged in|unauthori[sz]ed|\b401\b|invalid.*token|expired.*token|authentication (failed|required)|please run \/login|codex login/i;
const RATE = /rate.?limit|\b429\b|too many requests|usage limit|quota|resets? at|capacity/i;

export function classifyError(text: string): ErrorKind {
  if (AUTH.test(text)) return "auth_expired";
  if (RATE.test(text)) return "rate_limited";
  return "cli_crashed";
}
