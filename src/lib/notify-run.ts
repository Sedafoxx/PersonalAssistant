import webPush from "web-push";
import { createServiceClient } from "./supabase";
import { getItems, getItemsDueForNotification, updateItem } from "./db";
import { hasEntryToday } from "./journal";
import { hasReflectionToday } from "./reflection";
import { hasOpenMorningCheckin, getGoalReview } from "./coach";
import { generateSuggestions } from "./suggestions";
import { daysUntil } from "./dates";
import { captureCheck } from "./commitments";
import { listLoops, staleLoops } from "./loops";

export type NotifyKind = "morning" | "evening" | "goal_review";

interface Sub {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// One notification run: pushes due item reminders, then a nudge depending on
// the time of day (morning = journal, evening = reflection), plus a best-effort
// self-improvement suggestions pass. Shared by the cron routes so morning and
// evening schedules hit the same logic with a different focus.
export async function runNotificationRun(kind: NotifyKind) {
  webPush.setVapidDetails(
    `mailto:${process.env.VAPID_EMAIL}`,
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
  );

  const db = createServiceClient();
  const { data: subs } = await db.from("push_subscriptions").select("*");
  if (!subs || subs.length === 0) return { sent: 0 };

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

  let journalNudge = false;
  let reflectionNudge = false;
  let coachNudge = false;
  let goalReviewNudge = false;
  let dueSoonNudge = false;
  // Morning-only memory sections (P6a). Each is best-effort: a failure leaves
  // that section out entirely rather than breaking the run.
  let uncaptured: { quote: string; suggested: string }[] = [];
  let waitingOnYou: { subject: string; thread: string }[] = [];
  let stale: { subject: string; thread: string }[] = [];
  let memoryNudge = false;

  if (kind === "goal_review") {
    // Weekly goal check-in: nudge a reflection, naming goals that need attention.
    try {
      const review = await getGoalReview();
      sent += await pushAll({
        title: "Weekly goal check-in",
        body: review.prompt,
        icon: "/icon-192.png",
        url: "/?tab=coach",
      });
      goalReviewNudge = true;
    } catch {
      // non-fatal
    }
  } else if (kind === "evening") {
    // 2a. Evening reflection nudge — only if today's reflection isn't done yet.
    if (!(await hasReflectionToday())) {
      sent += await pushAll({
        title: "Evening reflection",
        body: "Time for your evening reflection — talk it through and I will record it.",
        icon: "/icon-192.png",
        // Straight into the conversation with the reflection opener pre-filled:
        // the Reflection tab no longer exists.
        url: "/?tab=chat&prompt=reflection",
      });
      reflectionNudge = true;
    }
  } else {
    // 2b. Morning coach nudge — 2-min check-in, only if still open.
    try {
      if (await hasOpenMorningCheckin()) {
        sent += await pushAll({
          title: "Coach",
          body: "2-min check-in: how's the mood, and what's your one focus today?",
          icon: "/icon-192.png",
          url: "/?tab=coach",
        });
        coachNudge = true;
      }
    } catch {
      // coach table may not exist yet — non-fatal
    }
    // 2c. Morning journal nudge — only if nothing logged today.
    if (!(await hasEntryToday())) {
      sent += await pushAll({
        title: "Daily journal",
        body: "What happened today? Tap to tell me — voice or text.",
        icon: "/icon-192.png",
        // The Journal tab is gone; journaling is just talking now.
        url: "/?tab=chat",
      });
      journalNudge = true;
    }
    // 2d. Deadline nudge — best-effort, mirroring the coach nudge's try/catch.
    // Only fires when something is overdue, due today, or due within 2 days.
    try {
      const todos = await getItems({
        type: "todo",
        status: "active",
        sort_by: "due_date",
      });
      const soon = todos
        .map((item) => ({ item, days: daysUntil(item.due_date) }))
        .filter(
          (entry): entry is { item: (typeof todos)[number]; days: number } =>
            entry.days !== null && entry.days <= 2
        )
        .sort((a, b) => a.days - b.days);

      if (soon.length > 0) {
        const parts = soon.slice(0, 3).map(({ item, days }) => {
          const when =
            days < 0
              ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`
              : days === 0
                ? "due today"
                : `due in ${days} day${days === 1 ? "" : "s"}`;
          return `${item.title} (${when})`;
        });
        const more = soon.length - parts.length;
        const body = more > 0 ? `${parts.join(", ")}, +${more} more` : parts.join(", ");

        sent += await pushAll({
          title: "Deadlines",
          body,
          icon: "/icon-192.png",
          url: "/?tab=today",
        });
        dueSoonNudge = true;
      }
    } catch {
      // non-fatal — a nudge failure must never break the run
    }

    // 2e. Memory check (morning only): promises made yesterday that never became
    // items, threads explicitly waiting on the user, and loops gone quiet. Each
    // part is independent and best-effort — a failure omits only its own section.
    //
    // The point of this section is the failure mode it exists for: the assistant
    // saying "noted" while nothing was actually written. So it reports what is
    // MISSING from the record, not what is in it.
    try {
      uncaptured = (await captureCheck()).uncaptured;
    } catch {
      // section omitted
    }
    try {
      waitingOnYou = (await listLoops({ state: "waiting", limit: 20 }))
        .filter((loop) => loop.waiting_on === "you")
        .map((loop) => ({ subject: loop.subject, thread: loop.thread }));
    } catch {
      // section omitted
    }
    try {
      stale = (await staleLoops()).map((loop) => ({
        subject: loop.subject,
        thread: loop.thread,
      }));
    } catch {
      // section omitted
    }

    // One extra nudge, and only when there is something to say. Silence means the
    // record is complete and nothing is blocked on him.
    try {
      const lines: string[] = [];
      if (uncaptured.length > 0) {
        const names = uncaptured.slice(0, 2).map((entry) => entry.suggested || entry.quote);
        lines.push(`yesterday, said but never recorded: ${names.join(", ")}`);
      }
      if (waitingOnYou.length > 0) {
        const names = waitingOnYou.slice(0, 3).map((loop) => loop.thread);
        lines.push(`waiting on you: ${names.join(", ")}`);
      }
      if (lines.length > 0) {
        sent += await pushAll({
          title: "Memory check",
          body: lines.join(" · "),
          icon: "/icon-192.png",
          url: "/?tab=coach",
        });
        memoryNudge = true;
      }
    } catch {
      // non-fatal — the summary fields below are still reported
    }
  }

  // 3. Daily self-improvement pass — learn from recent usage and add fresh
  // suggestions. Non-fatal: never let it break the notification run.
  let suggestionsAdded = 0;
  try {
    suggestionsAdded = (await generateSuggestions()).length;
  } catch {
    // ignore — suggestions are best-effort
  }

  return {
    sent,
    items: items.length,
    journalNudge,
    reflectionNudge,
    coachNudge,
    dueSoonNudge,
    goalReviewNudge,
    suggestionsAdded,
    // Morning memory check (P6a). Always present, empty when there is nothing to
    // report — an absent field would be indistinguishable from a failed section.
    memoryNudge,
    uncaptured,
    waitingOnYou,
    staleLoops: stale,
  };
}
