import { NextRequest, NextResponse } from "next/server";
import {
  planDay,
  applyPlan,
  getCheckin,
  localDay,
  type PlanBlock,
} from "@/lib/coach";

// GET /api/coach/plan-day?day=YYYY-MM-DD&fresh=1
//   Returns today's plan (stored on the day's morning check-in). Generates one
//   if missing or fresh=1.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const day = sp.get("day") || localDay();
  const fresh = sp.get("fresh") === "1";

  try {
    if (!fresh) {
      const existing = await getCheckin("morning", day);
      if (existing?.plan) {
        return NextResponse.json({ plan: existing.plan, generated: false });
      }
    }
    const plan = await planDay(day);
    return NextResponse.json({ plan, generated: true });
  } catch (err) {
    console.error("plan-day GET error", err);
    return NextResponse.json({ error: "Could not plan day" }, { status: 500 });
  }
}

// POST /api/coach/plan-day
//   body { day, blocks: PlanBlock[], asCalendar?, asTodos? }
//   Applies selected plan blocks to the real Google Calendar and/or todos.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      day?: string;
      blocks?: PlanBlock[];
      asCalendar?: boolean;
      asTodos?: boolean;
    };
    const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
      ? body.day
      : localDay();
    const blocks = Array.isArray(body.blocks) ? body.blocks.filter((b) => b?.title) : [];
    if (blocks.length === 0) {
      return NextResponse.json({ error: "No blocks selected" }, { status: 400 });
    }
    const result = await applyPlan({
      day,
      blocks,
      asCalendar: body.asCalendar !== false,
      asTodos: !!body.asTodos,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("plan-day POST error", err);
    return NextResponse.json({ error: "Could not apply plan" }, { status: 500 });
  }
}
