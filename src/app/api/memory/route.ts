import { NextRequest, NextResponse } from "next/server";
import {
  getTopics,
  getActiveFacts,
  getFactsIncludingHistory,
  getPendingRemovals,
  setFactValueByHand,
  setFactPinned,
  setFactStatus,
  type FactStatus,
} from "@/lib/memory";

export const dynamic = "force-dynamic";

// The human-override surface for living memory.
//
// The assistant may add and update facts, but it may never delete them, so this
// route deliberately exposes no hard delete: "removing" a fact is a status
// change that keeps the row for history. The "What I remember" panel (Stats tab)
// uses this to let the user edit a value, pin a fact so the AI stops overwriting
// it, retire a fact, and resolve (or reject) a removal the assistant proposed.
//
// This is separate from /api/coach/memory, which serves the older free-text
// memory store.

const STATUSES: FactStatus[] = ["active", "superseded", "pending_removal"];

// GET /api/memory              -> { topics, facts, pending }
// GET /api/memory?topic_id=<id> -> the above plus { history }, the active AND
//   superseded rows for that topic, so the UI can show what an update replaced
//   instead of hiding it. Updating is reversible, and this is what proves it.
export async function GET(req: NextRequest) {
  const topicId = new URL(req.url).searchParams.get("topic_id");
  try {
    const [topics, facts, pending] = await Promise.all([
      getTopics(),
      getActiveFacts(),
      getPendingRemovals(),
    ]);
    if (topicId) {
      const history = await getFactsIncludingHistory(topicId);
      return NextResponse.json({ topics, facts, pending, history });
    }
    return NextResponse.json({ topics, facts, pending });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// PATCH /api/memory -> { id, value? , pinned? , status? }
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      id?: string;
      value?: string;
      pinned?: boolean;
      status?: string;
    };

    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

    let updated = 0;

    if (typeof body.value === "string" && body.value.trim()) {
      await setFactValueByHand(id, body.value.trim());
      updated++;
    }
    if (typeof body.pinned === "boolean") {
      await setFactPinned(id, body.pinned);
      updated++;
    }
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status as FactStatus)) {
        return NextResponse.json(
          { error: `status must be one of ${STATUSES.join(", ")}` },
          { status: 400 }
        );
      }
      await setFactStatus(id, body.status as FactStatus);
      updated++;
    }

    if (updated === 0) {
      return NextResponse.json(
        { error: "nothing to update: pass value, pinned or status" },
        { status: 400 }
      );
    }

    const [topics, facts, pending] = await Promise.all([
      getTopics(),
      getActiveFacts(),
      getPendingRemovals(),
    ]);
    return NextResponse.json({ topics, facts, pending });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

// DELETE is intentionally not implemented: the fact store archives by status so
// an update is always reversible and history survives.
export async function DELETE() {
  return NextResponse.json(
    {
      error:
        "Facts are archived, not deleted. PATCH { status: \"superseded\" } to retire one, or { status: \"pending_removal\" } to propose it.",
    },
    { status: 405 }
  );
}
