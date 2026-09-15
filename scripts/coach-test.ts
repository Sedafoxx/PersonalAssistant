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
} from "../src/lib/coach";

async function main() {
  const day = localDay();
  let failed = 0;
  const check = (name: string, ok: boolean, extra = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
    if (!ok) failed++;
  };

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
  } catch (err) {
    console.error("ERROR", (err as Error).message);
    failed++;
  }

  console.log(failed === 0 ? "\nALL COACH CHECKS PASSED" : `\n${failed} check(s) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
