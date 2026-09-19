// Give every EXISTING active fact an embedding, so retrieval (M1) can find it.
//
// Run: npm run memory:backfill          → writes
//      npm run memory:backfill -- --dry → reports what it would do
//
// Facts written from now on are embedded at write time; this is only for the
// rows that already existed. It is idempotent and re-runnable: it reads only
// facts whose embedding is still null, in batches, so a failure half-way through
// is fixed by running it again.

import { backfillFactEmbeddings, getActiveFacts } from "../src/lib/memory";

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");

  const before = await getActiveFacts();
  console.log(`Active facts: ${before.length}`);

  const result = await backfillFactEmbeddings({ dryRun: dry });

  if (dry) {
    console.log(`DRY RUN — ${result.remaining} active fact(s) have no embedding yet.`);
    console.log("Run without --dry to embed them (one batched request per 32 facts).");
    return;
  }

  console.log(`Embedded ${result.embedded}, failed ${result.failed}, still missing ${result.remaining}.`);
  if (result.failed > 0) {
    console.log(
      "Re-run to retry the failures. A fact without an embedding is still\n" +
        "remembered and still shown by the fallback dump — it is just not found\n" +
        "by similarity until it has a vector."
    );
  }
}

main().catch((err) => {
  console.error("backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
