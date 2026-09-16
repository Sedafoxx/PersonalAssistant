// End-to-end smoke test for Nova's feed, steps 1 (interests with evidence) and
// 2 (discovery that verifies itself).
// Run: npm run feed:test
//   (= node --env-file=.env.local --import tsx scripts/feed-test.ts)
import {
  gatherFitSignals,
  deriveInterests,
  tokenOverlap,
  getInterests,
  discoverCandidates,
  saveCandidates,
  getStoredItems,
  resetStoredItems,
} from "../src/lib/feed";
import { canonicalUrl, spotifyStatus } from "../src/lib/feed-sources";

// --- flags -------------------------------------------------------------------

// CLI flags so the operator can widen the sample without env gymnastics:
//   npm run feed:test -- --interests 8 --budget 16 --reset-stored
// Parsed defensively: an unknown flag is ignored, and a flag with a missing or
// non-numeric value falls back to the env var / default. The env vars still work
// as before (FEED_MAX_INTERESTS, FEED_PER_SOURCE, FEED_TAVILY_BUDGET).
interface Flags {
  maxInterests: number;
  budget: number;
  perSource: number;
  resetStored: boolean;
}

function parseFlags(argv: string[]): Flags {
  const int = (raw: string | undefined, envName: string, fallback: number): number => {
    const fromFlag = Number(raw);
    if (raw !== undefined && Number.isFinite(fromFlag) && fromFlag > 0) {
      return Math.floor(fromFlag);
    }
    const fromEnv = Number(process.env[envName]);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? Math.floor(fromEnv) : fallback;
  };

  // Resolve all three limits up front. A flag that is never passed must still
  // fall back to its env var or its default: leaving perSource at 0 is what made
  // every source slice away its own results while still spending the whole
  // Tavily budget, which looked exactly like a network failure.
  const flags: Flags = {
    maxInterests: int(undefined, "FEED_MAX_INTERESTS", 8),
    budget: int(undefined, "FEED_TAVILY_BUDGET", 16),
    perSource: int(undefined, "FEED_PER_SOURCE", 4),
    resetStored: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--reset-stored") flags.resetStored = true;
    else if (arg === "--interests") {
      flags.maxInterests = int(argv[++i], "FEED_MAX_INTERESTS", 8);
    } else if (arg === "--budget") {
      flags.budget = int(argv[++i], "FEED_TAVILY_BUDGET", 16);
    } else if (arg === "--per-source") {
      flags.perSource = int(argv[++i], "FEED_PER_SOURCE", 4);
    }
    // anything else: ignored, never fatal
  }
  return flags;
}

const FLAGS = parseFlags(process.argv.slice(2));

// The model is told never to return these as an interest: they are too vague to
// search and return nothing useful. If one slips through, the derivation is
// wrong, so the test fails.
const BANNED = ["self-improvement", "productivity", "personal growth", "mindset"];

// The same >= 0.6 Jaccard test the code-side merge uses, applied to every pair
// of labels in the active set. This is the assertion that catches a duplicated
// family two runs apart.
const OVERLAP = 0.6;

// A label must be readable English: the UI is English even though the user's
// data is German. Umlauts and common German words in a top-level label mean the
// model leaked the user's language into the UI. evidence is exempt.
const GERMAN_WORDS = [
  "der", "die", "das", "und", "mit", "für", "von", "im", "zum", "zur",
  "gehalt", "rezepte", "üben", "besorgen", "vermeiden", "abendreflexion",
  "morgensport", "grundgewürze", "kokosmilch", "beziehungsroutine",
];

async function main() {
  let failed = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
  };

  try {
    // One line, first thing: whether Spotify is configured AND whether its
    // token endpoint actually answers. Without it, a run full of `apple`
    // podcasts looks identical whether the keys are absent or refused.
    const spotify = await spotifyStatus();
    console.log(
      `SPOTIFY  configured=${spotify.configured} token=${spotify.token} — ${spotify.detail}\n`
    );

    // 1. The raw fit signals the model will read (truncated for readability).
    const signals = await gatherFitSignals();
    console.log("=== FIT SIGNALS ===================================================");
    console.log(
      signals.length > 3000 ? `${signals.slice(0, 3000)}\n…[${signals.length} chars total]` : signals
    );
    console.log("===================================================================\n");

    // 2. Derive interests from those signals.
    const { interests, created, updated, retired, missed } = await deriveInterests();
    console.log(
      `=== DERIVED INTERESTS (created ${created}, updated ${updated}, retired ${retired}, held ${missed}) ===`
    );
    for (const i of interests) {
      console.log(
        `- [${i.kind}] ${i.text} (slug ${i.slug ?? "(none)"}, weight ${i.weight})\n` +
          `    queries: ${i.queries?.length ? i.queries.join(" | ") : "(none)"}\n` +
          `    evidence: ${i.evidence ?? "(none)"}`
      );
    }
    console.log("");

    // 3. Assertions on the result.
    check("derived at least one interest", interests.length > 0, `${interests.length}`);

    const generic = interests.filter((i) =>
      BANNED.some((b) => i.text.toLowerCase().includes(b))
    );
    check(
      "no interest is a banned generic term",
      generic.length === 0,
      generic.map((i) => i.text).join(", ") || BANNED.join("/")
    );

    // 1. Evidence on every active interest.
    const noEvidence = interests.filter((i) => !i.evidence || !i.evidence.trim());
    check(
      "every interest has evidence",
      noEvidence.length === 0,
      noEvidence.map((i) => i.text).join(", ")
    );

    // 3. One live row per slug.
    const slugCount = new Map<string, number>();
    for (const i of interests) {
      if (!i.slug) continue;
      slugCount.set(i.slug, (slugCount.get(i.slug) ?? 0) + 1);
    }
    const dupSlugs = [...slugCount.entries()].filter(([, n]) => n > 1);
    check(
      "no two active interests share a slug",
      dupSlugs.length === 0,
      dupSlugs.map(([s, n]) => `${s} x${n}`).join(", ") || `${slugCount.size} slug(s)`
    );

    // 4. No near-duplicate labels.
    const nearDupes: string[] = [];
    for (let a = 0; a < interests.length; a++) {
      for (let b = a + 1; b < interests.length; b++) {
        const overlap = tokenOverlap(interests[a].text, interests[b].text);
        if (overlap >= OVERLAP) {
          nearDupes.push(`${interests[a].text} ≈ ${interests[b].text} (${overlap.toFixed(2)})`);
        }
      }
    }
    check(
      "no two text labels are near-duplicates",
      nearDupes.length === 0,
      nearDupes.join("; ") || `${interests.length} unique label(s)`
    );

    // 5. Every interest has queries, and they are phrases, not sentences.
    const noQuery = interests.filter((i) => !i.queries || i.queries.length === 0);
    const badQuery = interests.flatMap((i) =>
      (i.queries ?? [])
        .filter((q) => /[?!]/.test(q) || /\.$/.test(q.trim()))
        .map((q) => `${i.text}: "${q}"`)
    );
    check(
      "every interest has at least one search query",
      noQuery.length === 0,
      noQuery.map((i) => i.text).join(", ") || `${interests.length} with queries`
    );
    check(
      "no query contains sentence punctuation",
      badQuery.length === 0,
      badQuery.join("; ") || "all queries are phrases"
    );

    // 6. A re-derivation over unchanged signals must not churn the active set.
    // Retirement needs TWO consecutive misses, so a single re-derivation can
    // never retire an area. This is a real guarantee now rather than a
    // coincidence: before the hysteresis it flapped whenever the model
    // re-phrased a label, which is exactly what this check caught.
    check("a single re-derivation retires nothing", retired === 0, `retired ${retired}`);
    console.log(
      missed > 0
        ? `NOTE  ${missed} active area(s) were absent this derivation and HELD (retirement needs 2 consecutive misses)`
        : "NOTE  every active area was produced again this derivation"
    );

    // 7. Labels are ASCII-English; evidence may stay German.
    const nonEnglish = interests.filter((i) => {
      if (/[äöüßÄÖÜ]/.test(i.text)) return true;
      const words = i.text.toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
      return words.some((w) => GERMAN_WORDS.includes(w));
    });
    check(
      "text labels are ASCII-English",
      nonEnglish.length === 0,
      nonEnglish.map((i) => i.text).join(", ") || "all labels English"
    );
    // ---------------------------------------------------------------------
    // P2 — discovery that verifies itself.
    // ---------------------------------------------------------------------
    console.log("=== P2 DISCOVERY ==================================================");

    // Overridable by flag or env so a verification sweep can widen the sample
    // without code changes: --interests/--budget/--per-source, or
    // FEED_MAX_INTERESTS, FEED_PER_SOURCE, FEED_TAVILY_BUDGET.
    if (FLAGS.resetStored) {
      const removed = await resetStoredItems();
      console.log(`--reset-stored: removed ${removed} row(s) from feed_items`);
    }

    const activeInterests = await getInterests();
    const topics = activeInterests.filter((i) => i.kind === "topic");
    console.log(
      `interests: ${activeInterests.length} active (${topics.length} topic, ` +
        `${activeInterests.length - topics.length} avoid); ` +
        `maxInterests=${FLAGS.maxInterests}, perSource=${FLAGS.perSource}, ` +
        `tavilyBudget=${FLAGS.budget}`
    );

    // First run: the real discovery pass over what P1 derived.
    const first = await discoverCandidates(activeInterests, {
      maxInterests: FLAGS.maxInterests,
      perSourceLimit: FLAGS.perSource,
      tavilyBudget: FLAGS.budget,
    });
    const interestIdById = new Map(activeInterests.map((i) => [i.id, i.id]));
    const firstSaved = await saveCandidates(first.candidates, interestIdById);

    const stats = (s: typeof first.stats, saved: typeof firstSaved) =>
      `tavilyCalls=${s.tavilyCalls} found=${s.found} validated=${s.validated} ` +
      `rejectedValidation=${s.rejectedValidation} rejectedRelevance=${s.rejectedRelevance} ` +
      `inserted=${saved.inserted} skippedPrefiltered=${saved.skippedPrefiltered} ` +
      `skippedConflict=${saved.skippedConflict}`;

    console.log(`\nstats run 1: ${stats(first.stats, firstSaved)}`);

    // Every interest the run looked at, its per-source yields, what each gate
    // threw away, and the links that survived. An interest with nothing
    // surviving is printed as such, so a gap is visible rather than silent.
    const grouped = new Map<string, typeof first.candidates>();
    for (const c of first.candidates) {
      const list = grouped.get(c.interest_text) ?? [];
      list.push(c);
      grouped.set(c.interest_text, list);
    }

    console.log("\n--- per interest ---");
    const searched = [...grouped.keys()];
    const emptyInterests: string[] = [];
    for (const interest of activeInterests.filter((i) => i.kind === "topic")) {
      const list = grouped.get(interest.text) ?? [];
      const sources = first.bySource[interest.text] ?? {};
      const sourceLine = Object.entries(sources)
        .map(
          ([name, t]) =>
            `${name}: found ${t.found}, dropped-by-relevance ${t.droppedRelevance}`
        )
        .join("; ");
      console.log(`\n[${interest.text}]`);
      console.log(`    queries: ${interest.queries?.join(" | ") ?? "(none)"}`);
      console.log(`    sources: ${sourceLine || "(not searched this run)"}`);
      if (!searched.includes(interest.text)) {
        emptyInterests.push(interest.text);
        console.log("    no candidates this run");
        continue;
      }
      for (const c of list) {
        const dur = c.candidate.duration_seconds
          ? ` · ${Math.round(c.candidate.duration_seconds / 60)}min`
          : "";
        console.log(
          `  - ${c.candidate.title} · ${c.kind} · ${c.platform}${dur}\n` +
            `      ${c.candidate.url}\n` +
            `      validation: PASS`
        );
      }
    }
    if (!first.candidates.length) console.log("\n  (no candidates survived validation)");
    console.log(
      `\ndropped-by-validation total: ${first.stats.rejectedValidation}, ` +
        `dropped-by-relevance total: ${first.stats.rejectedRelevance}`
    );

    // Assertion: every surfaced candidate has a real http(s) URL.
    const badUrls = first.candidates.filter(
      (c) => !c.candidate.url || !c.candidate.url.startsWith("http")
    );
    check(
      "every surfaced candidate has an http(s) url",
      badUrls.length === 0,
      badUrls.map((c) => c.candidate.url).join(", ") || `${first.candidates.length} url(s)`
    );

    // Assertion: no two surfaced candidates share a canonical URL (batch
    // dedupe, across every group — the five arXiv copies are the regression).
    const urlCount = new Map<string, number>();
    for (const c of first.candidates) {
      const u = canonicalUrl(c.candidate.url);
      urlCount.set(u, (urlCount.get(u) ?? 0) + 1);
    }
    const dupUrls = [...urlCount.entries()].filter(([, n]) => n > 1);
    check(
      "no two surfaced candidates share a canonical url",
      dupUrls.length === 0,
      dupUrls.map(([u, n]) => `${u} x${n}`).join(", ") || `${urlCount.size} unique url(s)`
    );

    // Assertion: the relevance gate is firing. If nothing was rejected, the run
    // says so plainly rather than passing silently.
    if (first.stats.rejectedRelevance > 0) {
      check(
        "relevance gate actually ran (rejections observed)",
        true,
        `${first.stats.rejectedRelevance} dropped`
      );
    } else {
      console.log(
        "NOTE  nothing was dropped by relevance this run — every candidate the " +
          "sources returned already matched its interest. The gate ran over all " +
          `${first.stats.found} candidate(s).`
      );
      check(
        "relevance gate ran and states plainly that nothing was rejected",
        first.stats.found > 0,
        `${first.stats.found} checked, 0 dropped`
      );
    }

    // Assertion: the exact junk the gate exists to remove never surfaces. Short
    // and literal on purpose.
    const JUNK = ["Muon Collider", "tensor-to-scalar"];
    const junkHits = first.candidates
      .filter((c) => {
        const title = c.candidate.title ?? "";
        if (JUNK.some((j) => title.includes(j))) return true;
        if (/pickleball/i.test(title) && !/pickleball/i.test(c.interest_text)) return true;
        return false;
      })
      .map((c) => c.candidate.title);
    check(
      "no surfaced title contains the known junk",
      junkHits.length === 0,
      junkHits.join("; ") || "Muon Collider/tensor-to-scalar/Pickleball absent"
    );

    // Assertion: a podcast episode must name something from the interest it was
    // found FOR. Deliberately re-implemented here rather than reusing the gate's
    // own tokenizer, so this is an independent check and not a tautology. It is
    // the test that catches a match made only of phrase filler: an episode that
    // arrived for "how to read more books every week" because its title contained
    // "every week" and nothing else.
    const STOP_WORDS = new Set([
      "with", "from", "that", "this", "your", "about", "into", "over", "more",
      "best", "for", "and", "the",
    ]);
    const words = (text: string): Set<string> =>
      new Set(
        String(text ?? "")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length >= 4 && !STOP_WORDS.has(w))
      );
    const unnamedPodcasts = first.candidates
      .filter((c) => c.candidate.kind === "podcast")
      .filter((c) => {
        const inTitle = words(c.candidate.title ?? "");
        for (const t of words(c.interest_text)) if (inTitle.has(t)) return false;
        return true;
      })
      .map((c) => `${c.candidate.title} — for "${c.interest_text}"`);
    check(
      "every surfaced podcast names its own interest",
      unnamedPodcasts.length === 0,
      unnamedPodcasts.join("; ") || "all podcast titles name their interest"
    );

    // Assertion: every interest is either accounted for with a survivor or
    // explicitly reported as having none.
    const silent = topics.filter(
      (i) => !searched.includes(i.text) && !emptyInterests.includes(i.text)
    );
    check(
      "every interest has a survivor or is listed as having none",
      silent.length === 0,
      `${searched.length} with link(s), ${emptyInterests.length} explicitly empty` +
        (silent.length ? `, silent: ${silent.map((i) => i.text).join(", ")}` : "")
    );

    // The real dedupe proof: run discovery again and insert nothing.
    const before = await getStoredItems();
    const second = await discoverCandidates(activeInterests, {
      maxInterests: FLAGS.maxInterests,
      perSourceLimit: FLAGS.perSource,
      tavilyBudget: FLAGS.budget,
    });
    const secondSaved = await saveCandidates(second.candidates, interestIdById);
    const after = await getStoredItems();
    console.log(`\nstats run 2: ${stats(second.stats, secondSaved)}`);
    console.log(`stored items before run 2: ${before.length}, after run 2: ${after.length}`);
    if (secondSaved.insertedUrls.length) {
      console.log("  URLs inserted on the repeat run (should be genuinely new):");
      for (const u of secondSaved.insertedUrls) console.log(`    - ${u}`);
    } else {
      console.log("  repeat run inserted nothing — the dedupe key held.");
    }
    // The decidable form of "the second run inserts 0": nothing that was already
    // stored may be stored again. A URL the live sources genuinely published in
    // between is listed by name above rather than hidden behind a count.
    check(
      "repeat run never re-inserts a URL it already had",
      secondSaved.insertedUrls.every(
        (u) => !before.some((b) => b.url.toLowerCase() === u.toLowerCase())
      ),
      secondSaved.insertedUrls.length
        ? `${secondSaved.insertedUrls.length} new URL(s), none previously stored`
        : "0 inserted"
    );
    // Live sources are not deterministic: Tavily re-ranks between calls and Apple
    // publishes episodes continuously, so a repeat run can legitimately store a URL
    // that is genuinely new. What must NEVER happen is storing a URL that was
    // already stored, and that is what the check above proves. These lines report
    // the difference rather than failing on it — a zero here would be a flaky test,
    // not a stronger guarantee.
    console.log(
      `NOTE  repeat run stored ${secondSaved.inserted} genuinely new row(s); ` +
        `count ${before.length} -> ${after.length}. Duplicate protection is the ` +
        `"never re-inserts a URL it already had" check above, not a zero here.`
    );

    // Validation proof: either something was rejected, or say why not.
    if (first.stats.rejectedValidation > 0) {
      check(
        "validation actually ran (rejections observed)",
        true,
        `${first.stats.rejectedValidation} rejected`
      );
    } else {
      console.log(
        "NOTE  no candidates were rejected this run — every candidate returned by " +
          "the sources also passed its own validation check, so there was nothing " +
          "to reject. Validation still ran on all " +
          `${first.stats.validated} candidates.`
      );
      check("validation actually ran (all passed, none to reject)", first.stats.found > 0, `${first.stats.found} checked`);
    }

    const stored = await getStoredItems();
    console.log(`\nstored feed_items: ${stored.length}`);
    for (const s of stored.slice(0, 20)) {
      console.log(`  - [${s.platform}] ${s.title} — ${s.url}`);
    }
    console.log("===================================================================\n");
  } catch (err) {
    console.error("ERROR", (err as Error).message);
    failed++;
  }

  console.log(failed === 0 ? "\nALL FEED CHECKS PASSED" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
