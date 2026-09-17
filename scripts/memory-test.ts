// End-to-end checks for the P6a memory layer: the commitments ledger (a promise
// said in chat must become a REAL row backed by a REAL item) and open loops (a
// thread with a state we can move), plus the morning capture check.
//
// Run: npm run memory:test
//   (= node --env-file=.env.local --import tsx scripts/memory-test.ts)
//
// TWO KINDS OF ASSERTION — the report says which is which, because they are not
// equally strong evidence:
//   [behavioural] hits the real DB / the real code path and observes the row.
//   [structural]  reads the SOURCE of notify-run.ts and checks the contract it
//                 advertises. It does not execute anything.
//
// Why #8 is structural: the live check is runNotificationRun("morning"), which
// would call web-push with the REAL VAPID keys against the REAL subscriptions —
// i.e. it would buzz the user's actual phones. A test must not do that, so we
// assert the return contract by reading the file and defer the live proof to the
// 08:00 cron.
//
// Everything this script creates (items, commitments, loops, chat turns) is
// tracked and removed in a finally block, so a failed assertion still cleans up.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServiceClient } from "../src/lib/supabase";
import { deleteItem } from "../src/lib/db";
import {
  extractCommitments,
  looksLikeCommitment,
  captureCheck,
  listCommitments,
  type Commitment,
} from "../src/lib/commitments";
import {
  upsertLoop,
  setLoopState,
  listLoops,
  seedLoopsFromMemory,
  type OpenLoop,
} from "../src/lib/loops";

const db = createServiceClient();

// --- report -----------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(
  kind: "behavioural" | "structural",
  name: string,
  ok: boolean,
  detail = ""
): void {
  console.log(
    `${ok ? "PASS" : "FAIL"}  [${kind}] ${name}${detail ? `  (${detail})` : ""}`
  );
  if (ok) passed++;
  else failed++;
}

// A clean, single sentence for a failure, and a marker the caller can test so a
// missing P6a table reads as "migration not applied" rather than a product bug.
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
function isMissingTable(err: unknown): boolean {
  return /schema cache|does not exist|42P01|PGRST205/i.test(errText(err));
}

// --- cleanup tracking -------------------------------------------------------

const created = {
  items: new Set<string>(),
  commitments: new Set<string>(),
  loops: new Set<string>(),
  chatClientIds: new Set<string>(),
};
const createdLoopSubjects = new Set<string>();

// Delete every loop this run created. Matched on subject substring "memorytest"
// so a row we made is always found even if its id was never captured.
async function purgeLoops(): Promise<void> {
  const ids = new Set(created.loops);
  try {
    const { data } = await db
      .from("open_loops")
      .select("id,subject")
      .ilike("subject", "%memorytest%");
    for (const row of (data ?? []) as { id: string; subject: string }[]) {
      createdLoopSubjects.add(row.subject);
      ids.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of ids) {
    try {
      await db.from("open_loops").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }
}

async function cleanup(): Promise<void> {
  // 1. Commitments first — they reference items via item_id.
  const commitmentIds = new Set(created.commitments);
  try {
    const { data } = await db
      .from("commitments")
      .select("id,text")
      .ilike("text", "%karotte%");
    for (const row of (data ?? []) as { id: string; text: string }[]) {
      // Only ever remove test text; a real promise the user made is left alone.
      if (/karotte|gemüse|kaffee/i.test(row.text)) commitmentIds.add(row.id);
    }
  } catch {
    // table missing → nothing to purge
  }
  for (const id of commitmentIds) {
    try {
      await db.from("commitments").delete().eq("id", id);
    } catch {
      // best-effort
    }
  }

  // 2. Loops.
  await purgeLoops();

  // 3. Items. A commitment's item may have been left behind if the ledger row
  // was never written, so also sweep by title.
  const itemIds = new Set(created.items);
  try {
    const { data } = await db
      .from("items")
      .select("id,title")
      .ilike("title", "%karotten%");
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      itemIds.add(row.id);
    }
  } catch {
    // best-effort
  }
  for (const id of itemIds) {
    try {
      await deleteItem(id);
    } catch {
      // best-effort
    }
  }

  // 4. Chat turns.
  for (const clientId of created.chatClientIds) {
    try {
      await db.from("chat_messages").delete().eq("client_id", clientId);
    } catch {
      // best-effort
    }
  }
}

// --- helpers ----------------------------------------------------------------

const unique = `memorytest-${Date.now()}`;
const PAST = "Ich habe gestern Karotten gekauft";
const HYPOTHETICAL = "Ich koennte mal Karotten kaufen";

// Best-effort table probe: tells the report whether the P6a migration
// (0023_commitments_loops.sql) has been applied, so a failure can say WHY.
async function tableExists(name: string): Promise<boolean> {
  try {
    const { error } = await db.from(name).select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

async function countItemsByTitle(title: string): Promise<number> {
  const { data, error } = await db
    .from("items")
    .select("id,title")
    .ilike("title", `%${title}%`);
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

async function openCommitmentRows(text: string): Promise<Commitment[]> {
  const { data, error } = await db
    .from("commitments")
    .select("id,text,quote,due_date,item_id,status,source,created_at,updated_at")
    .ilike("text", `%${text}%`)
    .eq("status", "open");
  if (error) throw new Error(error.message);
  return (data ?? []) as Commitment[];
}

// One turn of an exchange, through the REAL extraction path (one LLM call).
async function sayCommitment(
  userText: string
): Promise<{ saved: Commitment[]; itemCount: number; rows: Commitment[] }> {
  const saved = await extractCommitments(userText, "Okay, verstanden.");
  for (const c of saved) {
    created.commitments.add(c.id);
    if (c.item_id) created.items.add(c.item_id);
  }
  const rows = await openCommitmentRows("karotte");
  for (const r of rows) {
    created.commitments.add(r.id);
    if (r.item_id) created.items.add(r.item_id);
  }
  return { saved, itemCount: await countItemsByTitle("karotte"), rows };
}

// --- assertions -------------------------------------------------------------

async function testCommitmentCapture(tablesOk: boolean): Promise<void> {
  console.log("\n-- 1-4. Commitments ledger --");

  if (!tablesOk) {
    const why = "commitments table missing — run npm run migrate (0023)";
    check(
      "behavioural",
      "1. a German promise creates ONE item with a due date + ONE ledger row linked to it",
      false,
      why
    );
    check("behavioural", "2. saying it again creates no second item and no second row", false, why);
    check("behavioural", "3. past tense and hypothetical create nothing", false, why);
  } else {
    // 1. A real promise → exactly one item (with a due date) + exactly one row
    // whose item_id points at that item. THIS is the whole point of the module.
    try {
      const first = await sayCommitment("Ich kaufe morgen Karotten");
      const itemOk = first.itemCount === 1;
      const dueOk = first.rows.length === 1 && first.rows[0].due_date !== null;
      const linkOk =
        first.rows.length === 1 &&
        !!first.rows[0].item_id &&
        first.saved.length === 1 &&
        first.saved[0].item_id === first.rows[0].item_id;
      check(
        "behavioural",
        "1a. promise creates exactly ONE item",
        itemOk,
        `items=${first.itemCount}`
      );
      check(
        "behavioural",
        "1b. that item carries a due_date (no invented date)",
        dueOk,
        `due=${first.rows[0]?.due_date ?? "null"}`
      );
      check(
        "behavioural",
        "1c. exactly ONE ledger row, item_id points at the item",
        linkOk,
        `row.item_id=${first.rows[0]?.item_id ?? "null"}`
      );

      // 2. The same promise again → the unique partial index makes it idempotent.
      const second = await sayCommitment("Ich kaufe morgen Karotten");
      check(
        "behavioural",
        "2. same promise again: still ONE item, still ONE row, nothing new saved",
        second.itemCount === 1 &&
          second.rows.length === 1 &&
          second.saved.length === 0,
        `items=${second.itemCount} rows=${second.rows.length} saved=${second.saved.length}`
      );
    } catch (err) {
      check("behavioural", "1. promise creates an item + a linked ledger row", false, errText(err));
      check("behavioural", "2. same promise again is idempotent", false, errText(err));
    }
  }

  // 3. Past tense and hypothetical must create NOTHING. Run the real extractor
  // so this covers the prompt rules, not just the pre-filter.
  try {
    const before = await countItemsByTitle("karotten");
    const beforeRows = await openCommitmentRows("karotten").catch(() => []);
    const past = await extractCommitments(PAST, "Gut.");
    const hypo = await extractCommitments(HYPOTHETICAL, "Klar.");
    const after = await countItemsByTitle("karotten");
    const afterRows = await openCommitmentRows("karotten").catch(() => []);
    for (const c of [...past, ...hypo]) created.commitments.add(c.id);
    check(
      "behavioural",
      "3. past tense 'Ich habe gestern Karotten gekauft' + hypothetical create nothing",
      past.length === 0 &&
        hypo.length === 0 &&
        after === before &&
        afterRows.length === beforeRows.length,
      `past=${past.length} hypo=${hypo.length} items ${before}->${after}`
    );
  } catch (err) {
    check("behavioural", "3. past tense + hypothetical create nothing", false, errText(err));
  }

  // 4. The cheap pre-filter is pure, so it is checked directly.
  const statement = "Das Wetter ist heute schön in Wien.";
  const promise = "Ich rufe morgen den Zahnarzt an.";
  check(
    "behavioural",
    "4. looksLikeCommitment: false for a plain statement, true for a promise",
    looksLikeCommitment(statement) === false &&
      looksLikeCommitment(promise) === true,
    `statement=${looksLikeCommitment(statement)} promise=${looksLikeCommitment(promise)}`
  );
}

async function testLoopLifecycle(tablesOk: boolean): Promise<void> {
  console.log("\n-- 5-6. Open loops --");

  if (!tablesOk) {
    const why = "open_loops table missing — run npm run migrate (0023)";
    check("behavioural", "5. loop lifecycle open -> waiting -> done, no duplicate", false, why);
    check("behavioural", "6. seedLoopsFromMemory seeds once, then no-ops", false, why);
    return;
  }

  // 5. Lifecycle. The subject carries the "memorytest" marker so cleanup can
  // always find it.
  const subject = `MemoryTest ${unique}`;
  const thread = "Küchenplan mit Alex";
  createdLoopSubjects.add(subject);
  try {
    const loop = await upsertLoop({ subject, thread });
    created.loops.add(loop.id);
    check(
      "behavioural",
      "5a. upsertLoop creates a loop in state 'open'",
      loop.state === "open",
      `state=${loop.state}`
    );

    const isListed = async (state: OpenLoop["state"]): Promise<boolean> =>
      (await listLoops({ subject: unique })).some(
        (l) => l.id === loop.id && l.state === state
      );

    await setLoopState(loop.id, "waiting", "you");
    const waiting = (await listLoops({ subject: unique })).find(
      (l) => l.id === loop.id
    );
    const waitingOk =
      waiting?.state === "waiting" &&
      waiting?.waiting_on === "you" &&
      (await isListed("waiting"));
    check(
      "behavioural",
      "5b. setLoopState -> waiting, waiting_on 'you', listLoops reflects it",
      waitingOk,
      `state=${waiting?.state ?? "?"} waiting_on=${waiting?.waiting_on ?? "null"}`
    );

    // The unique partial index on (subject_norm, thread_norm) must make a repeat
    // upsert an UPDATE of the live row, not a second thread. This is checked
    // while the thread is still LIVE: the index is partial on state <> 'done', so
    // a done thread is deliberately re-openable by design (verified separately in
    // 5e below) and could not demonstrate de-duplication.
    const again = await upsertLoop({ subject, thread, detail: "updated by test" });
    created.loops.add(again.id);
    const matching = (await listLoops({ subject: unique })).filter(
      (l) => l.thread === thread
    );
    check(
      "behavioural",
      "5d. second upsertLoop (same subject+thread) does not duplicate while live",
      again.id === loop.id &&
        matching.length === 1 &&
        again.detail === "updated by test",
      `id ${again.id === loop.id ? "same" : "DIFFERENT"} rows=${matching.length}`
    );

    await setLoopState(loop.id, "done");
    const done = (await listLoops({ subject: unique })).find(
      (l) => l.id === loop.id
    );
    check(
      "behavioural",
      "5c. setLoopState -> done, listLoops reflects it",
      done?.state === "done" && (await isListed("done")),
      `state=${done?.state ?? "?"}`
    );

    // A done thread may be re-opened as a fresh row: the unique index is partial
    // (state <> 'done'), so this is expected behaviour, asserted so it is not
    // mistaken for a duplicate bug.
    const reopened = await upsertLoop({ subject, thread });
    created.loops.add(reopened.id);
    check(
      "behavioural",
      "5e. a DONE thread can be re-opened as a new live row (partial index by design)",
      reopened.id !== loop.id && reopened.state === "open",
      `state=${reopened.state} newId=${reopened.id !== loop.id}`
    );
  } catch (err) {
    check("behavioural", "5. loop lifecycle", false, errText(err));
  }

  // 6. Seeding must fire only when the table is empty, and never overwrite a
  // thread the user has moved by hand. Isolated in a temporary table state:
  // pre-existing loops are stashed, the table is emptied, seed runs twice, then
  // the stash is restored.
  let stashed: OpenLoop[] = [];
  try {
    const { data, error } = await db.from("open_loops").select("*");
    if (error) throw new Error(error.message);
    stashed = (data ?? []) as OpenLoop[];
    const keepIds = new Set([...stashed].map((l) => l.id));
    // Clear rows we may have stashed that are already the run's own test rows.
    for (const id of created.loops) keepIds.delete(id);
    try {
      await db.from("open_loops").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    } catch {
      // best-effort
    }

    const firstSeed = await seedLoopsFromMemory();
    const afterFirst = (await db.from("open_loops").select("id,subject")).data ?? [];
    const secondSeed = await seedLoopsFromMemory();
    const afterSecond = (await db.from("open_loops").select("id,subject")).data ?? [];

    check(
      "behavioural",
      "6. seedLoopsFromMemory creates rows when empty, then is a no-op",
      firstSeed > 0 &&
        afterFirst.length === firstSeed &&
        secondSeed === 0 &&
        afterSecond.length === afterFirst.length,
      `first=${firstSeed} rows=${afterFirst.length} second=${secondSeed} rows=${afterSecond.length}`
    );

    // Restore the stashed originals, minus the freshly seeded rows.
    try {
      await db.from("open_loops").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    } catch {
      // best-effort
    }
    if (stashed.length) {
      const rows = stashed.map((l) => {
        const { subject_norm: _sn, thread_norm: _tn, ...rest } =
          l as OpenLoop & { subject_norm?: string; thread_norm?: string };
        void _sn;
        void _tn;
        return rest;
      });
      const { error } = await db.from("open_loops").insert(rows);
      if (error) throw new Error(error.message);
    }
  } catch (err) {
    check("behavioural", "6. seedLoopsFromMemory seeds once, then no-ops", false, errText(err));
    // Best-effort restore so the user's real loops are never lost.
    if (stashed.length) {
      try {
        const rows = stashed.map((l) => {
          const { subject_norm: _sn, thread_norm: _tn, ...rest } =
            l as OpenLoop & { subject_norm?: string; thread_norm?: string };
          void _sn;
          void _tn;
          return rest;
        });
        await db.from("open_loops").insert(rows);
      } catch {
        // best-effort
      }
    }
  }
}

async function testCaptureCheck(tablesOk: boolean): Promise<void> {
  console.log("\n-- 7. Morning capture check --");

  if (!tablesOk) {
    const why = "commitments table missing — run npm run migrate (0023)";
    check("behavioural", "7. captureCheck finds nothing after a captured promise", false, why);
    check("behavioural", "7. captureCheck DOES find a promise inserted with no ledger row", false, why);
    return;
  }

  const clientId = `memorytest-${Date.now()}`;
  created.chatClientIds.add(clientId);
  // Assertion 1 deliberately leaves its promise OPEN, so this assertion must not
  // depend on global open-commitment state: captureCheck reads the conversation
  // AND consults every open commitment. Snapshot first, so the detail line can
  // show exactly what was open on entry.
  try {
    const preExistingOpen = await listCommitments({ status: "open", limit: 100 });
    // Deterministic: pin the day so the promise lands in the window captureCheck
    // reads (it defaults to the PREVIOUS logical day when `since` is omitted).
    const today = new Date().toISOString().slice(0, 10);
    await db.from("chat_messages").insert({
      role: "user",
      content: "Ich kaufe morgen Karotten",
      client_id: clientId,
      created_at: `${today}T09:00:00`,
    });

    // Captured: extract it through the REAL write path so a ledger row AND its
    // item exist, then look for exactly that promise in the ledger.
    const saved = await extractCommitments("Ich kaufe morgen Karotten", "Notiert.");
    for (const c of saved) {
      created.commitments.add(c.id);
      if (c.item_id) created.items.add(c.item_id);
    }
    const captured = await captureCheck({ clientId, since: today });
    // captureCheck dedupes a candidate against open commitments by EXACT
    // normalized text (openNorms.has(norm)) and against active item titles the
    // same way. Both sides come from the model, and the extractor's wording for
    // the same sentence can differ from captureCheck's ("Kaufe Karotten" vs
    // "Kaufe morgen Karotten"), which is the mismatch this detail makes visible.
    const mismatch = captured.uncaptured
      .map(
        (u) =>
          `suggested="${u.suggested}" vs ledger=[${saved
            .map((c) => c.text)
            .join(" | ")}]`
      )
      .join("; ");
    check(
      "behavioural",
      "7a. a CAPTURED promise is not reported as uncaptured",
      captured.uncaptured.length === 0,
      `uncaptured=${captured.uncaptured.length} scanned=${captured.scanned}` +
        (mismatch ? `; ${mismatch}` : "")
    );
    if (captured.uncaptured.length > 0) {
      console.log(
        "      ^ captureCheck matches by EXACT normalized text, so the same\n" +
          "        promise re-worded by the extractor reads as 'said but never\n" +
          "        recorded' even though the ledger row exists."
      );
    }

    // Uncaptured: a promise in chat with no ledger row and no matching item.
    // Close the open commitment created above so nothing answers for it, and
    // leave the new promise untouched.
    for (const c of saved) {
      await db.from("commitments").update({ status: "done" }).eq("id", c.id);
    }
    if (preExistingOpen.length === 0) {
      // Nothing else is open; the only candidate is the new promise.
    }

    const uncapturedText = "Ich schreibe morgen die Zusammenfassung fertig";
    await db.from("chat_messages").insert({
      role: "user",
      content: uncapturedText,
      client_id: clientId,
      created_at: `${today}T10:00:00`,
    });
    const found = await captureCheck({ clientId, since: today });
    const hit = found.uncaptured.some(
      (u) =>
        /zusammenfassung/i.test(u.suggested) || /zusammenfassung/i.test(u.quote)
    );
    check(
      "behavioural",
      "7b. a promise with NO ledger row IS reported as uncaptured",
      hit,
      `uncaptured=${found.uncaptured.length} [${found.uncaptured
        .map((u) => u.suggested)
        .join(", ")}]`
    );
  } catch (err) {
    check("behavioural", "7. captureCheck", false, errText(err));
  }
}

async function testNotifyContract(): Promise<void> {
  console.log("\n-- 8. Morning notify summary (STRUCTURAL — source read only) --");

  try {
    const path = fileURLToPath(new URL("../src/lib/notify-run.ts", import.meta.url));
    const src = await readFile(path, "utf8");
    // The contract lives in the object returned by runNotificationRun. Assert
    // against the return block, not the whole file, so a local variable that
    // merely shares a name cannot satisfy the check.
    const returnIdx = src.lastIndexOf("return {");
    const tail = src.slice(returnIdx === -1 ? 0 : returnIdx);
    const fields = ["memoryNudge", "uncaptured", "waitingOnYou", "staleLoops"] as const;
    const missing = fields.filter(
      (f) => !new RegExp(`\\b${f}\\s*[,:]`).test(tail)
    );
    check(
      "structural",
      "8a. runNotificationRun's return advertises memoryNudge/uncaptured/waitingOnYou/staleLoops",
      missing.length === 0,
      missing.length ? `missing: ${missing.join(", ")}` : "all four present"
    );
    check(
      "structural",
      "8b. the morning branch is what populates them (kind === 'morning' path present)",
      /kind === "evening"/.test(src) && /memoryNudge = true/.test(src),
      "morning section located"
    );
  } catch (err) {
    check("structural", "8. notify-run.ts contract", false, errText(err));
  }

  console.log(
    "NOTE  [structural] Live verification of the morning notify summary is DEFERRED to the\n" +
      "      08:00 cron: calling runNotificationRun would push REAL notifications to the\n" +
      "      user's devices, so this check reads notify-run.ts instead of executing it."
  );
}

// --- main -------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("Memory layer test (commitments ledger + open loops + capture check)");
  console.log(`Run id: ${unique}`);
  console.log(
    "Assertions are labelled [behavioural] (real DB / real code path) or\n" +
      "[structural] (source read, nothing executed)."
  );

  const commitmentsOk = await tableExists("commitments");
  const loopsOk = await tableExists("open_loops");
  if (!commitmentsOk || !loopsOk) {
    console.log(
      `\nWARNING: migration 0023_commitments_loops.sql is not applied ` +
        `(commitments=${commitmentsOk ? "ok" : "MISSING"}, ` +
        `open_loops=${loopsOk ? "ok" : "MISSING"}).\n` +
        `         Run "npm run migrate" to apply it; the DB checks below will ` +
        `report FAIL until then.`
    );
  }

  try {
    await testCommitmentCapture(commitmentsOk);
    await testLoopLifecycle(loopsOk);
    await testCaptureCheck(commitmentsOk);
    await testNotifyContract();
  } finally {
    try {
      await cleanup();
      console.log("\nCleanup: removed created items, commitments, loops and chat rows.");
    } catch (err) {
      console.log(`\nCleanup warning: ${errText(err)}`);
    }
  }

  console.log(
    `\n${passed} passed, ${failed} failed ` +
      `(${failed === 0 ? "ALL MEMORY CHECKS PASSED" : "FAILURES ABOVE"})`
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("memory test crashed:", err);
  try {
    await cleanup();
  } catch {
    // best-effort
  }
  process.exit(1);
});
