import { NextRequest, NextResponse } from "next/server";
import { getItems } from "@/lib/db";

// Lightweight, read-only endpoint for the Android KWGT home-screen widget (and
// any other external client). Requires ?token=<WIDGET_TOKEN> so todos are not
// publicly exposed.
//
//   Text is the default (the KWGT widget fetches with $wg()$ and displays it
//   directly — no parsing needed). Pass ?format=json for a structured payload.
//
// Items are active (open) todos only (no ideas/notes), highest priority first.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const expected = process.env.WIDGET_TOKEN;
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const format = req.nextUrl.searchParams.get("format") ?? "text";

  try {
    const all = await getItems({ status: "active", type: "todo" });
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

    if (format === "html") {
      // Pretty, mobile-friendly page for a simple WebView home-screen widget —
      // no KWGT formulas required. Titles are escaped to keep it safe.
      const esc = (s: string) =>
        s.replace(/[&<>"]/g, (c) => {
          const entity: Record<string, string> = {
            "&": "amp;",
            "<": "lt;",
            ">": "gt;",
            '"': "quot;",
          };
          return "&" + entity[c];
        });
      const rows = items
        .map((it, i) => {
          let due = "";
          if (it.due_date) {
            const d = new Date(it.due_date);
            if (!Number.isNaN(d.getTime())) {
              due = ` (${d.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })})`;
            }
          }
          return `<li style="display:flex;gap:10px;align-items:baseline;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.06)"><span style="color:#6366f1;font-weight:700;flex:0 0 auto">${i + 1}</span><span style="color:#e5e7eb;font-size:15px;line-height:1.45;word-break:break-word">${esc(it.title)}${due ? `<span style="color:#9ca3af;font-size:12px">${esc(due)}</span>` : ""}</span></li>`;
        })
        .join("");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Nova — Todos</title></head><body style="margin:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:16px;color:#e5e7eb"><div style="max-width:560px;margin:0 auto"><h1 style="font-size:15px;font-weight:700;color:#fff;margin:0 0 2px">Nova</h1><p style="margin:0 0 8px;color:#9ca3af;font-size:13px">${items.length} open todo${items.length === 1 ? "" : "s"}</p><ul style="list-style:none;margin:0;padding:0">${rows || "<li style='color:#6b7280;font-size:14px'>All done 🎉</li>"}</ul></div></body></html>`;
      return new NextResponse(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
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
