#!/usr/bin/env node
// Fake CLI for tests. Behavior chosen by FAKE_MODE (env) or --mode <m> (arg).
//   replay <file>  : read all stdin, then print the file line by line
//   stdin-len      : read all stdin, print {"stdin_length": N}
//   slow           : print 5 JSON lines, one every 200 ms
//   hang           : read stdin, then sleep forever (ignores SIGTERM for 10 s)
//   crash          : print "boom" to stderr, exit 2
//   secret-stderr  : print a fake secret to stderr, then exit 0 with no stdout
//   cwd            : print {"cwd": process.cwd(), "files": [...]}
//   big-stderr     : write ~200 KiB to stderr (last line is "END"), exit 0
import { readFileSync, readdirSync } from "node:fs";
const argv = process.argv.slice(2);
const modeIdx = argv.indexOf("--mode");
const mode = modeIdx >= 0 ? argv[modeIdx + 1] : process.env.FAKE_MODE ?? "stdin-len";
const fileIdx = argv.indexOf("--file");
const file = fileIdx >= 0 ? argv[fileIdx + 1] : process.env.FAKE_FILE;

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
  default:
    process.stderr.write(`unknown mode ${mode}\n`);
    process.exit(3);
}
