import { NextResponse } from "next/server";
import webPush from "web-push";
import { createServiceClient } from "@/lib/supabase";
import { getItemsDueForNotification, updateItem } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST() {
  webPush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );

  try {
    const items = await getItemsDueForNotification();
    if (items.length === 0) return NextResponse.json({ sent: 0 });

    const db = createServiceClient();
    const { data: subs } = await db.from("push_subscriptions").select("*");
    if (!subs || subs.length === 0) return NextResponse.json({ sent: 0 });

    let sent = 0;
    for (const item of items) {
      const payload = JSON.stringify({
        title: item.type === "todo" ? "Reminder" : "Note",
        body: item.title,
        icon: "/icon-192.png",
      });

      for (const sub of subs) {
        try {
          await webPush.sendNotification(
            {
              endpoint: sub.endpoint,
              keys: { p256dh: sub.p256dh, auth: sub.auth },
            },
            payload
          );
          sent++;
        } catch {
          // Subscription expired — remove it
          await db
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", sub.endpoint);
        }
      }

      // Clear notification_time so it doesn't fire again
      await updateItem(item.id, { notification_time: undefined });
    }

    return NextResponse.json({ sent });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
