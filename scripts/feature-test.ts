// Functional checks for the new features:
//   - conversation memory (log + retrieve per client_id, scoped)
//   - search_web wiring (no key → graceful "not configured")
//   - fetch_url page reading
//   - pdf-parse loads AND parses a real PDF
// Runs against the real DB (needs .env.local). Usage:
//   node --env-file=.env.local --import tsx scripts/feature-test.ts
import { logChatMessages, getConversation } from "../src/lib/chat-log";
import { searchWeb, fetchPageText } from "../src/lib/web";
import { createServiceClient } from "../src/lib/supabase";

async function main() {
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) failures.push(label);
  };

  // 1. Conversation memory round-trip + scoping
  const cid = `test-${Date.now()}`;
  await logChatMessages(
    [
      { role: "user", content: "remember the code word zephyr" },
      { role: "assistant", content: "Got it, zephyr." },
    ],
    cid
  );
  const history = await getConversation(cid);
  check(
    "memory stores and retrieves turns",
    history.some((m) => m.content.includes("zephyr"))
  );
  const other = await getConversation(`definitely-not-${cid}`);
  check("memory is scoped per client", other.length === 0);
  // cleanup
  const db = createServiceClient();
  await db.from("chat_messages").delete().eq("client_id", cid);

  // 2. search_web is wired. The old assertion hard-required the "not configured"
  //    message, so it broke the day a Tavily key existed: it was testing the
  //    ENVIRONMENT, not the code, and it reported a working feature as a failure.
  //    Both environments are correct behaviour; only one of them is yours today.
  const hasTavilyKey = !!process.env.TAVILY_API_KEY;
  const res = await searchWeb("latest news");
  check(
    hasTavilyKey
      ? "search_web wired (key present: real results)"
      : "search_web wired (no key: graceful message)",
    hasTavilyKey ? res.length > 0 && !/not configured/i.test(res) : /not configured/i.test(res)
  );

  // 3. fetch_url reads a page
  const page = await fetchPageText("https://example.com");
  check("fetch_url reads a page", /Example Domain/i.test(page));

  // 4. pdf-parse loads AND parses a real PDF (W3C dummy file)
  const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
  check("pdf-parse module loads", typeof pdfParse === "function");
  try {
    const res = await fetch(
      "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf"
    );
    const buf = Buffer.from(await res.arrayBuffer());
    const data = await pdfParse(buf);
    check("pdf-parse parses a real PDF", /dummy/i.test(data.text ?? ""));
  } catch (e) {
    check(`pdf-parse parses a real PDF (${e instanceof Error ? e.message : "err"})`, false);
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll feature checks passed.");
}

main().catch((e) => {
  console.error("feature test crashed:", e);
  process.exit(1);
});
