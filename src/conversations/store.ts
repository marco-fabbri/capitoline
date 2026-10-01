import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Message } from "../core/types.js";

/**
 * The conversations the gateway remembers: each turn's input and output, by
 * response id, so a client can continue from a turn instead of resending the
 * whole history (the Responses API's previous_response_id, and the MCP
 * ask_model tool's `conversation`).
 *
 * The state lives here and never in a CLI: a turn is replayed as text through
 * the same stateless path as any request, and the runner keeps its empty
 * directory and its disabled sessions. It is the first place the gateway keeps
 * what people wrote, which is why it is a file of its own, apart from the usage
 * database: usage can be kept, backed up and shared without any of it. The file
 * is created readable by the service alone.
 *
 * Images are not kept. They reach the CLI in the turn they came with; a later
 * turn sees a line saying one was there. That keeps binary data out of a file
 * that lives for weeks, and keeps a turn's size its text.
 *
 * A thread — the turns that descend from one first turn — is the unit of
 * expiry: it lives `ttl_days` after it was last used, and a turn of an expired
 * thread is as absent as one that never existed.
 */
export interface StoredTurn {
  id: string;
  threadId: string;
  previousId: string | null;
  owner: string;
  model: string;
  cliModelId: string | null;
  input: Message[];
  output: string;
  inputTokens: number;
  outputTokens: number;
  bytes: number;
  createdAt: number;
}

export interface NewTurn {
  id: string;
  previousId: string | null;
  owner: string;
  model: string;
  cliModelId?: string;
  input: Message[];
  output: string;
  inputTokens?: number;
  outputTokens?: number;
}

const DAY_MS = 86_400_000;
// A chain is walked turn by turn; this bounds the walk whatever max_turns says,
// so a corrupted previous_id loop cannot spin.
const WALK_LIMIT = 10_000;

interface Row {
  id: string; thread_id: string; previous_id: string | null; owner: string; model: string; cli_model_id: string | null;
  input_json: string; output_text: string; input_tokens: number; output_tokens: number; bytes: number; created_at: number;
}

export class ConversationStore {
  private db: DatabaseSync;
  private closed = false;
  private stmts: Record<"turn" | "thread" | "insertThread" | "insertTurn" | "touch" | "deleteThread" | "deleteThreadTurns" | "expiredThreads", StatementSync>;

  constructor(path: string, private ttlDays: number) {
    if (path !== ":memory:" && path !== "") {
      mkdirSync(dirname(path), { recursive: true });
      // Created owner-only before sqlite opens it: what people wrote is in here.
      if (!existsSync(path)) closeSync(openSync(path, "a", 0o600));
      chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS threads_last_used ON threads(last_used_at);
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, previous_id TEXT, owner TEXT NOT NULL, model TEXT NOT NULL,
        cli_model_id TEXT, input_json TEXT NOT NULL, output_text TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_thread ON turns(thread_id);
    `);
    this.stmts = {
      turn: this.db.prepare(`SELECT * FROM turns WHERE id = ? AND owner = ?`),
      thread: this.db.prepare(`SELECT last_used_at FROM threads WHERE id = ?`),
      insertThread: this.db.prepare(`INSERT INTO threads (id, owner, created_at, last_used_at) VALUES (?, ?, ?, ?)`),
      insertTurn: this.db.prepare(`INSERT INTO turns (id, thread_id, previous_id, owner, model, cli_model_id, input_json, output_text, input_tokens, output_tokens, bytes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      touch: this.db.prepare(`UPDATE threads SET last_used_at = ? WHERE id = ?`),
      deleteThread: this.db.prepare(`DELETE FROM threads WHERE id = ?`),
      deleteThreadTurns: this.db.prepare(`DELETE FROM turns WHERE thread_id = ?`),
      expiredThreads: this.db.prepare(`SELECT id FROM threads WHERE last_used_at < ?`),
    };
  }

  private live(threadId: string, now: number): boolean {
    const t = this.stmts.thread.get(threadId) as { last_used_at: number } | undefined;
    return t !== undefined && t.last_used_at >= now - this.ttlDays * DAY_MS;
  }

  private toTurn(r: Row): StoredTurn {
    return {
      id: r.id, threadId: r.thread_id, previousId: r.previous_id, owner: r.owner, model: r.model, cliModelId: r.cli_model_id,
      input: JSON.parse(r.input_json) as Message[], output: r.output_text, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
      bytes: r.bytes, createdAt: r.created_at,
    };
  }

  /** One turn of the owner's, or null when it is someone else's, expired, or never was. */
  get(id: string, owner: string, now = Date.now()): StoredTurn | null {
    const r = this.stmts.turn.get(id, owner) as Row | undefined;
    if (!r || !this.live(r.thread_id, now)) return null;
    return this.toTurn(r);
  }

  /** The turns from the first one to `id`, oldest first; null as for get(). */
  chain(id: string, owner: string, now = Date.now()): StoredTurn[] | null {
    const last = this.get(id, owner, now);
    if (!last) return null;
    const turns = [last];
    let prev = last.previousId;
    while (prev !== null && turns.length < WALK_LIMIT) {
      const r = this.stmts.turn.get(prev, owner) as Row | undefined;
      if (!r) break; // the chain was cut by a delete: what remains is still the history
      turns.push(this.toTurn(r));
      prev = r.previous_id;
    }
    return turns.reverse();
  }

  /**
   * Records a turn. A first turn opens a thread under its own id; a following
   * one joins its predecessor's thread and keeps it alive. Expired threads are
   * dropped on the way, as the OAuth tokens are: a store that only grows when
   * written to only needs cleaning when written to.
   */
  save(t: NewTurn, now = Date.now()): StoredTurn {
    let threadId = t.id;
    if (t.previousId !== null) {
      const prev = this.get(t.previousId, t.owner, now);
      if (!prev) throw new Error(`no live turn ${t.previousId} for this owner`);
      threadId = prev.threadId;
    }
    const inputJson = JSON.stringify(t.input);
    const bytes = Buffer.byteLength(inputJson) + Buffer.byteLength(t.output);
    this.db.exec("BEGIN");
    try {
      if (t.previousId === null) this.stmts.insertThread.run(threadId, t.owner, now, now);
      else this.stmts.touch.run(now, threadId);
      this.stmts.insertTurn.run(t.id, threadId, t.previousId, t.owner, t.model, t.cliModelId ?? null, inputJson, t.output,
        t.inputTokens ?? 0, t.outputTokens ?? 0, bytes, now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.prune(now);
    return this.get(t.id, t.owner, now)!;
  }

  /** Deletes the thread `id` belongs to, every turn of it. False when the owner has no such turn. */
  deleteThread(id: string, owner: string, now = Date.now()): boolean {
    const turn = this.get(id, owner, now);
    if (!turn) return false;
    this.dropThread(turn.threadId);
    return true;
  }

  private dropThread(threadId: string): void {
    this.db.exec("BEGIN");
    try {
      this.stmts.deleteThreadTurns.run(threadId);
      this.stmts.deleteThread.run(threadId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Drops the threads unused for longer than ttl_days; returns how many. */
  prune(now = Date.now()): number {
    const expired = this.stmts.expiredThreads.all(now - this.ttlDays * DAY_MS) as { id: string }[];
    for (const { id } of expired) this.dropThread(id);
    return expired.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
