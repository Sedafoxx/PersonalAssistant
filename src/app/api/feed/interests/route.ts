import { NextResponse } from "next/server";
import { getInterests, deriveInterests } from "@/lib/feed";
import { createServiceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// The fit surface for Nova's feed (P1).
//
// GET returns every derived interest, INCLUDING inactive ones, so an interest
// the user removed stays visible and inspectable instead of silently vanishing
// — the same "archive, never hide" stance as /api/memory.
//
// POST is the manual "work out what fits me" trigger: it re-reads the user's
// own signals, derives interests from them, and upserts the result. It never
// deletes and never touches an interest the user added or removed by hand.
export async function GET() {
  try {
    const interests = await getInterests(false);
    return NextResponse.json({ interests });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST() {
  try {
    const { interests, created, updated } = await deriveInterests();
    return NextResponse.json({ interests, created, updated });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH is the Feed tab's single "remove this interest" action (P4).
//
// It sets `active` to false and NEVER deletes the row: the interest, its
// evidence and its history stay inspectable, and getInterests() simply stops
// returning it to the discovery pool. A re-derivation may reactivate a row it
// still derives, which is why the removal is a toggle of the model's own
// suggestion rather than a permanent tombstone.
export async function PATCH(req: Request) {
  let body: { id?: unknown; active?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const id = String(body.id ?? "").trim();
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  // Only the deactivation is exposed here: an interest is removed, never
  // hand-edited back on through this route.
  const active = body.active === undefined ? false : Boolean(body.active);

  try {
    const db = createServiceClient();
    const { data, error } = await db
      .from("feed_interests")
      .update({ active, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id,slug,text,kind,weight,queries,evidence,source,active,created_at,updated_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      return NextResponse.json({ error: "interest not found" }, { status: 404 });
    }
    return NextResponse.json({ interest: data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
