// Test-only diagnostics for intermittent network failures in the suite.
//
// One test has failed about once in twenty or thirty full runs, under a
// different name each time and never with its file run alone. The one time
// the failure was caught, Node's HTTP client had received bytes that were not
// an HTTP response ("Parse Error: Expected HTTP/, RTSP/ or ICE/"). Two
// explanations written down before were wrong (docs/backlog.md § Tests), so
// this file records what actually happens instead of fixing a guess:
//
//   - every parse error an HTTP client meets, with the bytes it received and
//     both ends of the socket;
//   - every server any test process starts, with its address and port, which
//     is what can show two processes holding one port at the same moment.
//
// The recording observes and does not handle: the error reaches the test
// unchanged. The one thing this file changes is where supertest's servers
// bind, at the end: the fix the recording led to. The recording stays in the
// suite, because it costs nothing while
// nothing fails and the next intermittent failure then arrives with its
// evidence attached. Written to tmp/, which git ignores.
import { appendFileSync, mkdirSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import supertest from "supertest";
import { expect } from "vitest";

const DIR = join(process.cwd(), "tmp");
const FILE = join(DIR, "http-diagnostics.jsonl");
mkdirSync(DIR, { recursive: true });

// Which test is running, when there is one: a server started in a beforeAll,
// or a socket event that lands between tests, has only the file.
function where(): { file?: string; test?: string } {
  try {
    const s = expect.getState();
    return { file: s.testPath?.split("/test/").at(-1), test: s.currentTestName };
  } catch {
    return {};
  }
}

function record(entry: Record<string, unknown>): void {
  try {
    appendFileSync(FILE, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...where(), ...entry }) + "\n");
  } catch {
    // A diagnostic that fails must never become the failure.
  }
}

// Every parse error a client sees. `rawPacket` is what Node attaches to it:
// the bytes it could not read as a response, which is the whole question.
type ParseError = NodeJS.ErrnoException & { rawPacket?: Buffer; bytesParsed?: number };
const clientEmit = http.ClientRequest.prototype.emit;
http.ClientRequest.prototype.emit = function (this: http.ClientRequest, event: string | symbol, ...args: unknown[]): boolean {
  if (event === "error") {
    const err = args[0] as ParseError | undefined;
    if (typeof err?.code === "string" && err.code.startsWith("HPE_")) {
      const raw = err.rawPacket;
      record({
        kind: "parse-error",
        code: err.code,
        message: err.message,
        bytesParsed: err.bytesParsed,
        preview: raw ? raw.subarray(0, 400).toString("utf8").replace(/[^\x20-\x7e\n]/g, ".") : null,
        base64: raw ? raw.subarray(0, 4096).toString("base64") : null,
        request: { method: this.method, path: this.path, host: this.getHeader("host") },
        socket: this.socket
          ? { local: `${this.socket.localAddress}:${this.socket.localPort}`, remote: `${this.socket.remoteAddress}:${this.socket.remotePort}` }
          : null,
      });
    }
  }
  return (clientEmit as (this: http.ClientRequest, event: string | symbol, ...args: unknown[]) => boolean).call(this, event, ...args);
} as typeof http.ClientRequest.prototype.emit;

// Every server a test process starts, recorded once it is actually bound:
// the address and family say whether it holds the port on every interface or
// on one.
const serverListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  this.once("listening", () => {
    const a = this.address();
    if (a && typeof a === "object") record({ kind: "listen", address: a.address, family: a.family, port: a.port });
  });
  return (serverListen as (this: net.Server, ...args: unknown[]) => net.Server).apply(this, args);
} as typeof net.Server.prototype.listen;

// supertest's servers bind loopback. This is the fix the recording led to.
//
// The cause, found 2026-09-23: supertest starts each app with `app.listen(0)`
// and no host, which binds every interface, then connects to 127.0.0.1.
// macOS lets a server on every interface take a port that another program
// holds on 127.0.0.1 alone, and a connection to 127.0.0.1 then goes to that
// more specific listener. On the owner's Mac one of them is Tailscale's local
// API: the captured failure was a test that got `401 auth required` from
// Tailscale on 127.0.0.1:49557, and the earlier parse error a local service
// that does not speak HTTP. It happened only when the random port coincided,
// once in twenty-odd runs, under whatever test was running.
//
// A server bound to 127.0.0.1 cannot be handed a port another program holds
// there: the bind conflicts and the kernel picks another. But a listen that
// names a host is asynchronous (Node resolves the host first), and supertest
// reads the port in its constructor, synchronously. So the URL is fixed later,
// in end(), once the server is listening; end() is what superagent's then()
// and supertest's own expect(..., fn) both go through. A test that passes a
// server it has already bound is left alone. This reaches into supertest's
// internals (serverAddress, end, _server): if a new version renames them,
// test/harness.test.ts fails and says so.
const LOOPBACK = "127.0.0.1";
type Pending = { _server?: net.Server; _loopback?: { ready: Promise<unknown>; path: string }; url: string };
const TestProto = (supertest as unknown as { Test: { prototype: Record<string, unknown> } }).Test.prototype;
const serverAddress = TestProto.serverAddress as (this: Pending, app: net.Server, path: string) => string;
TestProto.serverAddress = function (this: Pending, app: net.Server, path: string): string {
  if (app.address()) return serverAddress.call(this, app, path);
  this._server = app.listen(0, LOOPBACK);
  this._loopback = { ready: once(this._server, "listening"), path };
  return `http://${LOOPBACK}:0${path}`; // replaced in end(), before anything is sent
};
const testEnd = TestProto.end as (this: Pending, fn?: (err: unknown, res?: unknown) => void) => unknown;
TestProto.end = function (this: Pending, fn?: (err: unknown, res?: unknown) => void): unknown {
  const pending = this._loopback;
  if (!pending) return testEnd.call(this, fn);
  this._loopback = undefined;
  pending.ready.then(
    () => {
      this.url = `http://${LOOPBACK}:${(this._server!.address() as net.AddressInfo).port}${pending.path}`;
      testEnd.call(this, fn);
    },
    (err: unknown) => fn?.(err),
  );
  return this;
};
