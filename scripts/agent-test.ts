// End-to-end test of the coding-agent client → worker → filesystem/git.
// Requires the worker running with CODING_AGENT_ROOT = the scratch repo.
// Uses a unique file name per run so the test is idempotent. Usage:
//   node --env-file=.env.local --import tsx scripts/agent-test.ts
import {
  codeWriteFile,
  codeReadFile,
  codeListDir,
  codeRunCommand,
  codeGit,
} from "../src/lib/coding-agent";

async function main() {
  // PREFLIGHT. The worker is a separate local process (npm run agent). Without it
  // every check below fails for the same environmental reason, which reads like
  // five broken features and sends you looking in the wrong place — it cost one
  // confusing "agent-test FAILED 5/5 in 0.3s" run to write this. Report it once
  // and exit 0, so a test runner can say "skipped" instead of crying wolf.
  const probe = await codeRunCommand('node -e "process.stdout.write(\'ping\')"');
  if (!probe.includes("ping")) {
    console.log("SKIPPED: the coding-agent worker is not reachable.");
    console.log(`      ${probe.split("\n")[0]}`);
    console.log("      start it with: npm run agent (needs CODING_AGENT_TOKEN)");
    return;
  }

  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) failures.push(label);
  };

  const fname = `src/agent-${Date.now()}.txt`;
  const base = fname.split("/").pop()!;

  await codeWriteFile(fname, "hello from the coding agent");
  const read = await codeReadFile(fname);
  check("write + read", read.includes("hello from the coding agent"));

  const list = await codeListDir("src");
  check("list dir", list.includes(base));

  const run = await codeRunCommand("node -e \"console.log('agent-run-ok')\"");
  check("run command", run.includes("agent-run-ok"));

  const status = await codeGit("status");
  check("git status shows new file", status.includes(base));

  await codeGit("add");
  await codeGit("commit", `agent test commit ${Date.now()}`);
  const log = await codeGit("log");
  check("git commit + log", log.includes("agent test commit"));

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll coding-agent checks passed.");
}

main().catch((e) => {
  console.error("agent test crashed:", e);
  process.exit(1);
});
