// Fill in the text that stored feed items never captured.
//
// Run: npm run feed:describe
//
// WHY: podcast rows created before the episode description was captured have none,
// and a card with no text is a door, not a post — the first screen of the new scroll
// was six podcasts in a row with nothing to read. One or two Spotify calls fix the
// whole library, because /episodes accepts 50 ids per request.
//
// Idempotent: it only ever looks at rows whose summary is still null.

import { backfillFeedDescriptions } from "../src/lib/feed";

async function main(): Promise<void> {
  const result = await backfillFeedDescriptions();
  console.log(`Checked: ${result.checked}`);
  console.log(`Updated: ${result.updated}`);
  console.log(result.detail);
}

main().catch((err) => {
  console.error("backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
