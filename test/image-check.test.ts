import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectImage } from "../src/providers/image-check.js";

const execFileP = promisify(execFile);
const FAKE = join(process.cwd(), "test/fake-cli/fake-cli.mjs");
const COLLECT = join(process.cwd(), "test/fake-cli/fake-collect-image.sh");
const SAMPLE = join(process.cwd(), "test/fixtures/images/sample.jpg");
const TINY = join(process.cwd(), "test/fixtures/images/tiny.png");
const UUID = "40fc1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

// Minimal JPEG (SOI, SOF0 WxH, EOI) built by hand for the edge cases.
function jpegWithSof(width: number, height: number, sof = 0xc0): Buffer {
  const sofSeg = Buffer.from([0xff, sof, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sofSeg, Buffer.from([0xff, 0xd9])]);
}

describe("inspectImage", () => {
  it("reads the dimensions of the committed sample JPEG (1376x768)", () => {
    const buf = readFileSync(SAMPLE);
    expect(buf.length).toBeGreaterThanOrEqual(250_000);
    expect(inspectImage(buf, { minBytes: 200_000 })).toEqual({
      ok: true,
      info: { mime: "image/jpeg", width: 1376, height: 768, bytes: buf.length },
    });
  });

  it("reads the dimensions of a PNG from its IHDR", () => {
    const buf = readFileSync(TINY);
    expect(inspectImage(buf, { minBytes: 0 })).toEqual({
      ok: true,
      info: { mime: "image/png", width: 4, height: 2, bytes: buf.length },
    });
  });

  it("rejects a valid image below minBytes", () => {
    const buf = readFileSync(TINY);
    expect(inspectImage(buf, { minBytes: 200_000 })).toEqual({ ok: false, reason: `too small: ${buf.length} bytes < 200000` });
  });

  it("rejects garbage, whatever its size", () => {
    expect(inspectImage(Buffer.from("not an image at all"), { minBytes: 0 })).toEqual({ ok: false, reason: "not a JPEG or PNG" });
    // The signature is checked before the size: garbage is reported as garbage, not as "too small".
    expect(inspectImage(Buffer.alloc(300_000, 0x41), { minBytes: 200_000 })).toEqual({ ok: false, reason: "not a JPEG or PNG" });
    expect(inspectImage(Buffer.alloc(0), { minBytes: 0 })).toEqual({ ok: false, reason: "not a JPEG or PNG" });
  });

  it("walks JPEG markers past APP segments and accepts progressive SOF2", () => {
    const app1 = Buffer.from([0xff, 0xe1, 0x00, 0x04, 0x41, 0x42]);
    const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, jpegWithSof(640, 480, 0xc2).subarray(2)]);
    expect(inspectImage(buf, { minBytes: 0 })).toEqual({ ok: true, info: { mime: "image/jpeg", width: 640, height: 480, bytes: buf.length } });
  });

  it("reports unreadable dimensions for a truncated or SOF-less JPEG", () => {
    // SOI then EOI: no frame header at all.
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { minBytes: 0 })).toEqual({ ok: false, reason: "unreadable dimensions" });
    // SOI then an APP0 whose declared length runs past the end of the buffer.
    expect(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x00, 0x4a]), { minBytes: 0 })).toEqual({ ok: false, reason: "unreadable dimensions" });
    // Zero-sized frame.
    expect(inspectImage(jpegWithSof(0, 0), { minBytes: 0 })).toEqual({ ok: false, reason: "unreadable dimensions" });
  });

  it("reports unreadable dimensions for a PNG whose first chunk is not IHDR", () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const bogus = Buffer.concat([sig, Buffer.from([0, 0, 0, 13]), Buffer.from("tEXt"), Buffer.alloc(17)]);
    expect(inspectImage(bogus, { minBytes: 0 })).toEqual({ ok: false, reason: "unreadable dimensions" });
    expect(inspectImage(sig, { minBytes: 0 })).toEqual({ ok: false, reason: "unreadable dimensions" });
  });
});

describe("fake-cli write-image", () => {
  it("writes a JPEG that inspects as 1376x768 with the requested filler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "capitoline-img-"));
    const out = join(dir, "img.jpg");
    // The fake drains stdin before acting: close it, or it waits for EOF forever.
    const run = execFileP(process.execPath, [FAKE, "--mode", "write-image", "--out", out, "--bytes", "1000"]);
    run.child.stdin?.end();
    await run;
    const buf = readFileSync(out);
    const v = inspectImage(buf, { minBytes: 0 });
    expect(v).toEqual({ ok: true, info: { mime: "image/jpeg", width: 1376, height: 768, bytes: buf.length } });
    expect(buf.length).toBeGreaterThan(1000);
    expect(buf.length).toBeLessThan(1200);
    expect(buf.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });
});

describe("fake-collect-image.sh", () => {
  it("prints the sample JPEG by default", async () => {
    const { stdout } = await execFileP(COLLECT, [UUID], { encoding: "buffer", maxBuffer: 20 * 1024 * 1024 });
    expect(stdout.equals(readFileSync(SAMPLE))).toBe(true);
    expect(stdout.length).toBe(statSync(SAMPLE).size);
  });

  it("prints tiny.png with FAKE_COLLECT=tiny", async () => {
    const { stdout } = await execFileP(COLLECT, [UUID], { encoding: "buffer", env: { ...process.env, FAKE_COLLECT: "tiny" } });
    expect(stdout.equals(readFileSync(TINY))).toBe(true);
  });

  it("exits 4 with no output under FAKE_COLLECT=none", async () => {
    await expect(execFileP(COLLECT, [UUID], { env: { ...process.env, FAKE_COLLECT: "none" } })).rejects.toMatchObject({ code: 4, stdout: "" });
  });

  it("exits 2 on a malformed conversation id, like the real helper", async () => {
    await expect(execFileP(COLLECT, ["../etc"])).rejects.toMatchObject({ code: 2, stdout: "" });
  });
});
