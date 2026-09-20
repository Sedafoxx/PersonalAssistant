import { NextResponse } from "next/server";
import { runNotificationRun } from "@/lib/notify-run";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Weekly goal-review cron — nudges the user to reflect on goals that need
// attention and opens the conversation with the check-in pre-filled (the Coach
// tab it used to link into no longer exists). Exports GET (Vercel cron) and POST.
async function handle() {
  try {
    return NextResponse.json(await runNotificationRun("goal_review"));
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
