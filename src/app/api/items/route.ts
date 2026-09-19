import { NextRequest, NextResponse } from "next/server";
import { getItems, createItem, type ItemType, type ItemStatus, type SortBy } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  try {
    const hasPlanParam = searchParams.get("has_plan");
    const statusParam = searchParams.get("status") as ItemStatus | null;
    const items = await getItems({
      type: searchParams.get("type") as ItemType | undefined ?? undefined,
      // No status given → "everything that is not archived and not RESOLVED".
      //
      // Not status=active, because a finished task should stay visible for the
      // rest of the day it was finished on: the crossed-out row is the day's
      // progress, and a mis-tick has to be undoable. What the user asked to stop
      // seeing is the PILE — finished work that had been sitting in the list for
      // days. That is exactly what resolution means, so the default excludes
      // resolved rows and the sweep puts them away the next morning. 57 of 113
      // rows were such a pile. An explicit ?status=... still gets exactly what it
      // asks for, history included.
      status: statusParam ?? undefined,
      unresolved: statusParam === null,
      sort_by: searchParams.get("sort_by") as SortBy | undefined ?? undefined,
      query: searchParams.get("q") ?? undefined,
      planned_for: searchParams.get("planned_for") ?? undefined,
      has_plan:
        hasPlanParam === null ? undefined : hasPlanParam === "true" || hasPlanParam === "1",
    });
    return NextResponse.json(items);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const item = await createItem(body);
    return NextResponse.json(item, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
