// End-to-end checks for "one notebook" (M2).
//
// Run: npm run memory:oneshop:test
//   (= node --env-file=.env.local --import tsx scripts/memory-oneshop-test.ts)
//
// THE PROPERTIES UNDER TEST:
//   1. ONE WRITE PATH. A chat exchange writes FACTS and nothing else. Before M2 a
//      turn wrote up to 3 free-text rows into coach_memory as well — a store with
//      no update path, which is how 552 uncorrectable sentences accumulated
//      alongside 270 correctable facts. Check 4 runs a REAL extraction and asserts
//      the prose store did not grow.
//   2. FACTS KNOW WHAT KIND OF TRUTH THEY ARE. `durable` never expires; `state`
//      gets a verify date, sooner in a topic that rots (kitchen/stock).
//   3. A STALE FACT IS LABELLED, NOT DELETED. The pantry fact that says "none
//      left" three weeks later must reach the prompt as "may be stale — ask, do
//      not assert", and must still exist.
//   4. THE CONSOLIDATION PASS IS SAFE BY DEFAULT. A dry run proposes and writes
//      nothing, and the mapper is pure, so what the model returns is validated
//      without an API call — including the rule that a note the model neither uses
//      nor reports is still accounted for as a drop. Silence is the one outcome
//      that would make "nothing lost" a slogan.
//
// Check 4 performs a REAL LLM extraction, so it writes real facts for a moment.
// They are seeded around a unique marker and deleted in the cleanup, together with
// anything written in this run's time window that mentions the marker.

import { createServiceClient } from "../src/lib/supabase";
import {
  getOrCreateTopic,
  upsertFact,
  retrieveMemory,
  staleFacts,
  defaultVerifyAfter,
  getActiveFacts,
} from "../src/lib/memory";
import {
  mapConsolidation,
  consolidateMemories,
  type LegacyNote,
} from "../src/lib/memory-consolidate";
import { extractMemories } from "../src/lib/coach";

const db = createServiceClient();
const unique = `memtest-${Date.now()}`;
const startedAt = new Date().toISOString();

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

async function factCount(): Promise<number> {
  const { count } = await db
    .from("memory_facts")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}

async function noteCount(): Promise<number> {
  const { count } = await db
    .from("coach_memory")
    .select("id", { count: "exact", head: true });
  return count ?? 0;
}

async function cleanup(): Promise<void> {
  // Seeded around the marker: anything in a MemTest topic, or written during this
  // run mentioning the marker, is ours.
  try {
    const { data: topics } = await db
      .from("memory_topics")
      .select("id")
      .ilike("slug", "%memtest%");
    const topicIds = ((topics ?? []) as { id: string }[]).map((t) => t.id);
    for (const id of topicIds) {
      await db.from("memory_facts").delete().eq("topic_id", id);
      await db.from("memory_topics").delete().eq("id", id);
    }
  } catch {
    // best-effort
  }
  try {
    const { data } = await db
      .from("memory_facts")
      .select("id,key,value,created_at")
      .or(`key.ilike.%${unique}%,value.ilike.%${unique}%,value.ilike.%waldhorn%`);
    for (const row of (data ?? []) as { id: string }[]) {
      await db.from("memory_facts").delete().eq("id", row.id);
    }
  } catch {
    // best-effort
  }
}

// --- 1. the pure mapper ------------------------------------------------------

function testMapper(): void {
  console.log("\n-- 1. mapConsolidation validates without an API call --");

  const batch: LegacyNote[] = [
    { id: "a", kind: "fact", text: "User plays tennis twice a week", category: "Sport" },
    { id: "b", kind: "fact", text: "User plays tennis regularly", category: "Sport" },
    { id: "c", kind: "fact", text: "User had a dentist appointment on Tuesday", category: null },
    { id: "d", kind: "goal_note", text: "User wants to move into a leadership role", category: "Ziele" },
  ];

  const raw = JSON.stringify({
    facts: [
      { topic: "Sport", key: "tennis", value: "twice a week", kind: "durable", from: [0, 1], confidence: 0.9 },
      { topic: "Ziele", key: "leadership", value: "move into a leadership role", kind: "nonsense", from: [3], confidence: 4 },
      { topic: "", key: "x", value: "y", from: [0] },
    ],
    dropped: [{ index: 2, reason: "one-off appointment, already past" }],
  });

  const result = mapConsolidation(batch, raw);
  check(
    "1a. two usable facts, the malformed one discarded (empty topic)",
    result.facts.length === 2,
    `${result.facts.length} fact(s)`
  );
  check(
    "1b. an unknown kind falls back to durable, and confidence is clamped",
    result.facts[1].kind === "durable" && result.facts[1].confidence === 1,
    `kind=${result.facts[1].kind} confidence=${result.facts[1].confidence}`
  );
  check(
    "1c. 'from' is filtered to real indices",
    result.facts[0].from.length === 2 && result.facts[1].from.join() === "3",
    `from=${JSON.stringify(result.facts.map((f) => f.from))}`
  );
  check(
    "1d. the reported drop carries the note text and the reason",
    result.dropped.some((d) => d.text.includes("dentist") && d.reason.includes("one-off")),
    `${result.dropped.length} drop(s)`
  );

  // The rule that makes "nothing lost" auditable: a note the model ignored is
  // still a drop, and says so.
  const silent = mapConsolidation(batch, JSON.stringify({ facts: [], dropped: [] }));
  check(
    "1e. a note the model neither used nor reported is STILL accounted for",
    silent.dropped.length === batch.length,
    `${silent.dropped.length} of ${batch.length} notes reported as dropped, none silent`
  );

  let threw = false;
  try {
    mapConsolidation(batch, "not json at all");
  } catch {
    threw = true;
  }
  check("1f. a non-JSON answer throws instead of silently writing nothing", threw);
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Memory 'one notebook' test (M2): one write path, facts that age.");
  console.log(`Run id: ${unique}`);

  testMapper();

  try {
    // --- 2. kind and volatility --------------------------------------------
    console.log("\n-- 2. a fact knows what kind of truth it is --");

    const durable = await upsertFact({
      topic: `MemTest Sport ${unique}`,
      key: `sport ${unique}`,
      value: "plays tennis twice a week",
      source: "memtest",
    });
    const state = await upsertFact({
      topic: `MemTest Ausstattung ${unique}`,
      key: `device ${unique}`,
      value: "has a new laptop",
      kind: "state",
      source: "memtest",
    });
    const volatile = await upsertFact({
      topic: `MemTest Küche & Vorräte ${unique}`,
      key: `tofu ${unique}`,
      value: "none left",
      kind: "state",
      source: "memtest",
    });

    check(
      "2a. a durable fact (the default) never expires",
      durable.fact?.kind === "durable" && durable.fact.verify_after === null,
      `kind=${durable.fact?.kind} verify_after=${durable.fact?.verify_after}`
    );
    check(
      "2b. a state fact gets a verify date",
      !!state.fact?.verify_after,
      `verify_after=${state.fact?.verify_after?.slice(0, 10)}`
    );

    const kitchenDays = 3;
    const genericDays = 7;
    const expected = defaultVerifyAfter("Küche & Vorräte", "state");
    const expectedDays = Math.round(
      (Date.parse(expected as string) - Date.now()) / 864e5
    );
    check(
      `2c. a kitchen/stock topic ages FASTER than the generic ${genericDays} days (got ${expectedDays})`,
      expectedDays === kitchenDays,
      `volatile window=${expectedDays}d, generic=${genericDays}d, this fact=${volatile.fact?.verify_after?.slice(0, 10)}`
    );

    // --- 3. staleness is labelled, never deleted ---------------------------
    console.log("\n-- 3. a fact past its verify date is LABELLED, not removed --");

    await db
      .from("memory_facts")
      .update({ verify_after: new Date(Date.now() - 864e5).toISOString() })
      .eq("id", volatile.fact?.id as string);

    const stale = await staleFacts(50);
    check(
      "3a. staleFacts reports it",
      stale.some((f) => f.id === volatile.fact?.id),
      `${stale.length} stale fact(s) in the store`
    );

    const read = await retrieveMemory(`what is in the kitchen, is there tofu`);
    check(
      "3b. the retrieved block labels it 'may be stale — ask, do not assert'",
      read.block.includes("may be stale"),
      read.block.includes("may be stale")
        ? "labelled"
        : "NOT labelled — a stale fact would be asserted as current"
    );
    const stillThere = await db
      .from("memory_facts")
      .select("id,status")
      .eq("id", volatile.fact?.id as string)
      .maybeSingle();
    check(
      "3c. and it still exists, still active (nothing is deleted)",
      (stillThere.data as { status: string } | null)?.status === "active",
      `status=${(stillThere.data as { status: string } | null)?.status}`
    );

    // --- 4. ONE write path --------------------------------------------------
    console.log("\n-- 4. a real exchange writes facts and NO prose (the M2 property) --");

    const factsBefore = await factCount();
    const notesBefore = await noteCount();

    const written = await extractMemories(
      `Merke dir für das Thema "MemTest Waldhorn ${unique}": ich spiele jetzt Waldhorn und übe jeden zweiten Abend.`,
      "Notiert — Waldhorn, jeden zweiten Abend."
    );

    const factsAfter = await factCount();
    const notesAfter = await noteCount();

    check(
      "4a. the exchange grew the FACTS store",
      factsAfter > factsBefore && written.length > 0,
      `${factsBefore} -> ${factsAfter} facts, ${written.length} written by this turn`
    );
    check(
      "4b. and did NOT grow the prose store (one write path)",
      notesAfter === notesBefore,
      `coach_memory ${notesBefore} -> ${notesAfter}`
    );
    check(
      "4c. the new facts carry provenance and a kind",
      written.every((f) => f.kind !== undefined) &&
        written.some((f) => f.source_ref !== null || f.source === "chat"),
      written.length
        ? written
            .map((f) => `${f.key} [${f.kind}${f.source_ref ? ", ref" : ""}]`)
            .join(", ")
            .slice(0, 120)
        : "nothing written"
    );

    // --- 5. the consolidation pass is safe by default ----------------------
    console.log("\n-- 5. the consolidation dry run proposes and writes nothing --");

    const beforeConsolidate = await factCount();
    const summary = await consolidateMemories({ dryRun: true, limit: 25 });
    const afterConsolidate = await factCount();

    check(
      "5a. a dry run reads real legacy notes",
      summary.notesRead > 0,
      `${summary.notesRead} unconsolidated note(s) read, ${summary.batches} batch(es)`
    );
    check(
      "5b. and writes nothing at all",
      afterConsolidate === beforeConsolidate && summary.dryRun,
      `facts ${beforeConsolidate} -> ${afterConsolidate}`
    );
    check(
      "5c. the proposal is readable: facts to write plus accounted-for drops",
      summary.factsWritten >= 0 && Array.isArray(summary.dropped),
      `proposed ${summary.factsWritten} fact(s), ${summary.dropped.length} drop(s)`
    );

    if (summary.sample.length) {
      note(
        "5d. sample of what the consolidation WOULD write",
        summary.sample
          .slice(0, 6)
          .map((f) => `[${f.kind}] ${f.topic} :: ${f.key} = ${f.value.slice(0, 60)}`)
          .join("\n      ")
      );
    }

    // Keep the store as we found it beyond our own seeds: the extraction in
    // check 4 wrote real facts, and they are ours to remove.
    const active = await getActiveFacts();
    const fromThisRun = active.filter(
      (f) => f.created_at >= startedAt && /waldhorn/i.test(`${f.key} ${f.value}`)
    );
    for (const f of fromThisRun) {
      await db.from("memory_facts").delete().eq("id", f.id);
    }
    if (fromThisRun.length) {
      note("cleanup", `removed ${fromThisRun.length} fact(s) written by the test's own exchange`);
    }
  } catch (err) {
    check("suite", false, errText(err));
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed the seeded topics and facts.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL ONE-NOTEBOOK CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("one-notebook test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
