import { defineConfig } from "vitest/config";

// The JSON report is for the flaky failure recorded in docs/backlog.md § Tests.
// It has struck three times, each time as a single failure under a different
// test name, and twice the one piece of evidence that could explain it — the
// failure's own message — was lost because only a summary line was read. The
// report keeps every run's full outcome on disk, so the next occurrence can be
// read after the fact whatever was looked at during the run.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15000,
    reporters: ["default", "json"],
    outputFile: { json: "tmp/vitest-last-run.json" },
  },
});
