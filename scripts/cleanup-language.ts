// One-off language cleanup: MERGE the duplicated slots, rename the few English
// labels that have no German twin, and plan the goal renames.
//
// The decision behind it (2026-09-20), after measuring every store:
//   - VALUES are never translated. They are the user's own words, and translating
//     them is lossy editing ("Unkraut jäten" is not quite "weeding"). Both the
//     extractor and the consolidation pass are told the same thing.
//   - SLOTS (topic titles, keys) go to ONE language — German, because that is what
//     his data mostly already is — because slots are labels, and labels are the
//     only thing that duplicates. The measured cost: one vegan constraint as five
//     rows under three keys, two topics for one kitchen, two goals for one
//     intention.
//   - UI LABELS stay English (feed interests): they are copy, not data.
//
// Merging is by MOVING facts to the surviving topic and deleting the emptied row.
// Nothing is deleted that holds data, no value is rewritten, and every step prints
// what it did.
//
// Run: npm run cleanup:language              (dry run — prints the plan)
//      npm run cleanup:language -- --apply
//      npm run cleanup:language -- --apply --goals    (also rename goal titles)
import { createServiceClient } from "../src/lib/supabase";
import { slugifyTopic } from "../src/lib/memory";

const APPLY = process.argv.includes("--apply");
const GOALS = process.argv.includes("--goals");

/** Topic pairs that are the same area under two names. `from` is emptied, `into` survives. */
const TOPIC_MERGES: { from: string; into: string; why: string }[] = [
  { from: "Küche", into: "Küche & Vorräte", why: "one kitchen, two topics" },
  { from: "Essen & Ernährung", into: "Ernährung", why: "one diet, two topics" },
  { from: "Planning", into: "Planung", why: "one area, two languages" },
  { from: "Planning", into: "Planung", why: "(duplicate entry guard)" },
];

/**
 * English topic titles with NO German twin: renamed, because a label is not a
 * thought. Loanwords that German actually uses (Backlog, Coaching, Feedback,
 * Leadership-Case, To-Do-App, Sprint) and mixed product names (App & Feed) are
 * left alone on purpose — translating those would make the map worse, not better.
 */
const TOPIC_RENAMES: { from: string; to: string }[] = [
  { from: "Open Loops", to: "Offene Fäden" },
  { from: "Work & Social", to: "Arbeit & Soziales" },
  { from: "Specs", to: "Spezifikationen" },
];

/**
 * The goal renames, printed always and applied only with --goals: goal titles are
 * what he reads in Stats and Today, and they are quoted in the feed's rubric, so
 * the change is visible and deserves a look before it lands.
 */
const GOAL_RENAMES: { from: string; to: string }[] = [
  { from: "Reflect daily on life categories", to: "Täglich über Lebensbereiche reflektieren" },
  { from: "Invest in my home", to: "In mein Zuhause investieren" },
  { from: "Invest in personal projects", to: "In eigene Projekte investieren" },
  { from: "Eat healthy", to: "Gesund essen" },
  { from: "Play tennis regularly", to: "Regelmäßig Tennis spielen" },
  { from: "Move toward a leadership role", to: "Richtung Führungsrolle entwickeln" },
  { from: "Read more", to: "Mehr lesen" },
  { from: "Have fun with friends", to: "Zeit mit Freunden genießen" },
  { from: "Invest in our relationship", to: "In unsere Beziehung investieren" },
  { from: "Exercise in the morning", to: "Morgens Sport machen" },
];

const line = (s: string) => console.log(`  ${s}`);

async function main(): Promise<void> {
  const db = createServiceClient();
  console.log(APPLY ? (GOALS ? "APPLYING (including goal titles)\n" : "APPLYING (slot renames only; goals need --goals)\n") : "DRY RUN (add --apply)\n");

  const { data: topicRows, error: tErr } = await db
    .from("memory_topics")
    .select("id,title,slug");
  if (tErr) throw new Error(tErr.message);
  const topics = (topicRows ?? []) as { id: string; title: string; slug: string }[];
  const byTitle = new Map(topics.map((t) => [t.title.toLowerCase(), t]));

  // --- 1. merge duplicate topics -------------------------------------------
  console.log("1. duplicate topics");
  const done = new Set<string>();
  for (const m of TOPIC_MERGES) {
    const key = `${m.from}->${m.into}`;
    if (done.has(key)) continue;
    done.add(key);
    const from = byTitle.get(m.from.toLowerCase());
    const into = byTitle.get(m.into.toLowerCase());
    if (!from || !into) {
      line(`skip: ${m.from} → ${m.into} (missing)`);
      continue;
    }
    const { count } = await db
      .from("memory_facts")
      .select("id", { count: "exact", head: true })
      .eq("topic_id", from.id);
    line(`merge "${m.from}" (${count ?? 0} fact(s)) → "${m.into}" — ${m.why}`);
    if (APPLY) {
      await db.from("memory_facts").update({ topic_id: into.id }).eq("topic_id", from.id);
      await db.from("memory_topics").delete().eq("id", from.id);
    }
  }

  // --- 2. rename English labels that have no German twin -------------------
  console.log("\n2. topic titles");
  for (const r of TOPIC_RENAMES) {
    const t = byTitle.get(r.from.toLowerCase());
    if (!t) {
      line(`skip: "${r.from}" (missing)`);
      continue;
    }
    line(`rename "${r.from}" → "${r.to}"`);
    if (APPLY) {
      await db
        .from("memory_topics")
        .update({ title: r.to, slug: slugifyTopic(r.to), updated_at: new Date().toISOString() })
        .eq("id", t.id);
    }
  }

  // --- 3. report what is left, so the state is visible rather than assumed --
  const { data: after } = await db.from("memory_topics").select("id,title");
  const afterRows = (after ?? []) as { id: string; title: string }[];
  const { count: factCount } = await db
    .from("memory_facts")
    .select("id", { count: "exact", head: true });
  console.log(`\n3. state after this pass: ${afterRows.length} topic(s), ${factCount ?? "?"} fact row(s)`);
  const germanish = afterRows.filter((t) => /[äöüß]/i.test(t.title)).length;
  console.log(`   titles with umlauts: ${germanish} (a rough German marker; single nouns without umlauts are invisible to it, which is why this is not a metric)`);

  // --- 4. the goals, which are the visible half ---------------------------
  console.log(`\n4. goal titles ${GOALS ? "(APPLYING)" : "(printed only — pass --goals to apply)"}`);
  const { data: goalRows } = await db.from("goals").select("id,title,status");
  for (const g of (goalRows ?? []) as { id: string; title: string; status: string }[]) {
    const r = GOAL_RENAMES.find((x) => x.from.toLowerCase() === g.title.toLowerCase());
    if (!r) {
      line(`keep  [${g.status}] ${g.title}`);
      continue;
    }
    line(`rename [${g.status}] ${g.title}  →  ${r.to}`);
    if (APPLY && GOALS) {
      await db
        .from("goals")
        .update({ title: r.to, updated_at: new Date().toISOString() })
        .eq("id", g.id);
    }
  }
  const missed = GOAL_RENAMES.filter(
    (r) => !((goalRows ?? []) as { title: string }[]).some((g) => g.title.toLowerCase() === r.from.toLowerCase())
  );
  if (missed.length) {
    console.log("   (planned renames that matched no goal — stale list, please trim)");
    for (const m of missed) line(`orphan: ${m.from}`);
  }

  console.log(
    APPLY
      ? "\nDone. Values were not touched: only topic rows were moved/renamed, and goal titles only with --goals."
      : "\nNothing was written."
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
