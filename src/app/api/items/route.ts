import { NextRequest, NextResponse } from "next/server";
import { getItems, createItem, type ItemType, type ItemStatus, type SortBy } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  try {
    const items = await getItems({
      type: searchParams.get("type") as ItemType | undefined ?? undefined,
      status: searchParams.get("status") as ItemStatus | undefined ?? undefined,
      sort_by: searchParams.get("sort_by") as SortBy | undefined ?? undefined,
      query: searchParams.get("q") ?? undefined,
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
