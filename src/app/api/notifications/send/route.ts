import { NextResponse } from "next/server";
import { runNotificationRun } from "@/lib/notify-run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Vercel cron jobs call GET, not POST — export both so the morning schedule
// actually fires and manual/curl triggers keep working.
async function handle() {
  try {
    return NextResponse.json(await runNotificationRun("morning"));
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
