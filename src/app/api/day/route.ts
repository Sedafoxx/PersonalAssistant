import { NextRequest, NextResponse } from "next/server";
import {
  getDay,
  addDayTask,
  updateDayTask,
  reorderDay,
  isDayString,
  localDay,
  type UpdateDayTaskInput,
} from "@/lib/day";

// GET /api/day?date=YYYY-MM-DD  → DayView (default today)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date") ?? undefined;
  if (date !== undefined && !isDayString(date)) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }
  try {
    const view = await getDay(date);
    return NextResponse.json(view);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/day  body { title, priority?, required?, planned_time?, goal_id?, planned_for? }
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title?: string;
      priority?: number;
      required?: boolean;
      planned_time?: string;
      goal_id?: string;
      planned_for?: string;
    };
    if (!body.title || !body.title.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }
    if (body.planned_for !== undefined && !isDayString(body.planned_for)) {
      return NextResponse.json({ error: "Invalid date" }, { status: 400 });
    }
    const item = await addDayTask({
      title: body.title.trim(),
      priority: body.priority,
      required: body.required,
      planned_time: body.planned_time,
      goal_id: body.goal_id,
      planned_for: body.planned_for,
    });
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH /api/day  body { order: string[], date? } → reorder
//             or  body { id, ...patch }            → updateDayTask
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as
      | { order?: string[]; date?: string }
      | ({ id?: string } & UpdateDayTaskInput);

    if (Array.isArray((body as { order?: string[] }).order)) {
      const { order, date } = body as { order: string[]; date?: string };
      if (date !== undefined && !isDayString(date)) {
        return NextResponse.json({ error: "Invalid date" }, { status: 400 });
      }
      await reorderDay(isDayString(date) ? date : localDay(), order);
      return NextResponse.json({ success: true });
    }

    const { id, ...patch } = body as { id?: string } & UpdateDayTaskInput;
    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }
    const item = await updateDayTask(id, patch);
    return NextResponse.json(item);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
