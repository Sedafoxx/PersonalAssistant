// Regression test for SEARCH RANKING (and the German/English query handling).
//
// The bug this exists to prevent: a literal query used to come back in whatever
// order Postgres happened to return it (one flat OR of every query word), so
// "Theresas Birthday gift ideas" put "Proactive Life Coach Mode" first and the
// actual gift-for-Theresa item below the fold — and a query of nothing but
// stopwords returned 30 rows, because "the" is a substring of "together".
// The user's words: "i looked for Theresas Birthday gift ideas and i did not
// find any or i just found like 2? something is wrong with the search."
//
// So the checks below assert POSITION, not just presence — retrieval always
// worked; the ranking is what buried the answer.
//
// Run: npm run search:test
//   (= node --env-file=.env.local --import tsx scripts/search-rank-test.ts)
import {
  getItems,
  createItem,
  deleteItem,
  searchWords,
  expandQuery,
  type Item,
  type ItemType,
} from "../src/lib/db";

interface Seed {
  type: ItemType;
  title: string;
  content?: string;
}

// Seeded, so the test is repeatable on any database and leaves no trace. The
// distractor is the real offender from the live data: an item that shares a
// query word ("idea") but has nothing to do with a gift.
const SEEDS: Seed[] = [
  {
    type: "idea",
    title: "Birthday present for Theresa: Cards Against Humanity",
    content: "Gift idea for Theresa's birthday",
  },
  {
    type: "todo",
    title: "Order a birthday gift for Theresa",
    content: "Buy the present before her birthday",
  },
  {
    type: "idea",
    title: "Proactive Life Coach Mode (self-enhancing assistant)",
    content: "The assistant should proactively notice things and suggest ideas on its own",
  },
];

// The user's own rows — the ones behind the complaint. This is HIS data, so the
// test reports their position always, and only ASSERTS when they still exist
// (he is free to rename or delete his own items).
const LIVE_IDEA = "Gift for Theresa: Digital Cards Against Humanity";
const LIVE_TODO = "Buy gift for Theresa";

// The seeded shapes, used for the position assertions.
const SEED_IDEA = "Birthday present for Theresa";
const SEED_TODO = "Order a birthday gift for Theresa";
const DISTRACTOR = "Proactive Life Coach Mode";

let failed = 0;
function check(name: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!ok) failed++;
}

function note(text: string): void {
  console.log(`NOTE  ${text}`);
}

function position(items: { title: string }[], needle: string): number {
  const want = needle.toLowerCase();
  return items.findIndex((i) => i.title.toLowerCase().includes(want));
}

async function runQuery(query: string, label: string): Promise<Item[]> {
  const items = await getItems({ query });
  const { words, translated } = expandQuery(query);
  const own = words.filter((w) => !translated.includes(w));
  console.log(`\n--- ${label}`);
  console.log(`    query: "${query}"`);
  console.log(
    `    matched on: [${own.join(", ")}]` +
      (translated.length ? ` + translated [${translated.join(", ")}]` : "") +
      `  ->  ${items.length} result(s)`
  );
  items.slice(0, 6).forEach((it, i) => console.log(`    ${i + 1}. [${it.type}] ${it.title}`));
  return items;
}

async function main(): Promise<void> {
  const ids: string[] = [];
  try {
    // 0. The query normaliser on its own: possessive, stopwords, both languages.
    const possessive = searchWords("Theresas Birthday gift ideas");
    check(
      "normalise: the possessive loses its s",
      possessive.includes("theresa") && !possessive.includes("theresas"),
      possessive.join(" ")
    );
    check(
      "normalise: 'Theresas' and 'Theresa' search the same thing",
      searchWords("Theresas").join(" ") === searchWords("Theresa").join(" "),
      `[${searchWords("Theresas").join(" ")}] vs [${searchWords("Theresa").join(" ")}]`
    );
    check(
      "normalise: stopwords are dropped in German and English",
      searchWords("where can i get das Geschenk für die Theresa").join(" ") ===
        "geschenk theresa",
      searchWords("where can i get das Geschenk für die Theresa").join(" ")
    );
    check(
      "normalise: a query of only stopwords yields nothing to match on",
      searchWords("the and for with").length === 0,
      `[${searchWords("the and for with").join(" ")}]`
    );

    const bilingual = expandQuery("Geburtstag Geschenk Theresa");
    check(
      "bilingual: 'Geburtstag' also searches for 'birthday'",
      bilingual.translated.includes("birthday"),
      `translated [${bilingual.translated.join(", ")}]`
    );
    check(
      "bilingual: 'Geschenk' also searches for 'gift'",
      bilingual.translated.includes("gift"),
      `translated [${bilingual.translated.join(", ")}]`
    );
    check(
      "bilingual: the user's own words stay marked as his own",
      expandQuery("Geburtstag").words.filter((w) => !expandQuery("Geburtstag").translated.includes(w)).join(" ") ===
        "geburtstag"
    );

    for (const s of SEEDS) {
      const row = await createItem({ type: s.type, title: s.title, content: s.content });
      ids.push(row.id);
    }

    // 1. The user's actual English query. The gift items must be at the TOP, and
    //    above the item that merely shares the word "idea".
    const english = await runQuery("Theresas Birthday gift ideas", "English query");
    const ideaAt = position(english, SEED_IDEA);
    const todoAt = position(english, SEED_TODO);
    const distractorAt = position(english, DISTRACTOR);
    check("english: the Theresa gift idea is in the top 3", ideaAt !== -1 && ideaAt < 3, `position ${ideaAt + 1}`);
    check("english: the Theresa gift todo is in the top 5", todoAt !== -1 && todoAt < 5, `position ${todoAt + 1}`);
    check(
      "english: both gift items outrank the 'Life Coach Mode' distractor",
      distractorAt === -1 || (ideaAt !== -1 && todoAt !== -1 && ideaAt < distractorAt && todoAt < distractorAt),
      `gift idea ${ideaAt + 1}, gift todo ${todoAt + 1}, distractor ${distractorAt + 1}`
    );

    // 2. The same thing asked in German here / English there. "Geburtstag" and
    //    "Birthday" share no letters, so this one can only be found by MEANING
    //    (or by the name, which is language-independent).
    const german = await runQuery("Geburtstag Geschenk Theresa", "German query");
    const gIdeaAt = position(german, SEED_IDEA);
    const gTodoAt = position(german, SEED_TODO);
    check("german: the Theresa gift idea is a hit", gIdeaAt !== -1, `position ${gIdeaAt + 1}`);
    check("german: the Theresa gift idea is in the top 5", gIdeaAt !== -1 && gIdeaAt < 5, `position ${gIdeaAt + 1}`);
    check("german: the Theresa gift todo is in the top 8", gTodoAt !== -1 && gTodoAt < 8, `position ${gTodoAt + 1}`);

    // 3. A sentence, not keywords: "what should i get theresa for her birthday"
    //    must not search for "what"/"get"/"her".
    const sentence = await runQuery("what should i get theresa for her birthday", "Sentence query");
    const sIdeaAt = position(sentence, SEED_IDEA);
    check("sentence: the Theresa gift idea is in the top 3", sIdeaAt !== -1 && sIdeaAt < 3, `position ${sIdeaAt + 1}`);

    // 4. The same as a German sentence.
    const germanSentence = await runQuery("Was schenke ich Theresa zum Geburtstag?", "German sentence");
    const gsIdeaAt = position(germanSentence, SEED_IDEA);
    check(
      "german sentence: the Theresa gift idea is in the top 5",
      gsIdeaAt !== -1 && gsIdeaAt < 5,
      `position ${gsIdeaAt + 1}`
    );

    // 5. A query of nothing but stopwords must not return the whole table.
    const stopOnly = await runQuery("the and for with", "stopwords only");
    check("stopwords only: not everything comes back", stopOnly.length <= 20, `${stopOnly.length} result(s)`);

    // 6. An unrelated query must not surface the gift items at the top.
    const unrelated = await runQuery("kubernetes cluster autoscaling", "unrelated query");
    const uIdeaAt = position(unrelated, SEED_IDEA);
    check(
      "unrelated: the Theresa gift idea is not in the top 3",
      uIdeaAt === -1 || uIdeaAt >= 3,
      `position ${uIdeaAt + 1}`
    );

    // 7. His OWN rows, reported always, asserted only if they are still there.
    //    The test's own seeds are excluded from the ranking here, because two
    //    deliberately twin-like items sitting in front of his would measure the
    //    fixture, not the fix.
    const live = await getItems({ query: "Theresas Birthday gift ideas" });
    const liveOnly = live.filter((i) => !ids.includes(i.id));
    const liveIdeaAt = position(liveOnly, LIVE_IDEA);
    const liveTodoAt = position(liveOnly, LIVE_TODO);
    console.log("\n--- the user's own rows, with his own wording (seeds excluded)");
    console.log(`    "${LIVE_IDEA}"  ->  ${liveIdeaAt === -1 ? "not in the DB" : `position ${liveIdeaAt + 1} of ${liveOnly.length}`}`);
    console.log(`    "${LIVE_TODO}"  ->  ${liveTodoAt === -1 ? "not in the DB" : `position ${liveTodoAt + 1} of ${liveOnly.length}`}`);
    if (liveIdeaAt === -1) note("his Theresa gift idea is not in the DB — assertion skipped");
    else check("live: his Theresa gift idea is in the top 3", liveIdeaAt < 3, `position ${liveIdeaAt + 1}`);
    if (liveTodoAt === -1) note("his Theresa gift todo is not in the DB — assertion skipped");
    else check("live: his Theresa gift todo is in the top 3", liveTodoAt < 3, `position ${liveTodoAt + 1}`);
  } finally {
    for (const id of ids) {
      await deleteItem(id).catch(() => undefined);
    }
    const left = await getItems({ query: "Cards Against Humanity" }).catch(() => []);
    check("cleanup: seeded rows are gone", !left.some((i) => ids.includes(i.id)));
  }

  console.log(`\n${failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`}`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
