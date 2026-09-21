import type { Effort } from "../config.js";
import type { Message } from "./types.js";

export function splitSystem(messages: Message[]): { system: string | null; rest: Message[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.text);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: system.length ? system.join("\n\n") : null, rest };
}

const LABEL: Record<Exclude<Message["role"], "system">, string> = { user: "User", assistant: "Assistant" };

/**
 * The conversation as one prompt string. Every adapter calls `splitSystem`
 * first and passes its `rest` here, so a system message reaching this function
 * is a bug in the caller, not a bad request: the transport layers only ever
 * produce the three roles and `splitSystem` removes this one. It used to be
 * routed around with a cast, which made the bug render as the literal text
 * "undefined: <the system prompt>" inside the user's prompt — silently, and in
 * the one place where a leaked instruction is most likely to be obeyed. It now
 * throws instead, which the server answers as an internal error with nothing
 * of the message in the body.
 */
export function flatten(rest: Message[]): string {
  if (rest.length === 1 && rest[0].role === "user") return rest[0].text;
  return rest.map((m) => {
    if (m.role === "system") throw new Error("flatten() received a system message: splitSystem() must remove it first");
    return `${LABEL[m.role]}: ${m.text}`;
  }).join("\n\n");
}

const ORDER: Effort[] = ["low", "medium", "high"];

/**
 * The allowed level nearest to the one asked for, ties broken towards the
 * higher one (the reasoning is written out above `effortValue` in
 * `src/providers/adapter.ts`, which is this function's only caller).
 *
 * Both inputs are checked rather than approximated. An empty `allowed` array
 * returned `allowed[0]`, that is `undefined`, behind an `Effort` return type,
 * and would have reached the CLI as an empty `--effort ` argument; an unknown
 * `wanted` scored `-1` in `ORDER` and so resolved to the *lowest* allowed
 * level, a silent downgrade of every such request. Neither can be produced by
 * a client — the HTTP and MCP layers validate `reasoning_effort` against the
 * same three levels, and `effortValue` returns null before calling this when
 * the intersection is empty — so both are caller bugs and are reported as
 * such.
 */
export function nearestEffort(wanted: Effort, allowed: Effort[]): Effort {
  if (allowed.length === 0) throw new Error("nearestEffort() needs at least one allowed effort");
  const w = ORDER.indexOf(wanted);
  if (w < 0) throw new Error(`nearestEffort(): unknown effort "${wanted}" (known: ${ORDER.join(", ")})`);
  if (allowed.includes(wanted)) return wanted;
  let best: Effort = allowed[0];
  let bestDist = Infinity;
  for (const a of allowed) {
    const d = Math.abs(ORDER.indexOf(a) - w);
    if (d < bestDist || (d === bestDist && ORDER.indexOf(a) > ORDER.indexOf(best))) { best = a; bestDist = d; }
  }
  return best;
}
