import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore, type NewTurn } from "../src/conversations/store.js";
import { fitChain, historyMessages, storedInput } from "../src/conversations/history.js";

// The conversation store and the rules a kept history is replayed by
// (src/conversations/): what the Responses API and the MCP ask_model tool
// share, tested apart from either.
const DAY = 86_400_000;
const T0 = 1_790_000_000_000;
const turn = (id: string, previousId: string | null, owner = "app-one", text = id): NewTurn =>
  ({ id, previousId, owner, model: "claude-opus", input: [{ role: "user", text: `q ${text}` }], output: `a ${text}` });

describe("the conversation store", () => {
  it("rebuilds a chain oldest first, and branches from any turn", () => {
    const s = new ConversationStore(":memory:", 30);
    s.save(turn("resp_1", null), T0);
    s.save(turn("resp_2", "resp_1"), T0);
    s.save(turn("resp_3", "resp_2"), T0);
    s.save(turn("resp_2b", "resp_1"), T0);
    expect(s.chain("resp_3", "app-one", T0)?.map((t) => t.id)).toEqual(["resp_1", "resp_2", "resp_3"]);
    expect(s.chain("resp_2b", "app-one", T0)?.map((t) => t.id)).toEqual(["resp_1", "resp_2b"]);
    expect(s.get("resp_2", "app-one", T0)?.threadId).toBe("resp_1");
  });

  it("is the owner's alone: another caller finds nothing and cannot continue it", () => {
    const s = new ConversationStore(":memory:", 30);
    s.save(turn("resp_1", null), T0);
    expect(s.get("resp_1", "app-two", T0)).toBeNull();
    expect(s.chain("resp_1", "app-two", T0)).toBeNull();
    expect(() => s.save(turn("resp_x", "resp_1", "app-two"), T0)).toThrow();
    expect(s.deleteThread("resp_1", "app-two", T0)).toBe(false);
  });

  it("forgets a thread ttl_days after its last turn, and a new turn keeps it alive", () => {
    const s = new ConversationStore(":memory:", 30);
    s.save(turn("resp_1", null), T0);
    s.save(turn("resp_2", "resp_1"), T0 + 20 * DAY);
    expect(s.chain("resp_2", "app-one", T0 + 45 * DAY)?.length).toBe(2);   // last used on day 20
    expect(s.get("resp_1", "app-one", T0 + 51 * DAY)).toBeNull();          // expired, before any prune
    expect(s.prune(T0 + 51 * DAY)).toBe(1);
    expect(s.prune(T0 + 51 * DAY)).toBe(0);
  });

  it("deletes a whole thread from any of its turns", () => {
    const s = new ConversationStore(":memory:", 30);
    s.save(turn("resp_1", null), T0);
    s.save(turn("resp_2", "resp_1"), T0);
    expect(s.deleteThread("resp_2", "app-one", T0)).toBe(true);
    expect(s.get("resp_1", "app-one", T0)).toBeNull();
    expect(s.get("resp_2", "app-one", T0)).toBeNull();
  });

  it("creates its file readable by the service alone", () => {
    const path = join(mkdtempSync(join(tmpdir(), "conversations-")), "sub", "conversations.sqlite");
    const s = new ConversationStore(path, 30);
    s.save(turn("resp_1", null), T0);
    s.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("a kept history, replayed", () => {
  it("is each turn's input followed by its answer", () => {
    const s = new ConversationStore(":memory:", 30);
    s.save(turn("resp_1", null), T0);
    s.save(turn("resp_2", "resp_1"), T0);
    expect(historyMessages(s.chain("resp_2", "app-one", T0)!)).toEqual([
      { role: "user", text: "q resp_1" }, { role: "assistant", text: "a resp_1" },
      { role: "user", text: "q resp_2" }, { role: "assistant", text: "a resp_2" },
    ]);
  });

  it("refuses a history over its limits unless truncation is auto, which drops the oldest turns", () => {
    const s = new ConversationStore(":memory:", 30);
    s.save(turn("resp_1", null), T0);
    s.save(turn("resp_2", "resp_1"), T0);
    const chain = s.chain("resp_2", "app-one", T0)!;
    const limits = { maxTurns: 2, maxBytes: 1_000_000 };
    expect(() => fitChain(chain, 10, limits, "disabled")).toThrow(/over its limit/);
    expect(fitChain(chain, 10, limits, "auto").map((t) => t.id)).toEqual(["resp_2"]);
    expect(() => fitChain([], 2_000, { maxTurns: 10, maxBytes: 1_024 }, "auto")).toThrow(/this turn alone/);
  });

  it("keeps a line where images were, never the images", () => {
    expect(storedInput([{ role: "user", text: "what is this?" }], 1)).toEqual([{ role: "user", text: "what is this?\n(an image was attached here)" }]);
    expect(storedInput([{ role: "user", text: "" }], 2)).toEqual([{ role: "user", text: "(2 images were attached here)" }]);
    const plain = [{ role: "user" as const, text: "hi" }];
    expect(storedInput(plain, 0)).toBe(plain);
  });
});
