import { NextRequest, NextResponse } from "next/server";
import { getCoachMemories, addCoachMemory, type MemoryKind } from "@/lib/coach";

// GET  /api/coach/memory          → the coach's long-term memory "backlog"
// POST /api/coach/memory { text, kind?, category? } → add a memory manually
export async function GET() {
  try {
    const memories = await getCoachMemories(80);
    return NextResponse.json({ memories });
  } catch (err) {
    console.error("coach memory GET error", err);
    return NextResponse.json({ error: "Failed to load memory" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      text?: string;
      kind?: string;
      category?: string | null;
    };
    const KINDS: MemoryKind[] = ["fact", "person", "preference", "decision", "win", "pattern", "goal_note"];
    const kind = KINDS.includes(body.kind as MemoryKind) ? (body.kind as MemoryKind) : "fact";
    const row = await addCoachMemory(String(body.text ?? ""), kind, {
      category: body.category ?? null,
      source: "manual",
      pinned: true,
    });
    return NextResponse.json({ ok: true, memory: row });
  } catch (err) {
    console.error("coach memory POST error", err);
    return NextResponse.json({ error: "Failed to save memory" }, { status: 500 });
  }
}
