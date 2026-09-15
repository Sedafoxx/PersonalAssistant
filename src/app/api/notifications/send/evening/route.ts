import { NextResponse } from "next/server";
import { runNotificationRun } from "@/lib/notify-run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Evening cron schedule — pushes the daily reflection nudge when today's
// reflection isn't completed yet. Exports both GET and POST (Vercel cron uses
// GET; manual triggers may use POST).
async function handle() {
  try {
    return NextResponse.json(await runNotificationRun("evening"));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST() {
  return handle();
}

export async function GET() {
  return handle();
}
