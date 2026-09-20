// End-to-end checks for memory RETRIEVAL (M1).
//
// Run: npm run memory:retrieval:test
//   (= node --env-file=.env.local --import tsx scripts/memory-retrieval-test.ts)
//
// THE PROPERTIES THIS FILE EXISTS TO PROVE, in order of how easy they are to
// break silently:
//   1. A fact is findable BY MEANING, not by recency. Before M1 the prompt showed
//      "the 8 newest topics, 12 facts each" — so a fact in an older topic was
//      invisible no matter how relevant it was. Check 2 seeds exactly that.
//   2. THE FLOOR CANNOT BE MISSED. A fact written a second ago must be present
//      even when the intent has nothing to do with it — otherwise "it remembers
//      what I just said" depends on the embedding ranking being lucky.
//   3. ONE TOPIC CANNOT FLOOD. Without a per-topic cap, a kitchen with 40 facts
//      owns the whole block.
//   4. THE BUDGET IS REAL. The block must shrink when asked to.
//
// Check 6 reports the size of the coach prompt against the pre-M1 baseline that
// was measured before this change (16,870 characters, of which 8,470 were
// memory). That is a RECORDED baseline, not a live measurement, and it is printed
// rather than asserted, because prompt size is a budget decision, not a fact.
//
// HONEST GAP: the fallback branch — embeddings unavailable → full dump — is not
// exercised here. It cannot be triggered without breaking the API key for the
// process. Check 5 asserts the fallback TARGET still produces a dump, which is
// the half of it that can be checked without sabotage.

import { createServiceClient } from "../src/lib/supabase";
import {
  getOrCreateTopic,
  upsertFact,
  retrieveMemory,
  formatForContext,
  MEMORY_BUDGET_CHARS,
} from "../src/lib/memory";
import { buildAssistantContext } from "../src/lib/coach";

const db = createServiceClient();
const unique = `memtest-${Date.now()}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (ok) passed++;
  else failed++;
}

function note(name: string, detail = ""): void {
  console.log(`NOTE  ${name}${detail ? `\n      ${detail}` : ""}`);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const createdTopicIds = new Set<string>();

async function seedTopic(title: string, ageDays = 0): Promise<string> {
  const topic = await getOrCreateTopic(`${title} ${unique}`);
  createdTopicIds.add(topic.id);
  if (ageDays > 0) {
    const stamp = new Date(Date.now() - ageDays * 864e5).toISOString();
    await db
      .from("memory_topics")
      .update({ updated_at: stamp, created_at: stamp })
      .eq("id", topic.id);
  }
  return topic.id;
}

async function cleanup(): Promise<void> {
  // Facts first (they reference the topic), identified by the marker in key
  // OR value, then the topics by title marker.
  try {
    const { data } = await db
      .from("memory_facts")
      .select("id,key,value")
      .or(`key.ilike.%${unique}%,value.ilike.%${unique}%`);
    for (const row of (data ?? []) as { id: string }[]) {
      await db.from("memory_facts").delete().eq("id", row.id);
    }
  } catch {
    // best-effort
  }
  try {
    const { data } = await db
      .from("memory_topics")
      .select("id,title")
      .ilike("title", `%${unique}%`);
    for (const row of (data ?? []) as { id: string }[]) createdTopicIds.add(row.id);
  } catch {
    // best-effort
  }
  for (const id of createdTopicIds) {
    try {
      await db.from("memory_topics").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
}

async function main(): Promise<void> {
  console.log("Memory retrieval test (M1): findable by meaning, with a floor.");
  console.log(`Run id: ${unique}`);

  try {
    // --- 1. setup + embedding coverage -------------------------------------
    console.log("\n-- 1. facts are embedded, so they are reachable at all --");

    const oldTopic = await seedTopic("MemTest Sourdough", 400); // far older than the prompt window
    await upsertFact({
      topic: `MemTest Sourdough ${unique}`,
      key: `pinecone flour ${unique}`,
      value: `${unique}: the user bakes sourdough with pinecone flour every Sunday`,
      source: "memtest",
    });

    // Backdate the FACT as well as its topic. The floor below always includes the
    // ten most recently updated facts, so a fact written a second ago is in every
    // prompt by design — that is check 3, not check 2. Backdating is what makes
    // check 2 measure SIMILARITY: without it, 2b would pass or fail for the wrong
    // reason, which is exactly what happened the first time this ran.
    await db
      .from("memory_facts")
      .update({ updated_at: new Date(Date.now() - 400 * 864e5).toISOString() })
      .ilike("key", "%pinecone%")
      .ilike("key", `%${unique}%`);

    const freshTopic = await seedTopic("MemTest Watched");
    await upsertFact({
      topic: `MemTest Watched ${unique}`,
      key: `episode ${unique}`,
      value: `${unique}: the user is halfway through a series about deep sea mining`,
      source: "memtest",
    });

    const row = await db
      .from("memory_facts")
      .select("id,embedding")
      .ilike("key", `%${unique}%`)
      .limit(4);
    const withVector = ((row.data ?? []) as { embedding: unknown }[]).filter(
      (r) => r.embedding !== null
    ).length;
    check(
      `1. all ${(row.data ?? []).length} freshly written fact(s) carry an embedding`,
      withVector === (row.data ?? []).length && withVector > 0,
      `embedded=${withVector}`
    );

    // --- 2. findable by meaning, not by recency ----------------------------
    console.log("\n-- 2. a fact in an OLD topic is found by meaning --");

    const byMeaning = await retrieveMemory(
      `what does the user bake with unusual flour on the weekend`
    );
    const foundOld = byMeaning.block.includes(`pinecone flour ${unique}`);
    check(
      "2. a 400-day-old fact (outside the floor) is retrieved by a related question",
      foundOld,
      foundOld
        ? `found in ${byMeaning.facts} fact(s), ${byMeaning.chars} chars`
        : "NOT FOUND — the intent did not reach a fact the old window could never show"
    );
    const irrelevant = await retrieveMemory(`corporate tax law in estonia`);
    check(
      "2b. and it is NOT returned for an unrelated question (ranking is doing work)",
      !irrelevant.block.includes(`pinecone flour ${unique}`),
      irrelevant.block.includes(`pinecone flour ${unique}`)
        ? "returned for an unrelated intent — the block is not ranked"
        : `absent from ${irrelevant.facts} fact(s)`
    );

    // --- 3. the floor -------------------------------------------------------
    console.log("\n-- 3. the newest fact is present even for an unrelated intent --");

    const floorHit = irrelevant.block.includes(`episode ${unique}`);
    check(
      "3. a fact written seconds ago reaches the prompt for ANY intent",
      floorHit,
      floorHit
        ? "present via the pinned/newest floor"
        : "MISSING — a brand-new fact would be invisible until something asked about it"
    );

    // --- 4. per-topic cap ---------------------------------------------------
    console.log("\n-- 4. one topic cannot flood the block --");

    const floodTopic = `MemTest Flood ${unique}`;
    for (let i = 0; i < 6; i++) {
      await upsertFact({
        topic: floodTopic,
        key: `detail ${i} ${unique}`,
        value: `${unique}: flood detail number ${i} about the flooded topic`,
        source: "memtest",
      });
    }
    const flooded = await retrieveMemory(`flood detail about the flooded topic`);
    const floodLines = flooded.block
      .split("\n")
      .filter((l) => l.includes(`flood detail number`)).length;
    check(
      `4. at most 3 of that topic's 6 facts are included (saw ${floodLines})`,
      floodLines <= 3 && floodLines > 0,
      `${floodLines} line(s) from the flooding topic`
    );

    // --- 5. the budget ------------------------------------------------------
    console.log("\n-- 5. the budget is real, and the fallback target still works --");

    const defaultRead = await retrieveMemory(`the flooded topic and sourdough`);
    const tight = await retrieveMemory(`the flooded topic and sourdough`, {
      budgetChars: 200,
    });
    check(
      "5. a tight budget returns a smaller block than the default",
      tight.block.length < defaultRead.block.length,
      `default=${defaultRead.block.length} chars, tight=${tight.block.length} chars (default budget ${MEMORY_BUDGET_CHARS})`
    );

    const dump = await formatForContext();
    check(
      "5b. the fallback target (the full dump) still produces memory",
      dump.length > 0,
      `${dump.length} chars available if retrieval ever fails`
    );

    // --- 6. the prompt ------------------------------------------------------
    console.log("\n-- 6. the coach prompt carries retrieved memory, not a dump --");

    const context = await buildAssistantContext({ intent: "what should I cook this week" });
    const hasRetrieved = context.includes("## What Nova knows about the user (retrieved for this moment)");
    const hasOldDump =
      context.includes("## What you remember about the user (long-term)") ||
      context.includes("## Living memory (maintained facts)");
    check(
      "6. the retrieved section is present and the two wholesale dumps are gone",
      hasRetrieved && !hasOldDump,
      hasRetrieved
        ? hasOldDump
          ? "a retired dump section is still in the prompt"
          : "one retrieved section, no dump"
        : "the retrieved section is MISSING from the coach context"
    );

    note(
      "6b. size, against the pre-M1 baseline measured before this change",
      `before: 16,870 chars of prompt, 8,470 of them memory.\n` +
        `      now:   ${context.length} chars of prompt, and the memory section is ` +
        `${(context.match(/## What Nova knows about the user[\s\S]*?(?=\n## |$)/)?.[0] ?? "").length} of them.`
    );
  } catch (err) {
    check("suite", false, errText(err));
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed the planted topics and facts.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL MEMORY RETRIEVAL CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("memory retrieval test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
