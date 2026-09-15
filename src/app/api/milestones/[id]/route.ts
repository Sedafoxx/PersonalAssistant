import { NextRequest, NextResponse } from "next/server";
import {
  toggleMilestone,
  updateMilestone,
  deleteMilestone,
} from "@/lib/milestones";

// PATCH /api/milestones/[id]  body { done?: boolean, title?, target_date? }
//   `done` present → toggleMilestone, otherwise → updateMilestone.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Next.js 15: params is a Promise and must be awaited.
    const { id } = await params;
    const body = (await req.json()) as {
      done?: boolean;
      title?: string;
      target_date?: string | null;
    };

    if (typeof body.done === "boolean") {
      const milestone = await toggleMilestone(id, body.done);
      return NextResponse.json(milestone);
    }

    const milestone = await updateMilestone(id, {
      title: body.title,
      target_date: body.target_date,
    });
    return NextResponse.json(milestone);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// DELETE /api/milestones/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await deleteMilestone(id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
