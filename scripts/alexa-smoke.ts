// Local end-to-end smoke test for the Alexa skill — no Echo required.
//
// Runs the real skill handler against the real database (and, optionally, the
// real LLM brain). Usage:
//   npm run ask:smoke
//
// It creates "Smoke Test Milk" on the grocery list, verifies it lands, then
// removes it again so the test is self-cleaning.
//
// Set ALEXA_SMOKE_LLM=1 to also exercise the free-form AssistantQueryIntent,
// which calls the same OpenAI brain the web app uses.
import { alexaSkill } from "../src/lib/alexa/skill";
import { getList } from "../src/lib/lists";

type Slots = Record<string, { value: string }>;

function buildSlots(slots: Slots): Record<string, { name: string; value: string }> {
  return Object.fromEntries(
    Object.entries(slots).map(([k, v]) => [k, { name: k, value: v.value }])
  );
}

function envelope(intentName: string, slots: Slots = {}) {
  const isLaunch = intentName === "LaunchRequest";
  return {
    version: "1.0",
    session: {
      new: true,
      sessionId: "smoke-test-session",
      application: { applicationId: "smoke-test-app" },
      attributes: {},
      user: { userId: "smoke-test-user" },
    },
    context: {
      System: {
        apiEndpoint: "https://api.amazonalexa.com",
        application: { applicationId: "smoke-test-app" },
        user: { userId: "smoke-test-user" },
        device: { deviceId: "smoke-test-device" },
      },
    },
    request: isLaunch
      ? {
          type: "LaunchRequest",
          requestId: "smoke-launch",
          timestamp: new Date().toISOString(),
          locale: "en-US",
        }
      : {
          type: "IntentRequest",
          requestId: `smoke-${intentName}`,
          timestamp: new Date().toISOString(),
          locale: "en-US",
          intent: {
            name: intentName,
            slots: buildSlots(slots),
          },
        },
  };
}

function spoken(output: { type?: string; text?: string; ssml?: string } | undefined): string {
  if (!output) return "(no speech)";
  if (output.text) return output.text;
  if (output.ssml) return output.ssml.replace(/<[^>]+>/g, "").trim();
  return "(no speech)";
}

async function run(intentName: string, slots: Slots = {}) {
  const env = envelope(intentName, slots);
  const res = await alexaSkill.invoke(
    env as Parameters<typeof alexaSkill.invoke>[0],
    {} as never
  );
  const text = spoken(res.response?.outputSpeech);
  console.log(`\n=== ${intentName} ===`);
  console.log(text);
  return text;
}

async function main() {
  const failures: string[] = [];
  const check = (label: string, cond: boolean) => {
    console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
    if (!cond) failures.push(label);
  };

  // 1. Launch
  const welcome = await run("LaunchRequest");
  check("launch says welcome", /welcome/i.test(welcome));

  // 2. Add
  await run("AddToListIntent", {
    Item: { value: "Smoke Test Milk" },
    ListType: { value: "grocery" },
  });
  const afterAdd = await getList("grocery");
  check(
    "add persisted to DB",
    afterAdd.some((i) => i.name.toLowerCase() === "smoke test milk")
  );

  // 3. View
  const view = await run("ViewListIntent", { ListType: { value: "grocery" } });
  check("view mentions the item", /smoke test milk/i.test(view));

  // 4. Remove
  await run("RemoveFromListIntent", {
    Item: { value: "Smoke Test Milk" },
    ListType: { value: "grocery" },
  });
  const afterRemove = await getList("grocery");
  check(
    "remove cleared from DB",
    !afterRemove.some((i) => i.name.toLowerCase() === "smoke test milk")
  );

  // 5. Help (no DB)
  const help = await run("AMAZON.HelpIntent");
  check("help has instructions", /list/i.test(help));

  // 6. Optional LLM catch-all
  if (process.env.ALEXA_SMOKE_LLM === "1") {
    // Read-only query so the test doesn't pollute the real data.
    const reply = await run("AssistantQueryIntent", {
      Query: { value: "what is on my grocery list" },
    });
    check("llm fallback returns text", reply.length > 10);
  } else {
    console.log("\n(skipping LLM fallback — set ALEXA_SMOKE_LLM=1 to test it)");
  }

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

main().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
