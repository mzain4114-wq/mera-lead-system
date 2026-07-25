# Mera Lead System — full setup

This is the complete loop: Vapi calls a prospect → structured data comes back →
this server decides what happened → qualified leads get emailed automatically →
you get a Slack ping → you reply to trigger the next step → a dashboard shows
you all of it without opening a single call log.

Everything lives in one repo. Deploy once, then it runs itself.

---

## 1. Vapi — attach the analysis plan (via API)

Vapi's dashboard replaced the raw-JSON paste box with a "Structured Outputs"
field-by-field builder. Skip that entirely — the API still accepts the full
`analysisPlan` object in one call, which is what `vapi-analysis-plan.json` is
built for:

```bash
curl -X PATCH https://api.vapi.ai/assistant/YOUR_ASSISTANT_ID \
  -H "Authorization: Bearer YOUR_VAPI_PRIVATE_KEY" \
  -H "Content-Type: application/json" \
  -d @vapi-analysis-plan.json
```

Get `YOUR_ASSISTANT_ID` from the dashboard URL when viewing the assistant, and
`YOUR_VAPI_PRIVATE_KEY` from Dashboard → API Keys.

Run it, then verify it landed by fetching the assistant back:

```bash
curl https://api.vapi.ai/assistant/YOUR_ASSISTANT_ID \
  -H "Authorization: Bearer YOUR_VAPI_PRIVATE_KEY" | grep -A2 analysisPlan
```

You should see `structuredDataPlan`, `successEvaluationPlan`, and
`summaryPlan` all populated. Then:

3. Under **Server URL**, set it to `https://<your-railway-app>.up.railway.app/webhook/vapi`
   once you've deployed (step 5). Set the **Server URL Secret** to the same value
   you'll put in `VAPI_WEBHOOK_SECRET`.
4. While you're in here: turn on **Voicemail Detection** (LLM-based, not legacy
   Twilio AMD) and set Max Detection Retries to 3.

## 2. Slack — create your control app

1. Go to api.slack.com/apps -> Create New App -> "From scratch" -> pick your workspace.
2. Incoming Webhooks -> toggle on -> Add New Webhook to Workspace -> choose the
   channel you want pings in -> copy the webhook URL into `SLACK_WEBHOOK_URL`.
3. Slash Commands -> create `/send` and `/pending`, both with the Request URL
   `https://<your-railway-app>.up.railway.app/webhook/slack` -- one route handles both.
4. Basic Information -> App Credentials -> copy the Signing Secret into
   `SLACK_SIGNING_SECRET` (used to verify incoming slash-command requests are
   really from Slack).
5. Install the app to your workspace. You'll need to reinstall it any time you
   add or change slash commands.

## 3. Twilio — toll-free number for SMS fallback

Your existing number can't send SMS without A2P 10DLC registration, and that's
overkill for the low volume of fallback nudges this system sends. Instead:

1. In the Twilio console, buy a **toll-free number** (separate from your voice
   number).
2. Submit the **Toll-Free Verified Sender Form** — as of Jan 2026 this needs a
   Business Registration Number (e.g. EIN) alongside your business details.
   Approval is typically faster than full 10DLC.
3. Put that number in `TWILIO_TOLLFREE_NUMBER`.

This is only used for a one-line nudge text after a missed call — not marketing
volume — so toll-free verification is enough; you don't need full 10DLC unless
you start sending real SMS campaigns later.

## 4. Hostinger — mail credentials

Put your Hostinger mailbox address and password into `HOSTINGER_EMAIL` /
`HOSTINGER_PASSWORD`. Host/port defaults in `.env.example` are Hostinger's
standard SMTP — leave them unless your plan says otherwise.

## 5. Deploy to Railway

1. Push this whole folder to a new GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo** → select it.
3. Under **Variables**, paste in everything from `.env.example` with real values.
4. Railway builds automatically (`npm install` + `npm start`). Once it's live,
   copy the generated public URL (or set a custom domain).
5. Go back to Vapi (step 1) and set the Server URL to
   `https://<that-url>/webhook/vapi`.
6. Slack's slash commands already point at `/webhook/slack` from step 2 above --
   nothing further to configure here, just make sure the Request URL there
   matches your final Railway domain.

## 6. Redial cron

The server has a `/cron/redial?key=<CRON_SECRET>` endpoint that redials anyone
stuck on no-answer/voicemail, up to 6 attempts, 24 hours apart. Trigger it daily:

- Free option: [cron-job.org](https://cron-job.org) → new cron job → URL
  `https://<your-app>/cron/redial?key=<your CRON_SECRET>` → schedule daily.
- It's safe to hit more often than daily — leads not yet due just get skipped.

## 7. Dashboard

The server now serves the dashboard itself — no separate hosting needed.
Set `DASHBOARD_KEY` in your env to any random string, then open:

```
https://<your-app>.up.railway.app/dashboard?key=<DASHBOARD_KEY>
```

Bookmark that exact URL (with the key in it) on your phone/laptop. It shows
the call pulse, the funnel, your action queue, and the full lead table —
refreshes every 30s.

**Why the key matters:** `/api/leads` and `/api/stats` return real customer
names, emails, and phone numbers. Without `DASHBOARD_KEY` set, the server
refuses to serve them at all (fails closed) rather than exposing them to
anyone who finds the URL. Don't share the `?key=...` link outside your team.

If you ever want to host the HTML file separately again (Netlify/Vercel), it
still works — the page falls back to a manual "API base" field when no
same-origin key is present.

## 8. Evals — protect the prompt before you change it again

In the Vapi dashboard, open **Evals**:

1. Start with 3–4 tests for your most critical behaviors: the pricing answer,
   the Zoom booking flow, the email-spelling readback, and the "not interested"
   graceful exit.
2. Fastest way to build them: find a real call in your logs, click thumbs-down,
   describe what the assistant should have done instead — Vapi turns that
   transcript into a permanent test.
3. Before you edit Mera's prompt or script again, run the eval suite first.
   After the edit, run it again and confirm nothing regressed.

## Daily use, once everything's live

- Campaign runs as normal in Vapi.
- Every finished call hits `/webhook/vapi` automatically — no log-reading.
- Booked meetings get confirmed by email + you get a ✅ Slack ping.
- "Wants website" leads wait in your queue — build the site, reply
  `/send <id> <url>` in Slack, it emails them and confirms back to you.
- No-answers redial themselves for up to 6 tries, spaced a day apart, with one
  SMS nudge after the first miss.
- Check `dashboard/index.html` whenever you want the full picture at a glance.

## What's a placeholder you should adjust

- `resolveStatus()` in `server.js` — the mapping from Vapi's structured data to
  a status label. It's built from the field names in `vapi-analysis-plan.json`;
  if you rename or add fields there, update this function to match.
- Email copy in `server.js` (`sendEmail(...)` calls) — currently generic, swap
  in your actual tone/signature.
- `leads.json` is a flat file — fine at your current volume. If you move to
  Supabase later, only `leads-store.js` needs to change; every other file calls
  through it and won't need edits.
