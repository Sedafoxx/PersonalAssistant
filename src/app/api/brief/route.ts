import { NextResponse } from "next/server";
import { buildDailyBrief, formatBriefText } from "@/lib/brief";

export const dynamic = "force-dynamic";

// The opening brief for a fresh chat: the state of the world in a dozen lines.
//
// READ-ONLY, and deliberately so. There is no model call here and no write —
// the route only reads loops, commitments and the last review, so the chat can
// open instantly (and for free) with something true. Anything that needs a
// judgement belongs to the conversation, not to the greeting.
export async function GET() {
  try {
    const parts = await buildDailyBrief();
    const text = formatBriefText(parts);
    return NextResponse.json({
      brief: { ...parts, text, hasContent: text.length > 0 },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
