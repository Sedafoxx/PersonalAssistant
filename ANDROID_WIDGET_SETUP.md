# Android widget: your todos on the home screen (KWGT, no paid apps)

Turns your PersonalAssistant open todos into a live home-screen widget using
**KWGT** (free) + a small read-only endpoint in the app. No Tasker, no
subscription, no extra servers.

## How it works

- The app exposes a read-only endpoint that returns your **open todos as plain
  text** (highest priority first, with a short due date when one is set).
- KWGT fetches that text with its `$wg()$` function and renders it in a widget.
- The widget refreshes on Android's own schedule (roughly every 15–60 minutes) —
  fine for todos, and you can force a refresh by re-applying the widget.

The app URL used here is the project's **stable alias**
(`personal-assistant-two-pi.vercel.app`), so it keeps working after every
re-deploy — the random `*.vercel.app` URLs change, this one does not.

## Step 1 — Install KWGT

Play Store → search **"KWGT Kustom Widget Maker"** → Install (free).

## Step 2 — Check the endpoint works

Open this in your phone's browser (replace `YOUR_TOKEN` with the value of
`WIDGET_TOKEN` from the app's `.env.local`):

```
https://personal-assistant-two-pi.vercel.app/api/widget/todos?token=YOUR_TOKEN&format=text
```

You should see plain text like:

```
3 open todos

• Finish the project
• Buy milk (Mon)
• Call dentist
```

- `unauthorized` → the token in the URL is wrong.
- `404` → the endpoint isn't deployed yet; re-deploy the app.

## Step 3 — Build the widget in KWGT

1. Long-press an empty spot on your home screen → **Widgets** → **KWGT** →
   add a **4×2** (or **2×2**) widget (the blank one).
2. Tap the blank widget → the KWGT editor opens.
3. Tap the **＋** button → **Text** → OK (adds a text item).
4. Tap that text item → tap the **fx** formula field and paste:

   ```
   $wg("https://personal-assistant-two-pi.vercel.app/api/widget/todos?token=YOUR_TOKEN&format=text")$
   ```

5. Style it:
   - **Font size** ~16–20sp, **line spacing** a bit larger than default.
   - **Color**: `#E5E7EB` on a dark background, or `#111827` on light.
   - Set the widget **background** to match your theme (e.g. `#0F0F0F`,
     rounded corners ~20).
6. Tap the **✓** (apply) in the top-right to save. It should now show your todos.

> **If it shows `...` or nothing:** the web-fetch function `$wg()$` needs the
> small **one-time KWGT Pro** unlock (Play Store in-app, ~$2, still no Tasker).
> That's the only case where the free tier falls short.

## Step 4 — Refresh

- KWGT re-fetches the URL whenever the widget refreshes. Android updates widgets
  roughly every 15–60 minutes depending on the device.
- Force a refresh: open the widget in the KWGT editor and tap **✓** again, or
  re-add the widget from the home screen.

## Step 5 — Make it tappable (optional)

In the KWGT editor: **Touch** → **＋** → **Launch** → **URL** → paste:

```
https://personal-assistant-two-pi.vercel.app
```

so tapping the widget opens the app in your browser.

## What the endpoint returns

```
GET /api/widget/todos?token=<WIDGET_TOKEN>&format=text
```
Plain text: first line = count, then one todo per line, highest priority first,
with a short due date when present. `format=json` returns the same data as JSON
for any other client. The endpoint is read-only and requires the token.

## If it stops working

- Re-deploys do **not** break it (stable alias), but if you ever switch the
  stable alias or the token, update the formula in the KWGT editor.
- Token changed? Grab the new `WIDGET_TOKEN` from `.env.local` and paste it in.
