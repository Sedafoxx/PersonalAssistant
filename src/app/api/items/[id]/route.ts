import { NextRequest, NextResponse } from "next/server";
import { updateItem, deleteItem, type UpdateItemInput } from "@/lib/db";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = (await req.json()) as UpdateItemInput;
    // Whitelist the patchable fields (including the five new day-planning
    // fields) so a caller can never rewrite arbitrary columns. updateItem()
    // keeps owning the XP-on-completion behaviour when status → done.
    const patch: UpdateItemInput = {};
    if (body.type !== undefined) patch.type = body.type;
    if (body.title !== undefined) patch.title = body.title;
    if (body.content !== undefined) patch.content = body.content;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.status !== undefined) patch.status = body.status;
    if (body.tags !== undefined) patch.tags = body.tags;
    if (body.due_date !== undefined) patch.due_date = body.due_date;
    if (body.notification_time !== undefined) patch.notification_time = body.notification_time;
    if (body.planned_for !== undefined) patch.planned_for = body.planned_for;
    if (body.planned_time !== undefined) patch.planned_time = body.planned_time;
    if (body.day_order !== undefined) patch.day_order = body.day_order;
    if (body.required !== undefined) patch.required = body.required;
    if (body.goal_id !== undefined) patch.goal_id = body.goal_id;

    const item = await updateItem(id, patch);
    return NextResponse.json(item);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteItem(id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
