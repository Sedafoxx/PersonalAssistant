// Functional test for the journal-AI feature:
//   - long-term memory DB round-trip (deterministic)
//   - create a journal entry through the AI pipeline (categorize + memory)
//   - run a guided reflection
//   - clean up everything it created
// Runs against the real DB + real LLM (needs .env.local). Usage:
//   node --env-file=.env.local --import tsx scripts/journal-ai-test.ts
import {
  createJournalEntry,
  getCategories,
  getMemories,
  addMemory,
  reflect,
} from "../src/lib/journal";
import { createServiceClient } from "../src/lib/supabase";

async function main() {
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) failures.push(label);
  };

  const db = createServiceClient();

  // 1. Memory DB round-trip (deterministic, independent of the model).
  await addMemory("test memory zephyr", "Health");
  const mems = await getMemories(20);
  check(
    "memory DB round-trip",
    mems.some((m) => m.text.includes("zephyr"))
  );
  const zephyrs = mems.filter((m) => m.text.includes("zephyr")).map((m) => m.id);
  if (zephyrs.length) await db.from("journal_memories").delete().in("id", zephyrs);

  // 2. AI pipeline with a clearly memory-worthy entry.
  const memBefore = await getMemories(1);
  const beforeTime = memBefore[0]?.created_at ?? "1970-01-01T00:00:00Z";

  check("seed categories exist", (await getCategories()).length >= 6);

  const { entry, newCategory } = await createJournalEntry(
    "My sister Anna is moving to Vienna next month — I'm really happy and a bit worried about money for helping her get settled. Also went for a run this morning and felt great."
  );
  check("entry saved", !!entry.id);
  check("entry has categories", (entry.categories ?? []).length > 0);

  const memsAfter = await getMemories(100);
  const newMems = memsAfter.filter((m) => m.created_at > beforeTime);
  check(
    "entry produced long-term memory (Anna move)",
    newMems.some((m) => /anna|vienna/i.test(m.text))
  );

  // 3. Guided reflection.
  const r = await reflect(entry.raw_text, {
    categories: (await getCategories()).map((c) => c.name),
    memories: memsAfter.map((m) => m.text),
    goals: [],
    history: [],
  });
  check("reflect returns a reply", r.reply.length > 10);
  console.log("REFLECT REPLY:", r.reply);

  // Cleanup.
  await db.from("journal_entries").delete().eq("id", entry.id);
  if (newMems.length) {
    await db
      .from("journal_memories")
      .delete()
      .in("id", newMems.map((m) => m.id));
  }
  if (newCategory) {
    await db.from("journal_categories").delete().eq("id", newCategory.id);
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll journal-AI checks passed.");
}

main().catch((e) => {
  console.error("journal-ai test crashed:", e);
  process.exit(1);
});
