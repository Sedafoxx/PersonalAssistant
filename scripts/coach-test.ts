// End-to-end smoke test for the Proactive Coach check-in.
// Run: npm run coach:test
//   (= node --env-file=.env.local --import tsx scripts/coach-test.ts)
import {
  coachReply,
  getCheckin,
  saveCheckin,
  getMoodHistory,
  localDay,
  hasOpenMorningCheckin,
  planDay,
} from "../src/lib/coach";
import { createServiceClient } from "../src/lib/supabase";

async function main() {
  const day = localDay();
  const db = createServiceClient();
  let failed = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
  };

  // SNAPSHOT FIRST. These checks OVERWRITE today's check-in rows — mood, focus,
  // status, and the day plan — so running the test used to silently replace the
  // user's own record with test values (a fabricated mood of 4 in his history, a
  // plan he never asked for). The rows are captured here and written back
  // byte-for-byte in the `finally`, so the test leaves no trace in the record it
  // is testing.
  const snapshots = (
    await Promise.all([getCheckin("morning", day), getCheckin("evening", day)])
  ).filter((row): row is NonNullable<typeof row> => row !== null);

  try {
    // 1. Generate a real coach reply via the LLM.
    const r = await coachReply("morning");
    check("coachReply returns a reply", r.reply.length > 0, r.reply.slice(0, 60));
    check("coachReply proposes an action", r.next_action.headline.length > 0, r.next_action.headline.slice(0, 60));

    // 2. Persist a morning check-in (mood + the proposed action).
    const saved = await saveCheckin({
      kind: "morning",
      day,
      mood: 4,
      focus: "Ship the coach MVP",
      question: r.reply,
      next_action: r.next_action.headline || null,
      next_action_domain: r.next_action.domain,
      next_action_goal: r.next_action.goal,
      next_action_due: r.next_action.due,
      status: "proposed",
    });
    check("saveCheckin persisted", !!saved.id);
    check("saved kind/day correct", saved.kind === "morning" && saved.day === day);
    check("saved mood", saved.mood === 4);

    // 3. Read it back.
    const read = await getCheckin("morning", day);
    check("getCheckin round-trip", read?.id === saved.id);

    // 4. Resolve: mark done.
    const done = await saveCheckin({
      kind: "morning",
      day,
      status: "done",
      feedback: "Worked well — quick and focused.",
    });
    check("resolve to done", done.status === "done");

    // 5. Mood history now contains today.
    const hist = await getMoodHistory(7);
    check("mood history has today", hist.some((h) => h.day === day && h.mood === 4));

    // 6. After done, morning check-in should no longer be "open".
    const open = await hasOpenMorningCheckin(day);
    check("no longer open after done", !open);

    // 7. Evening check-in flow (went well / could improve).
    const eve = await saveCheckin({
      kind: "evening",
      day,
      mood: 4,
      went_well: "Shipped coach",
      could_improve: "Less context switching",
      status: "done",
    });
    check("evening check-in saved", eve.kind === "evening" && eve.went_well === "Shipped coach");

    // 8. P7b — the day plan SHOWS ITS REASONING. planDay() persists the plan onto
    //    today's morning check-in; the snapshot above puts the user's own back.
    const plan = await planDay(day);
    const strategy = plan.strategy ?? "";
    check(
      "8a. planDay returns a plan with blocks",
      plan.blocks.length > 0,
      `${plan.blocks.length} block(s), headline="${plan.headline.slice(0, 60)}"`
    );
    // Mechanically checkable: the plan came back with its reasoning ATTACHED.
    // What the reasoning says is a model judgement, so it is printed, not scored.
    check(
      "8b. the plan carries a strategy paragraph (what needs movement, the options weighed, the choice)",
      strategy.length >= 80,
      `${strategy.length} chars`
    );
    check(
      "8c. backlogUsed is a well-formed list of {title, reason}",
      Array.isArray(plan.backlogUsed) && plan.backlogUsed.every((b) => b.title.length > 0),
      plan.backlogUsed?.length
        ? plan.backlogUsed.map((b) => `${b.title} — ${b.reason.slice(0, 40)}`).join(" | ")
        : "empty (an honest answer when nothing in the backlog fits today)"
    );

    if (strategy) {
      console.log("\n      ---- THE PLAN'S REASONING (model judgement, shown not scored) ----");
      for (const line of strategy.split("\n")) console.log(`      ${line}`);
      console.log("      ---- the timetable it produced, for comparison ----");
      for (const b of plan.blocks) {
        console.log(
          `      ${b.start}–${b.end}  ${b.title}${b.goal ? `  [${b.goal}]` : ""}${b.required ? "" : "  (optional)"}`
        );
      }
      console.log("      --------------------------------------------------------\n");
    }
  } catch (err) {
    console.error("ERROR", (err as Error).message);
    failed++;
  } finally {
    // Put the user's record back exactly as it was.
    try {
      for (const row of snapshots) {
        await db.from("coach_checkins").upsert(row, { onConflict: "id" });
      }
      const had = new Set(snapshots.map((r) => r.kind));
      for (const kind of ["morning", "evening"] as const) {
        if (!had.has(kind)) {
          await db.from("coach_checkins").delete().eq("kind", kind).eq("day", day);
        }
      }
      console.log(
        `\nRestored today's check-in rows (${snapshots.length} snapshot(s) written back).`
      );
    } catch (err) {
      console.error(
        "RESTORE FAILED — today's check-in may hold test values:",
        (err as Error).message
      );
    }
  }

  console.log(failed === 0 ? "\nALL COACH CHECKS PASSED" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
