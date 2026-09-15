import { NextRequest, NextResponse } from "next/server";
import {
  getMilestones,
  createMilestone,
  reorderMilestones,
} from "@/lib/milestones";

// GET /api/milestones?goal_id=  → Milestone[] (all when goal_id omitted)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const goalId = searchParams.get("goal_id") ?? undefined;
  try {
    const milestones = await getMilestones(goalId);
    return NextResponse.json(milestones);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/milestones  body { goal_id, title, target_date? }
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      goal_id?: string;
      title?: string;
      target_date?: string;
    };
    if (!body.goal_id) {
      return NextResponse.json({ error: "goal_id is required" }, { status: 400 });
    }
    if (!body.title || !body.title.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }
    const milestone = await createMilestone({
      goal_id: body.goal_id,
      title: body.title.trim(),
      target_date: body.target_date ?? null,
    });
    return NextResponse.json(milestone, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH /api/milestones  body { goal_id, orderedIds: string[] } → reorder
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { goal_id?: string; orderedIds?: string[] };
    if (!body.goal_id || !Array.isArray(body.orderedIds)) {
      return NextResponse.json(
        { error: "goal_id and orderedIds are required" },
        { status: 400 }
      );
    }
    await reorderMilestones(body.goal_id, body.orderedIds);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
