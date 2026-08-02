# Hook your PersonalAssistant up to an Echo Dot (Alexa)

This repo now contains everything needed to make an Echo Dot a **voice front-end
for your PersonalAssistant app**. Say:

> _"Alexa, tell personal assistant to add milk to my grocery list"_

...and it lands in the same `list_items` table your web app reads.

> **Status: fully deployed and enabled ✅**
> - Vercel production deploy is live — `/api/alexa` returns
>   `{"status":"ok","service":"alexa-skill"}` (HTTP 200).
> - `ALEXA_ENDPOINT` is set in `.env.local`; `skill.json` points at the live
>   endpoint.
> - The skill is **created** (ID `amzn1.ask.skill.9b6fd15f-1d04-45be-9870-71c4b6873864`),
>   **deployed**, and **enabled** on the developer account. A real request
>   envelope POSTed to `/api/alexa` returned the correct spoken list from the
>   live database.
> - **Only remaining step:** speak to your Echo — see Step 5 below.

## Architecture

```
Echo Dot
   │  "Alexa, tell personal assistant to add milk to my grocery list"
   ▼
Amazon Alexa cloud
   │  HTTPS POST (RequestEnvelope) → your Vercel domain /api/alexa
   ▼
Next.js route  src/app/api/alexa/route.ts
   │  ask-sdk-core routes the intent
   ▼
src/lib/alexa/skill.ts  ──►  src/lib/lists.ts  ──►  Supabase (your real list)
        │
        └── AssistantQueryIntent ──►  src/lib/chat.ts (the same OpenAI brain
                                     the web app uses — todos, calendar, etc.)
```

No AWS/Lambda needed — the skill's backend is your existing Vercel-hosted app.

## What was added

| File | Purpose |
|---|---|
| `src/app/api/alexa/route.ts` | The skill's web endpoint (POST handler) |
| `src/lib/alexa/skill.ts` | Intent handlers: add / view / remove / clear lists + LLM catch-all |
| `src/lib/alexa/verify.ts` | Optional Alexa request-signature verification |
| `src/lib/chat.ts` | Shared assistant brain (extracted from `/api/chat`) |
| `skill-package/skill.json` | Skill metadata + endpoint (all commands live in files — **no Alexa UI editing**) |
| `skill-package/interactionModels/custom/en-US.json` | All intents, sample utterances, slot types |
| `scripts/prepare-skill.mjs` | Injects your real Vercel URL into `skill.json` before deploy |
| `scripts/alexa-smoke.ts` | Local end-to-end test of the skill (no Echo needed) |

## The 3 steps only YOU can do

I wrote all the code, but these require your accounts/credentials, so they can't
be automated from here:

1. **Vercel deploy** — push the app so `/api/alexa` is live.
2. **Amazon Developer login** — `ask configure` logs into *your* Amazon account.
3. **Enable the skill on your Echo** — one voice command / app tap.

---

## Step 1 — Deploy to Vercel

The skill backend must be publicly reachable over HTTPS (Vercel serves
`*.vercel.app` with a Let's Encrypt **wildcard** cert, so the skill's endpoint
uses `sslCertificateType: "Wildcard"` — `"Trusted"` would be rejected by
Amazon's endpoint check, causing "unable to reach the requested skill").

```
git add -A && git commit -m "Add Alexa skill backend" && git push
```

Vercel deploys automatically. Verify the route is live:

```
curl https://<your-app>.vercel.app/api/alexa
# → {"status":"ok","service":"alexa-skill"}
```

## Step 2 — Install ASK CLI + log in

```
npm i -g ask-cli
ask configure
```

- Log in with your **Amazon Developer** account (create one free at
  developer.amazon.com if you don't have it).
- When it asks for AWS credentials: **you don't need AWS** because the skill
  uses an HTTPS endpoint, not Lambda. Enter dummy values or skip — the profile
  is unused for this skill.

## Step 3 — Point the skill at your app

Add one line to `.env.local`:

```
ALEXA_ENDPOINT=https://<your-app>.vercel.app/api/alexa
```

Then build the skill package and deploy it:

```
npm run ask:deploy
```

This runs `scripts/prepare-skill.mjs` (injects your URL into `skill.json`) and
then `ask deploy`, which creates the skill, uploads the entire interaction model
(all your voice commands), and registers the endpoint — **no Alexa console
editing needed**.

## Step 4 — Enable the skill on your Echo

From your Echo: _"Alexa, enable personal assistant"_
(or enable it under Skills in the Alexa app).

## Step 5 — Try it

- _"Alexa, tell personal assistant to add milk to my grocery list"_
- _"Alexa, ask personal assistant what's on my shopping list"_
- _"Alexa, open personal assistant"_

Your list should update in the web app instantly (same Supabase table).

---

## Local testing (no Echo needed)

```
npm install          # once
npm run ask:smoke    # runs the real handlers against the real DB
```

This creates + removes a "Smoke Test Milk" row and reports PASS/FAIL per check.
Set `ALEXA_SMOKE_LLM=1` to also exercise the OpenAI-powered fallback.

## Optional: request verification

By default the route trusts HTTPS (CA mode). If you want Amazon's signature
verification on top, set `ALEXA_VERIFY_REQUESTS=1` in your Vercel env vars and
switch the skill to self-signed cert mode (requires uploading a cert in the
console). For a personal grocery list, CA mode is fine and simpler.

## Honest limitations (same as the research)

- You can't **overwrite the Echo's firmware** — Amazon owns the OS and the wake
  word. The skill channel is the supported way to run *your* intelligence on it.
- You must say the invocation name each time ("...personal assistant...").
  There's no automatic routing from casual speech into your skill.
- Changing the interaction model = edit the JSON in `skill-package/` and run
  `npm run ask:deploy` again — still no console work.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ask deploy` auth error | Re-run `ask configure`; make sure you're in the skill-package parent dir |
| Skill says "doesn't respond" | Check `/api/alexa` is reachable (Step 1), re-run `ask deploy`, re-enable the skill |
| "Unable to reach the requested skill" | Endpoint cert type must be `Wildcard` (Vercel = `*.vercel.app` wildcard); re-run `npm run ask:deploy`, wait a couple of minutes, retry |
| "That skill is not enabled" | Say "Alexa, enable personal assistant" on the same Amazon account used for `ask configure` |
| Wrong list type | The `ListType` slot resolves "groceries/supermarket/food"→grocery, "shopping/household"→shopping; unqualified adds default to grocery |
