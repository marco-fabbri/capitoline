import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

// The test harness's own guarantee, pinned so it cannot be lost. A test server
// that bound every interface could be handed a port another program on the
// machine holds on 127.0.0.1, and a connection to 127.0.0.1 then reached that
// program instead: Tailscale's local API answered a test with 401 on
// 2026-09-23 (test/setup/http-diagnostics.ts has the whole account).
describe("test servers", () => {
  it("bind loopback when supertest starts them, and answer from the app under test", async () => {
    // The server's own bound address, read from inside the request: a server
    // on every interface reports "::", one on loopback "127.0.0.1".
    const app = express().get("/where", (req, res) => {
      const server = (req.socket as unknown as { server: http.Server }).server;
      res.json({ bound: (server.address() as AddressInfo).address, me: "the app under test" });
    });
    const r = await request(app).get("/where");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ bound: "127.0.0.1", me: "the app under test" });
  });

  it("leave alone a server the test has already bound", async () => {
    const s = http.createServer(express().get("/ok", (_req, res) => { res.send("ok"); })).listen(0, "127.0.0.1");
    await once(s, "listening");
    const r = await request(s).get("/ok");
    expect(r.text).toBe("ok");
    s.close();
  });
});
