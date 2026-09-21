#!/usr/bin/env node
// Fake CLI for tests. Behavior chosen by FAKE_MODE (env) or --mode <m> (arg).
//   replay <file>  : read all stdin, then print the file line by line
//   stdin-len      : read all stdin, print {"stdin_length": N}
//   slow           : print 5 JSON lines, one every 200 ms
//   hang           : read stdin, then sleep forever (ignores SIGTERM for 10 s)
//   replay-linger <file> : like replay, then stay alive 10 s (exits on SIGTERM)
//   crash          : print "boom" to stderr, exit 2
//   secret-stderr  : print a fake secret to stderr, then exit 0 with no stdout
//   cwd            : print {"cwd": process.cwd(), "files": [...]}
//   big-stderr     : write ~200 KiB to stderr (last line is "END"), exit 0
//   emit-bytes --bytes N : write N deterministic pseudo-random bytes to stdout (xorshift32, seed 0x9e3779b9), exit 0
//   write-image --out <path> --bytes N : write a baseline JPEG (1376x768 header, N filler bytes, EOI) to <path>, exit 0
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const modeIdx = argv.indexOf("--mode");
const mode = modeIdx >= 0 ? argv[modeIdx + 1] : process.env.FAKE_MODE ?? "stdin-len";
const fileIdx = argv.indexOf("--file");
const file = fileIdx >= 0 ? argv[fileIdx + 1] : process.env.FAKE_FILE;
const bytesIdx = argv.indexOf("--bytes");
const bytes = bytesIdx >= 0 ? Number(argv[bytesIdx + 1]) : 0;
const outIdx = argv.indexOf("--out");
const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;

// Deterministic so tests can rebuild the expected buffer (same generator in test/runner.test.ts).
function pseudoRandomBytes(n, seed = 0x9e3779b9) {
  const out = Buffer.alloc(n);
  let x = seed >>> 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

// A structurally valid baseline JPEG: SOI, APP0/JFIF, SOF0 1376x768 (3 components, 4:2:0),
// one empty-ish DHT, SOS, then N filler bytes (0xFF avoided: it would start a marker in the
// entropy-coded segment) and EOI. `file` and inspectImage both read it as a 1376x768 JPEG.
function fakeJpeg(fillerBytes) {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x05, 0x60, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const dht = Buffer.concat([Buffer.from([0xff, 0xc4, 0x00, 0x14, 0x00, 0x01]), Buffer.alloc(15), Buffer.from([0x00])]);
  const sos = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00]);
  const filler = pseudoRandomBytes(fillerBytes);
  for (let i = 0; i < filler.length; i++) if (filler[i] === 0xff) filler[i] = 0x00;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app0, sof0, dht, sos, filler, eoi]);
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const input = await readStdin();
switch (mode) {
  case "replay": {
    for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) process.stdout.write(line + "\n");
    break;
  }
  case "stdin-len":
    process.stdout.write(JSON.stringify({ stdin_length: input.length }) + "\n");
    break;
  case "slow":
    for (let i = 0; i < 5; i++) { process.stdout.write(JSON.stringify({ i }) + "\n"); await sleep(200); }
    break;
  case "hang":
    process.on("SIGTERM", () => {});
    await sleep(10_000);
    break;
  case "replay-linger": {
    for (const line of readFileSync(file, "utf8").split("\n")) if (line.trim()) process.stdout.write(line + "\n");
    await sleep(10_000);
    break;
  }
  case "crash":
    process.stderr.write("boom\n");
    process.exit(2);
  case "secret-stderr":
    process.stderr.write("token=sk-should-never-leak\n");
    break;
  case "cwd":
    process.stdout.write(JSON.stringify({ cwd: process.cwd(), files: readdirSync(".") }) + "\n");
    break;
  case "big-stderr": {
    // 20 000 lines of 10 bytes each = ~200 KiB; exit naturally so the pipe is flushed.
    let buf = "";
    for (let i = 0; i < 20_000; i++) buf += String(i).padStart(9, "0") + "\n";
    process.stderr.write(buf + "END\n");
    break;
  }
  case "emit-bytes": {
    // Written in one go and flushed by a natural exit; a large N blocks on the pipe
    // until the parent reads or kills the process.
    process.stdout.write(pseudoRandomBytes(bytes));
    break;
  }
  case "write-image": {
    if (!outPath) { process.stderr.write("write-image needs --out <path>\n"); process.exit(3); }
    writeFileSync(outPath, fakeJpeg(bytes));
    break;
  }
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(3);
}
