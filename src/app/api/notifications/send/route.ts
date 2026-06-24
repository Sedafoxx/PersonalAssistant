import { NextResponse } from "next/server";
import webPush from "web-push";
import { createServiceClient } from "@/lib/supabase";
import { getItemsDueForNotification, updateItem } from "@/lib/db";
import { hasEntryToday } from "@/lib/journal";
import { generateSuggestions } from "@/lib/suggestions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function POST() {
  webPush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );

  try {
    const db = createServiceClient();
    const { data: subs } = await db.from("push_subscriptions").select("*");
    if (!subs || subs.length === 0) return NextResponse.json({ sent: 0 });

    // Push one payload to every subscription; prune expired ones.
    const pushAll = async (payload: object) => {
      let sent = 0;
      for (const sub of subs as Sub[]) {
        try {
          await webPush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload)
          );
          sent++;
        } catch {
          await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        }
      }
      return sent;
    };

    let sent = 0;

    // 1. Item reminders due now.
    const items = await getItemsDueForNotification();
    for (const item of items) {
      sent += await pushAll({
        title: item.type === "todo" ? "Reminder" : "Note",
        body: item.title,
        icon: "/icon-192.png",
      });
      await updateItem(item.id, { notification_time: undefined });
    }

    // 2. Daily journal nudge — only if nothing logged today.
    let journalNudge = false;
    if (!(await hasEntryToday())) {
      sent += await pushAll({
        title: "Daily journal",
        body: "What happened today? Tap to capture it — voice or text.",
        icon: "/icon-192.png",
        url: "/?tab=journal",
      });
      journalNudge = true;
    }

    // 3. Daily self-improvement pass — learn from recent usage and add fresh
    // suggestions. Non-fatal: never let it break the notification run.
    let suggestionsAdded = 0;
    try {
      suggestionsAdded = (await generateSuggestions()).length;
    } catch {
      // ignore — suggestions are best-effort
    }

    return NextResponse.json({
      sent,
      items: items.length,
      journalNudge,
      suggestionsAdded,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
