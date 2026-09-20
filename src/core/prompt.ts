import type { Effort } from "../config.js";
import type { Message } from "./types.js";

export function splitSystem(messages: Message[]): { system: string | null; rest: Message[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.text);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: system.length ? system.join("\n\n") : null, rest };
}

const LABEL: Record<Exclude<Message["role"], "system">, string> = { user: "User", assistant: "Assistant" };

export function flatten(rest: Message[]): string {
  if (rest.length === 1 && rest[0].role === "user") return rest[0].text;
  return rest.map((m) => `${LABEL[m.role as "user" | "assistant"]}: ${m.text}`).join("\n\n");
}

const ORDER: Effort[] = ["low", "medium", "high"];

export function nearestEffort(wanted: Effort, allowed: Effort[]): Effort {
  if (allowed.includes(wanted)) return wanted;
  const w = ORDER.indexOf(wanted);
  let best: Effort = allowed[0];
  let bestDist = Infinity;
  for (const a of allowed) {
    const d = Math.abs(ORDER.indexOf(a) - w);
    if (d < bestDist || (d === bestDist && ORDER.indexOf(a) > ORDER.indexOf(best))) { best = a; bestDist = d; }
  }
  return best;
}
