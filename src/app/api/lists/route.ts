import { NextRequest, NextResponse } from "next/server";
import {
  getList,
  addToList,
  removeById,
  setChecked,
  clearChecked,
  type ListKind,
} from "@/lib/lists";

const VALID: ListKind[] = ["grocery", "shopping"];

function parseList(v: string | null): ListKind | null {
  return v && (VALID as string[]).includes(v) ? (v as ListKind) : null;
}

// GET /api/lists?list=grocery
export async function GET(req: NextRequest) {
  const list = parseList(new URL(req.url).searchParams.get("list"));
  if (!list) return NextResponse.json({ error: "invalid list" }, { status: 400 });
  try {
    return NextResponse.json(await getList(list));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// POST /api/lists  { list, name }
export async function POST(req: NextRequest) {
  try {
    const { list, name } = await req.json();
    if (!parseList(list)) return NextResponse.json({ error: "invalid list" }, { status: 400 });
    const result = await addToList(list, String(name ?? ""));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH /api/lists  { id, checked }
export async function PATCH(req: NextRequest) {
  try {
    const { id, checked } = await req.json();
    const item = await setChecked(String(id), Boolean(checked));
    return NextResponse.json(item);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// DELETE /api/lists?id=<uuid>           → remove one
// DELETE /api/lists?list=grocery&clearChecked=1 → remove all checked
export async function DELETE(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  try {
    if (sp.get("clearChecked")) {
      const list = parseList(sp.get("list"));
      if (!list) return NextResponse.json({ error: "invalid list" }, { status: 400 });
      const removed = await clearChecked(list);
      return NextResponse.json({ removed });
    }
    const id = sp.get("id");
    if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });
    await removeById(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
