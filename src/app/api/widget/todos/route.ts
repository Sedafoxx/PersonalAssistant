import { NextRequest, NextResponse } from "next/server";
import { getItems } from "@/lib/db";

// Lightweight, read-only endpoint for the Android KWGT home-screen widget (and
// any other external client). Requires ?token=<WIDGET_TOKEN> so todos are not
// publicly exposed.
//
//   Text is the default (the KWGT widget fetches with $wg()$ and displays it
//   directly — no parsing needed). Pass ?format=json for a structured payload.
//
// Items are active (open) todos/notes/ideas, highest priority first.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.WIDGET_TOKEN;
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const format = req.nextUrl.searchParams.get("format") ?? "text";

  try {
    const all = await getItems({ status: "active" });
    const items = all
      .slice()
      .sort((a, b) => {
        // Priority 1 = most important (matches the app's own sort).
        if (a.priority !== b.priority) return a.priority - b.priority;
        // Then earliest due date first; items without a due date go last.
        const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
        const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
        return da - db;
      })
      .slice(0, 20);

    if (format === "text") {
      const lines: string[] = [
        `${items.length} open todo${items.length === 1 ? "" : "s"}`,
      ];
      if (items.length > 0) lines.push("");
      for (const it of items) {
        let line = it.title;
        if (it.due_date) {
          const d = new Date(it.due_date);
          if (!Number.isNaN(d.getTime())) {
            line += ` (${d.toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
            })})`;
          }
        }
        lines.push(line);
      }
      return new NextResponse(lines.join("\n"), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    return NextResponse.json({
      fetched_at: new Date().toISOString(),
      count: items.length,
      items: items.map((it) => ({
        id: it.id,
        type: it.type,
        title: it.title,
        priority: it.priority,
        due_date: it.due_date,
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
