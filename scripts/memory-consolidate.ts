// Move the legacy free-text memory (coach_memory, 552 rows) into the facts store.
//
// Run: npm run memory:consolidate             → DRY RUN: proposes, writes nothing
//      npm run memory:consolidate -- --apply  → writes the facts
//      npm run memory:consolidate -- --limit=50 --apply
//
// WHY IT DEFAULTS TO DRY. This is a judgement call over 552 sentences: what is
// still true, what merges with what, what is not worth keeping. The proposal is
// therefore readable BEFORE it is applied. Writing first and looking afterwards is
// how a cleanup becomes the next mess.
//
// It is resumable: every fact records the note ids it was built from, so a re-run
// skips the notes already covered instead of duplicating them.

import { consolidateMemories } from "../src/lib/memory-consolidate";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) || undefined : undefined;

  console.log(
    apply
      ? "Consolidating legacy notes INTO the facts store (writes)."
      : "DRY RUN — nothing will be written. Re-run with --apply to write."
  );

  const s = await consolidateMemories({ dryRun: !apply, limit });

  console.log(`\nNotes read:      ${s.notesRead}`);
  console.log(`Batches:         ${s.batches}`);
  console.log(`Facts proposed:  ${s.factsWritten}${apply ? " (written)" : ""}`);
  console.log(`Merged into an existing key: ${s.factsMerged}`);
  console.log(`Notes dropped:   ${s.dropped.length}`);

  if (s.sample.length) {
    console.log("\nSample of the facts:");
    for (const f of s.sample.slice(0, 10)) {
      console.log(`  [${f.kind}] ${f.topic} :: ${f.key} = ${f.value}`);
    }
  }

  if (s.dropped.length) {
    console.log("\nDropped (kept in the report, not in the store):");
    for (const d of s.dropped.slice(0, 10)) {
      console.log(`  - "${d.text.slice(0, 90)}" — ${d.reason}`);
    }
    if (s.dropped.length > 10) {
      console.log(`  … and ${s.dropped.length - 10} more`);
    }
  }

  if (!apply) {
    console.log(
      "\nNothing was written. The prose rows stay in coach_memory either way —\n" +
        "this pass adds facts, it never deletes a note."
    );
  }
}

main().catch((err) => {
  console.error("consolidation failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
