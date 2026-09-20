#!/usr/bin/env node
// ONE command for every test script, because "did you run all the tests?" has to
// be answerable with a single line instead of a memory.
//
// WHY THIS EXISTS: the tests are not one suite. They grew one per feature, some
// make REAL LLM calls, some write to the live database (and clean up after
// themselves), and until now each was run individually and only when it felt
// relevant. That is exactly how a regression slips through: when the Coach tab
// was deleted, nothing re-checked that the memory panel still worked, and
// brief-test kept asserting a section title that had been renamed.
//
// So: two tiers. `cheap` is DB-only (plus embeddings) and can be run after every
// change. `llm` costs real model calls, writes real rows, and is run
// deliberately — before a deploy, or when a change touches the model's path.
//
// Run: node scripts/test-all.mjs                       # the cheap tier
//      node scripts/test-all.mjs --tier all            # everything
//      node scripts/test-all.mjs --tier llm            # only the costly ones
//      node scripts/test-all.mjs --only brief          # one file, by substring
//      node scripts/test-all.mjs --verbose             # stream each test's output
//
// A test PASSES when its exit code is 0 and its output contains no "FAIL" line.
// Exit code 1 if anything failed, so this is usable as a gate.
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** tier: "cheap" = no model call, "llm" = makes real completions (costs money). */
const TESTS = [
  { file: "todo-lifecycle-test.ts", tier: "cheap", what: "todo resolution: done work leaves the day, history survives" },
  { file: "search-rank-test.ts", tier: "cheap", what: "search ranking + bilingual query normalisation (position, not presence)" },
  { file: "memory-retrieval-test.ts", tier: "cheap", what: "retrieval: floor, per-topic cap, stale labelling" },
  { file: "youtube-quality-test.ts", tier: "cheap", what: "view-count parsing + the video quality cap (pure)" },
  { file: "memory-test.ts", tier: "llm", what: "commitments ledger, loops lifecycle, capture check" },
  { file: "memory-oneshop-test.ts", tier: "llm", what: "one write path (facts only) + consolidation safety" },
  { file: "review-test.ts", tier: "llm", what: "nightly review: one row per run, it reports and changes nothing" },
  { file: "brief-test.ts", tier: "llm", what: "the brief reports state and changes none of it" },
  { file: "backlog-test.ts", tier: "llm", what: "planning ammunition reaches the model and the tool" },
  { file: "coach-test.ts", tier: "llm", what: "check-in generation + day plan, then restores your rows" },
  { file: "feed-test.ts", tier: "llm", what: "interest derivation + a real discovery round" },
  { file: "feed-rank-test.ts", tier: "llm", what: "the real ranker, on calibration and junk cases" },
  { file: "feed-page-test.ts", tier: "llm", what: "paging the pool, top-up cost, in-app reading" },
  { file: "journal-ai-test.ts", tier: "llm", what: "journal memory round-trip and reflect" },
  { file: "agent-test.ts", tier: "llm", what: "the coding agent" },
  { file: "feature-test.ts", tier: "llm", what: "Alexa skill features" },
  { file: "alexa-smoke.ts", tier: "llm", what: "Alexa end-to-end smoke" },
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const tier = flag("--tier", "cheap");
const only = flag("--only", null);
const verbose = args.includes("--verbose");
const perTestTimeout = Number(flag("--timeout", "600")) * 1000;

const selected = TESTS.filter((t) => {
  if (only && !t.file.includes(only)) return false;
  if (tier === "all") return true;
  return t.tier === tier;
});

if (!selected.length) {
  console.log(`No tests match --tier ${tier}${only ? ` --only ${only}` : ""}.`);
  process.exit(0);
}

console.log(
  `Running ${selected.length} test${selected.length === 1 ? "" : "s"} (tier: ${tier})` +
    (tier === "llm" || tier === "all"
      ? " — these make REAL model calls and write real rows.\n"
      : " — no model calls.\n")
);

const results = [];
for (const t of selected) {
  const path = `scripts/${t.file}`;
  if (!existsSync(path)) {
    console.log(`SKIP  ${t.file} (missing)`);
    results.push({ ...t, status: "missing", pass: 0, fail: 0, seconds: 0 });
    continue;
  }
  const started = Date.now();
  const run = spawnSync(
    process.execPath,
    ["--env-file=.env.local", "--import", "tsx", path],
    { encoding: "utf8", timeout: perTestTimeout, maxBuffer: 32 * 1024 * 1024 }
  );
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const pass = (out.match(/^\s*PASS\b/gm) ?? []).length;
  const fail = (out.match(/^\s*FAIL\b/gm) ?? []).length;
  const crashed = run.error || run.status === null;
  // A test that cannot run here is not a failing test. agent-test needs a local
  // worker (`npm run agent`); reporting that as "5 checks failed" sends you
  // hunting for five broken features that are all one missing process.
  const skipLine = out.match(/^\s*SKIPPED[^\n]*/m)?.[0]?.trim();
  const status = crashed
    ? "crash"
    : skipLine
      ? "skipped"
      : run.status === 0 && fail === 0
        ? "ok"
        : "failed";

  console.log(
    `${status === "ok" ? "PASS" : status.toUpperCase().padEnd(7)} ${t.file}  (${seconds}s, ${pass} pass / ${fail} fail)`
  );
  console.log(`      ${t.what}`);
  if (status === "crash") {
    console.log(`      !! ${run.error?.message ?? "process died"}${run.signal ? ` (signal ${run.signal})` : ""}`);
  }
  if (status === "skipped") {
    console.log(`      -- ${skipLine}`);
    const why = out.split("\n").find((l) => /start it with/.test(l));
    if (why) console.log(`      -- ${why.trim()}`);
  }
  if (verbose || status !== "ok") {
    // On failure the individual FAIL lines matter more than the transcript.
    const lines = out.split("\n").filter((l) => /FAIL|Error|error:|^NOTE/.test(l));
    for (const l of (status === "ok" ? out.split("\n") : lines).slice(0, 60)) {
      if (l.trim()) console.log(`      | ${l.trim()}`);
    }
  }
  results.push({ ...t, status, pass, fail, seconds });
}

// Leave a trace for the system map (plans/system-map.html), so "what exists and
// does it work" is one page instead of two commands.
try {
  mkdirSync(join(process.cwd(), "plans"), { recursive: true });
  writeFileSync(
    join(process.cwd(), "plans", "test-status.json"),
    JSON.stringify(Object.fromEntries(results.map((r) => [r.file, r.status])), null, 2)
  );
} catch {
  // a report file is a convenience, never a reason to fail the run
}

const ok = results.filter((r) => r.status === "ok").length;
const skipped = results.filter((r) => r.status === "skipped").length;
const bad = results.length - ok - skipped;
console.log("\n================ SUMMARY ================");
for (const r of results) {
  const mark =
    r.status === "ok" ? "  ok   " : r.status === "skipped" ? " skip  " : " FAIL  ";
  console.log(
    `${mark} ${r.file.padEnd(26)} ${String(r.seconds).padStart(6)}s  ${r.pass}p/${r.fail}f` +
      (r.status === "skipped" ? "  (needs a local process)" : "")
  );
}
console.log(
  `${ok}/${results.length} passed` +
    (skipped ? `, ${skipped} skipped` : "") +
    (bad ? ` — ${bad} NEED ATTENTION` : "")
);
if (tier === "cheap") {
  console.log("(cheap tier only; run --tier llm for the model-touching tests)");
}
process.exit(bad === 0 ? 0 : 1);
