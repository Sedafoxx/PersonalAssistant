import { NextRequest, NextResponse } from "next/server";
import { readFeedItemText } from "@/lib/feed";

export const dynamic = "force-dynamic";

// GET /api/feed/text?id=<feed_items.id>
//
// The text to READ, for the in-app reader. Fetched on open and kept, so opening the
// same item twice costs one request total. `source` says where the text came from
// and the UI reports it honestly: a snippet from a paywalled page is not the same
// thing as the article, and the reader says so instead of pretending.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }
  try {
    const result = await readFeedItemText(id);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
