import { NextRequest, NextResponse } from "next/server";
import {
  coachReply,
  getCheckin,
  saveCheckin,
  getMoodHistory,
  getDailyWins,
  localDay,
  type CheckinKind,
  type CheckinStatus,
} from "@/lib/coach";
import { getReflection, upsertReflection } from "@/lib/reflection";

// GET /api/coach/checkin?kind=morning|evening&day=YYYY-MM-DD&fresh=1
//   - Returns the day's check-in row if it exists.
//   - If none (or fresh=1), generates a fresh coach prompt (greeting + question
//     + ONE next action) and persists it as a draft.
//   - Also returns the mood sparkline + goals so the UI can render.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kindRaw = sp.get("kind");
  const kind: CheckinKind = kindRaw === "evening" ? "evening" : "morning";
  const day = sp.get("day") || localDay();
  const fresh = sp.get("fresh") === "1";

  try {
    let checkin = await getCheckin(kind, day);
    let generated = false;

    if (!checkin || fresh) {
      // Yesterday's evening reflection (if any) feeds adaptation.
      let yesterdayHint: string | null = null;
      try {
        const prevDay = new Date(day + "T00:00:00Z");
        prevDay.setUTCDate(prevDay.getUTCDate() - 1);
        const y = await getReflection(prevDay.toISOString().slice(0, 10));
        if (y && (y.went_well || y.could_improve)) {
          yesterdayHint = [
            y.went_well ? `Went well: ${y.went_well}` : "",
            y.could_improve ? `Could improve: ${y.could_improve}` : "",
          ]
            .filter(Boolean)
            .join(" · ");
        }
      } catch {
        // ignore
      }

      const result = await coachReply(kind, {
        mood: checkin?.mood ?? undefined,
        focus: checkin?.focus ?? undefined,
        yesterday: yesterdayHint ?? undefined,
      });

      checkin = await saveCheckin({
        kind,
        day,
        question: result.reply,
        next_action: result.next_action.headline || null,
        next_action_domain: result.next_action.domain || "other",
        next_action_goal: result.next_action.goal,
        next_action_due: result.next_action.due,
        status: "proposed",
      });
      generated = true;
    }

    const [moodHistory, evening, wins] = await Promise.all([
      getMoodHistory(14),
      kind === "morning" ? getCheckin("evening", day) : Promise.resolve(null),
      getDailyWins(day).catch(() => null),
    ]);

    return NextResponse.json({
      checkin,
      generated,
      moodHistory,
      wins,
      // For morning: is today's evening reflection already done? (shows balance)
      eveningToday: kind === "morning" ? evening : null,
    });
  } catch (err) {
    console.error("coach GET error", err);
    return NextResponse.json({ error: "Coach failed" }, { status: 500 });
  }
}

// POST /api/coach/checkin — save user responses / resolve the proposed action.
// Body: { kind, day, mood?, energy?, focus?, answer?, went_well?, could_improve?,
//         status? ("done"|"skipped"|"failed"), feedback? }
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const kind: CheckinKind = body.kind === "evening" ? "evening" : "morning";
    const day = typeof body.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
      ? body.day
      : localDay();

    const mood = body.mood == null ? undefined : clampInt(body.mood, 1, 5);
    const energy = body.energy == null ? undefined : clampInt(body.energy, 1, 5);
    const status: CheckinStatus | undefined = ["done", "skipped", "failed"].includes(
      body.status
    )
      ? body.status
      : undefined;

    const checkin = await saveCheckin({
      kind,
      day,
      mood,
      energy,
      focus: typeof body.focus === "string" ? body.focus : undefined,
      answer: typeof body.answer === "string" ? body.answer : undefined,
      went_well: typeof body.went_well === "string" ? body.went_well : undefined,
      could_improve:
        typeof body.could_improve === "string" ? body.could_improve : undefined,
      status,
      feedback: typeof body.feedback === "string" ? body.feedback : undefined,
    });

    // The evening check-in IS the daily reflection. Mirror it into the
    // reflection record so the streak, the history list and the wins card stay
    // in sync with what the user just wrote — otherwise finishing the evening
    // check-in would leave the Reflection tab looking untouched.
    //
    // Merge, never clobber: an empty field means "not answered", not "erase
    // what was already saved". A failure here must never fail the check-in.
    if (kind === "evening" && (status === "done" || body.went_well || body.could_improve)) {
      try {
        const existing = await getReflection(day);
        const wroteText =
          typeof body.went_well === "string" && body.went_well.trim() !== "";
        const wroteImprove =
          typeof body.could_improve === "string" && body.could_improve.trim() !== "";
        await upsertReflection({
          day,
          went_well: wroteText
            ? (body.went_well as string).trim()
            : existing?.went_well ?? null,
          could_improve: wroteImprove
            ? (body.could_improve as string).trim()
            : existing?.could_improve ?? null,
          completed: status === "done" ? true : existing?.completed ?? false,
        });
      } catch (err) {
        console.error("reflection mirror failed", err);
      }
    }

    const moodHistory = await getMoodHistory(14);
    return NextResponse.json({ checkin, moodHistory });
  } catch (err) {
    console.error("coach POST error", err);
    return NextResponse.json({ error: "Coach failed" }, { status: 500 });
  }
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
