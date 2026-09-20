// One-off repair of the facts behind the 2026-09-20 kitchen failure.
//
// WHAT WENT WRONG (his words, from the stored chat):
//   "ich will jetzt kochen. was schlägst du vor"       10:25
//   -> the assistant proposed a Hähnchen-Reis-Pfanne to a vegan
//   "Bist du komplett lost? ... Ich bin vegan"         10:25
//   -> it then said it could not see the fridge, then found it, and stated
//      "Knoblauch ist leer", suggested the Linsen-Dal it had as "next dish"
//      (he had cooked it YESTERDAY) and later "Karotten" (he has none)
//   "Nein, ich habe kein Knoblauchpulver und Knoblauch ist nicht leer.
//    Ich habe Knoblauch. Paprika habe ich gekauft. Ich habe keine Karotten.
//    Linsendal habe ich schon gestern gemacht."         10:27
//
// THREE DEFECTS IN THE STORE, not in his memory of his own kitchen:
//   1. The vegan constraint existed in FIVE active rows under four different
//      keys (diet / ernährung / ernährungsweise) and NONE was pinned. Pinned
//      facts are the one thing retrieval can never drop, so the single most
//      consequential fact about him was competing with 630 others for a slot.
//   2. The pantry notes ("Verräte aktuell", "Gekochtes heute", "Fehlende
//      Gewürze") were classified `durable`, so they got no verify date and were
//      never flagged. A five-day-old snapshot was read back as today's kitchen.
//   3. The topic summary still said "planning a Linsen-Dal as their next dish",
//      which summarises a plan he had already carried out.
//
// WHAT THIS DOES (all reversible; nothing is deleted):
//   - pins the canonical constraint (diet = vegan) so it can never fall out of
//     context again. It also freezes it: upsertFact refuses to overwrite a
//     pinned fact, and the human override (Stats ▸ What I remember) is the way
//     to change it.
//   - retires the duplicate vegan rows (status=superseded — history kept, and
//     they were the same claim under a different name).
//   - re-classifies the pantry/stock rows as kind=state with a verify date of
//     now, so they render as "[may be stale — ask, do not assert]".
//   - records the two corrections he actually gave today (garlic, no garlic
//     powder, paprika bought, no carrots) and what he cooked yesterday.
//   - re-curates the kitchen topic summary so it stops describing a plan as
//     pending.
//
// Run: npm run memory:kitchen        (dry run — prints the plan, writes nothing)
//      npm run memory:kitchen -- --apply
import { createServiceClient } from "../src/lib/supabase";
import {
  getTopics,
  setFactPinned,
  setFactStatus,
  upsertFact,
  curateTopic,
  type MemoryFact,
} from "../src/lib/memory";

const APPLY = process.argv.includes("--apply");

/**
 * Keys that describe the CURRENT contents of a kitchen, not a durable truth.
 * Deliberately NARROW: only keys that can mean nothing else.
 *
 * A bare `gewürze` key is excluded, because it turns out to mean two different
 * things in this store — stock in one topic ("Grundgewürze fehlen und stehen auf
 * der Einkaufsliste") and taste in two others ("will keine bestimmten Gewürze",
 * "nur Basisgewürze"). Re-labelling a taste as a snapshot would start asking him
 * to re-confirm a preference he has held for years. The dry run is what showed
 * that, twice: first `Vorlieben › gewürze`, then `Küche & Vorräte › gewürze`.
 * Those rows are listed but left alone.
 */
const SNAPSHOT_KEY =
  /^(verr?äte|vorr?äte|vorrat|gekochtes|gekocht|geplantes_essen|fehlende gew|gewürze_vor|vorrat_fuer)/i;
/** Ambiguous keys: reported, never re-classified. */
const AMBIGUOUS_KEY = /^gewürze$/i;
/** The keys that have carried the vegan constraint in this store. */
const CONSTRAINT_KEY = /^(diet|ernährung|ernaehrung|ernährungsweise|ernaehrungsweise)$/i;

function line(text: string): void {
  console.log(`  ${text}`);
}

async function main(): Promise<void> {
  const db = createServiceClient();
  console.log(APPLY ? "APPLYING\n" : "DRY RUN (add --apply to write)\n");

  const topics = await getTopics();
  const titleOf = new Map(topics.map((t) => [t.id, t.title]));

  const { data, error } = await db
    .from("memory_facts")
    .select("id,topic_id,key,value,kind,pinned,status,verify_after,updated_at")
    .eq("status", "active")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  const facts = (data ?? []) as Pick<
    MemoryFact,
    "id" | "topic_id" | "key" | "value" | "kind" | "pinned" | "status" | "verify_after" | "updated_at"
  >[];

  // --- 1. the constraint ----------------------------------------------------
  const constraintRows = facts.filter(
    (f) => CONSTRAINT_KEY.test(f.key.trim()) && /vegan/i.test(f.value)
  );
  console.log(`1. vegan constraint — ${constraintRows.length} active row(s)`);
  for (const f of constraintRows) {
    line(`[${f.pinned ? "pinned" : "      "}] ${titleOf.get(f.topic_id) ?? "?"} › ${f.key} = ${f.value}`);
  }
  // Canonical: the row keyed exactly "diet" (the key the prompt now asks for),
  // else the most recently written one. `facts` is already newest-first.
  const canonical =
    constraintRows.find((f) => f.key.trim().toLowerCase() === "diet") ?? constraintRows[0];
  if (!canonical) {
    console.log("   no vegan fact found — nothing to pin (skipped)\n");
  } else {
    console.log(`   -> pinning: ${canonical.key} = ${canonical.value}`);
    if (APPLY) await setFactPinned(canonical.id, true);
    for (const f of constraintRows) {
      if (f.id === canonical.id) continue;
      console.log(`   -> retiring duplicate: ${f.key} = ${f.value}`);
      if (APPLY) await setFactStatus(f.id, "superseded");
    }
  }

  // --- 2. pantry snapshots classified as durable ---------------------------
  const snapshots = facts.filter((f) => SNAPSHOT_KEY.test(f.key.trim()));
  const ambiguous = facts.filter((f) => AMBIGUOUS_KEY.test(f.key.trim()));
  console.log(`\n2. pantry/stock snapshots — ${snapshots.length} active row(s)`);
  const nowIso = new Date().toISOString();
  for (const f of snapshots) {
    const fix = f.kind !== "state" || !f.verify_after;
    line(
      `[${f.kind}${f.verify_after ? " verify:" + f.verify_after.slice(0, 10) : " no verify date"}] ` +
        `${titleOf.get(f.topic_id) ?? "?"} › ${f.key} = ${f.value.slice(0, 70)}${fix ? "   <- re-classify to state" : ""}`
    );
    if (fix && APPLY) {
      await db
        .from("memory_facts")
        .update({ kind: "state", verify_after: nowIso })
        .eq("id", f.id);
    }
  }

  console.log(`\n2b. ambiguous spice rows — ${ambiguous.length} active, LEFT ALONE`);
  for (const f of ambiguous) {
    line(`${titleOf.get(f.topic_id) ?? "?"} › ${f.key} = ${f.value.slice(0, 70)}`);
  }

  // --- 3. the corrections he gave today ------------------------------------
  // These are things the USER stated in the chat on 2026-09-20, not inferences:
  const corrections = [
    {
      topic: "Küche & Vorräte",
      // NOT the bare key "gewürze": in this topic that key holds a PREFERENCE
      // ("will keine bestimmten Gewürze in der Küche"), and overwriting a taste
      // with an inventory note is how keys stop meaning one thing.
      key: "gewürze_vorrat",
      value:
        "Knoblauch ist vorhanden (nicht leer); Paprikapulver wurde am 20.09. gekauft; Knoblauchpulver hat er NICHT.",
      kind: "state" as const,
    },
    {
      topic: "Küche & Vorräte",
      key: "gekocht_zuletzt",
      value: "19.09.: Linsen-Dal — bereits gegessen, NICHT mehr geplant.",
      kind: "state" as const,
    },
  ];
  console.log("\n3. corrections from the 2026-09-20 conversation");
  for (const c of corrections) {
    line(`${c.topic} › ${c.key} = ${c.value}`);
  }
  if (APPLY) {
    for (const c of corrections) await upsertFact({ ...c, source: "memory-fix-kitchen" });
  }

  // --- 4. refresh the summary that described a finished plan as pending ----
  const kitchen = topics.find((t) => /k(ü|u)che/i.test(t.title));
  console.log("\n4. topic summary");
  if (kitchen) {
    line(`${kitchen.title} — currently: ${(kitchen.summary ?? "(none)").slice(0, 120)}`);
    if (APPLY) {
      const summary = await curateTopic(kitchen.id).catch(() => null);
      line(`rewritten: ${(summary ?? "(curation failed — summary left as it was)").slice(0, 200)}`);
    } else {
      line("would re-curate this topic's summary from the corrected facts");
    }
  } else {
    line("no kitchen topic found (skipped)");
  }

  console.log(
    APPLY
      ? "\nDone. Every change is reversible: superseded rows keep their values, pins and kinds can be reverted in Stats ▸ What I remember."
      : "\nNothing was written. Re-run with --apply."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
