import { NextResponse } from "next/server";
import { latestReview, runNightlyReview } from "@/lib/review";

export const dynamic = "force-dynamic";

// The nightly review, and the fifth cron entry (02:00).
//
// GET is deliberately READ-ONLY: it returns the latest stored review and never
// runs one. The cron path is GET, so this is what the 02:00 schedule hits, and a
// read-only GET means the schedule can be fired by hand (or by a browser) to
// inspect last night's report without spending an LLM call or rewriting a single
// topic summary.
//
// POST is the run. It is the manual trigger, and the only path that writes.

// GET /api/review — the latest stored review. `review: null` means none has been
// written yet (the table is empty, or the migration has not been applied); it is
// not an error, so the caller can render "no review yet" rather than a failure.
export async function GET() {
  try {
    return NextResponse.json({ review: await latestReview() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/review — run one nightly review now. runNightlyReview never throws;
// a failed night comes back as a review with a skippedReason and HTTP 200, which
// is the honest report.
export async function POST() {
  try {
    return NextResponse.json({ review: await runNightlyReview() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
