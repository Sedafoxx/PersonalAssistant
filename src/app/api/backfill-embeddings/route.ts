import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { embed, itemText } from "@/lib/embeddings";

// One-time (idempotent) backfill: embed any items missing an embedding.
// POST to run. Safe to re-run — only touches rows where embedding is null.
export async function POST() {
  const db = createServiceClient();
  const { data, error } = await db
    .from("items")
    .select("id,title,content")
    .is("embedding", null);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let embedded = 0;
  for (const item of data ?? []) {
    const embedding = await embed(itemText(item.title, item.content));
    const { error: upErr } = await db
      .from("items")
      .update({ embedding })
      .eq("id", item.id);
    if (upErr)
      return NextResponse.json(
        { error: upErr.message, embedded },
        { status: 500 }
      );
    embedded++;
  }

  return NextResponse.json({ success: true, embedded });
}
