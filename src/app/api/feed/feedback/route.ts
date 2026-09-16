import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// One tap on an item (P3b).
//
// The user's answer is recorded in `feed_feedback` — the permanent memory that
// keeps an answered link from resurfacing — and the item's own status moves to
// match. NOTHING is ever deleted: `hidden` is a status, not a removal, so a
// "not for me" is remembered against that exact URL for good while the row,
// its title and its history stay inspectable.

const SIGNALS = ["save", "not_for_me", "done"] as const;
type Signal = (typeof SIGNALS)[number];

// The status an item takes on for each signal. A "not for me" is `hidden`, and
// buildShortlist() only ever loads `status='new'`, so the two together are what
// make the answer stick.
const STATUS_FOR: Record<Signal, string> = {
  save: "saved",
  not_for_me: "hidden",
  done: "done",
};

const ITEM_COLS =
  "id,url,kind,platform,title,summary,creator,published_at,duration_seconds,image_url,validated,matched_interest_id,status,surfaced_day,created_at,updated_at";

export async function POST(req: Request) {
  let body: { item_id?: unknown; signal?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const itemId = String(body.item_id ?? "").trim();
  const signal = String(body.signal ?? "").trim();

  // Validate the signal against the allowed set BEFORE touching the database:
  // the check constraint would otherwise surface as an opaque 500.
  if (!(SIGNALS as readonly string[]).includes(signal)) {
    return NextResponse.json(
      { error: `signal must be one of ${SIGNALS.join(", ")}` },
      { status: 400 }
    );
  }
  if (!itemId) {
    return NextResponse.json({ error: "item_id is required" }, { status: 400 });
  }

  const typed = signal as Signal;

  try {
    const db = createServiceClient();

    // The item must exist, and this is also what tells a stale tap apart from a
    // real one.
    const { data: existing, error: readErr } = await db
      .from("feed_items")
      .select(ITEM_COLS)
      .eq("id", itemId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!existing) {
      return NextResponse.json({ error: "item not found" }, { status: 404 });
    }

    const { error: fbErr } = await db
      .from("feed_feedback")
      .insert({ item_id: itemId, signal: typed });
    if (fbErr) throw new Error(fbErr.message);

    const { data: updated, error: upErr } = await db
      .from("feed_items")
      .update({ status: STATUS_FOR[typed], updated_at: new Date().toISOString() })
      .eq("id", itemId)
      .select(ITEM_COLS)
      .maybeSingle();
    if (upErr) throw new Error(upErr.message);

    // The feedback row is the durable record; if the status write did not come
    // back with a row, return what was read so the client still has the item.
    return NextResponse.json({ item: updated ?? existing, signal: typed });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
