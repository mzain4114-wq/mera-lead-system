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

## 6. Follow-up system — staggered redial with silent drops and a DNC safety net

Before deploying this version, run `migration_followup_system.sql` once in your
Supabase SQL Editor (it's additive and safe to re-run).

**How a missed call gets classified.** Vapi's `call.endedReason` — telephony-level
data, not a guess from the transcript — is mapped by `mapEndedReason()` in
`leads-store.js` into one of: `no_answer`, `voicemail`, `busy`, `connected`, or
`failed`. This is what actually decides whether/when a lead gets called again.

**The cadence.** `requeue-check.js` computes `next_attempt_at` after every call
using a fixed schedule tuned to answer-rate research (late morning and
mid-afternoon see the best pickup rates):

| Attempt | Spacing after previous | Target window |
|---|---|---|
| 2 | next day | ~11am |
| 3 | +1 day | ~4pm |
| 4 | +2 days | ~9am |
| 5 | +2 days | ~2pm |
| 6 | +3 days | ~4pm |

Each time gets +/-30 min of jitter so retries don't land at a robotically exact
minute. After attempt 6, the lead stops auto-dialing and shows as "Exhausted" in
the Follow Up tab for a manual decision.

**Silent drops instead of spammy voicemails.** The first miss gets one SMS
nudge. From attempt 3 onward, a voicemail hit gets a follow-up email instead of
another recorded voicemail — repeated identical voicemails read as spam and hurt
response rates more than they help.

**Do-Not-Call is permanent and checked everywhere.** If a lead says anything
like "stop calling" or "take me off your list" on a call, `hasDncLanguage()`
sets `do_not_call = true` immediately and it's respected by the redial cron,
the dashboard's "Call Now" button, and the manual trigger endpoint — no code
path can dial a DNC lead. You can also flag one manually from the dashboard.

**Firm declines don't clutter the queue.** A lead who answers and explicitly
says no (`status: 'declined'`) is different from one who was never actually
reached — it's excluded from `FOLLOWUP_STATUSES`/`CALLABLE_BY_AGENT` on
purpose, so the Follow Up tab only ever shows leads where contact genuinely
hasn't happened yet (no answer, voicemail, busy, unclear info, callback
requests). Declined leads still show in the Leads tab, just not flagged as
needing action.

**Why it needs follow-up, in plain English.** Every lead now carries:
- `ended_reason_label` — Vapi's raw `call.endedReason` (e.g.
  `customer-did-not-answer`, `assistant-ended-call-...`) translated into
  something readable ("No answer", "Went to voicemail", "Customer hung up").
  Shown in a **Reason** column on both the Leads and Follow Up tabs.
- `call_summary` — Vapi's own summary of what was said on the last call
  (from your `summaryPlan`). Shown as a tooltip in the Reason column and in
  full at the top of the **Details** modal.
- `notifications` — every Slack message, email, and SMS the server actually
  sent for that lead, with timestamps. This is what answers "did we actually
  message them" without needing to dig through Slack history — click
  **Details** on any lead to see it.

**Trigger it daily:**

- Free option: [cron-job.org](https://cron-job.org) → new cron job → URL
  `https://<your-app>/cron/redial?key=<your CRON_SECRET>` → schedule daily.
- It's safe to hit more often than daily — leads not yet due just get skipped
  (the endpoint checks `next_attempt_at` itself).

## 7. Dashboard

The server now serves the dashboard itself — no separate hosting needed.
Set `DASHBOARD_KEY` in your env to any random string, then open:

```
https://<your-app>.up.railway.app/dashboard?key=<DASHBOARD_KEY>
```

Bookmark that exact URL (with the key in it) on your phone/laptop. It shows
the call pulse, the funnel, your action queue, and the full lead table —
refreshes every 30s.

The **Follow Up** tab shows, per lead: which attempt number it's on out of 6,
what happened last time in plain English (no answer / voicemail / busy —
see the **Reason** column), and exactly when the next auto-attempt is
scheduled. Click **Details** on any lead (Leads tab or Follow Up tab) to see
Vapi's call summary, the full timestamped attempt log, and every Slack/email/
SMS message actually sent for that lead. **Mark DNC** on any row permanently
stops all future dialing for that lead — use it the moment someone asks to be
left alone.

**Why the key matters:** `/api/leads`, `/api/stats`, and `/api/followup`
return real customer names, emails, and phone numbers. Without
`DASHBOARD_KEY` set, the server refuses to serve them at all (fails closed)
rather than exposing them to anyone who finds the URL. Don't share the
`?key=...` link outside your team.

## 8. Import — bulk-upload old leads and start the calls yourself

The **Import** tab lets you upload a CSV or Excel file of past leads (or any
new list) and re-engage them under your control — nothing dials automatically.

**Uploading:** any `.csv`, `.xlsx`, or `.xls` file works, as long as one
column header contains the word "phone" (case-insensitive — "Phone Number",
"phone", "Contact Phone" all match). Name and email columns are optional but
recommended. Phone numbers are normalized automatically (adds `+1` to a bare
10-digit US number, adds a missing `+`, strips formatting like `(555)
123-4567`) so messy spreadsheet exports still work.

Each upload becomes a **batch** — give it a name in the box next to the
upload button, or it'll use the filename. Every lead in the batch lands with
status `queued` and sits there until you act on it.

**Starting the calls:** the Import tab lists every batch with a live count of
how many leads in it are still `queued` vs already `started`. Click **Start
Campaign** on a batch and the server dials that batch's queued leads one at a
time, spaced ~20 seconds apart, in the background — you get a Slack message
when it kicks off and another when the whole batch has been dialed. From
there, every lead in it is a completely normal lead: if someone doesn't pick
up, the exact same 6-attempt staggered cadence from section 6 takes over
automatically for that lead. Nothing extra to do.

**Re-uploading a list:** if a phone number in your CSV already exists in the
system, it's matched to that existing lead (their history is kept — nothing
is duplicated) and re-queued into the new batch, so you can re-run a list of
old declines or no-answers just by uploading it again.

**Safety still applies:** a lead already marked Do-Not-Call is skipped by
Start Campaign even if it's sitting in a queued batch.

## 9. Evals — protect the prompt before you change it again

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
- No-answers, voicemails, and busy signals redial themselves for up to 6 tries
  on a staggered schedule (see section 6), with one SMS nudge after the first
  miss and email instead of a 3rd+ voicemail.
- Anyone who says stop calling is permanently excluded from every future dial —
  check the Follow Up tab if you ever need to confirm someone's DNC status.
- Got an old lead list to work through? Upload it in the Import tab and hit
  Start Campaign when you're ready — see section 8.
- Check the dashboard whenever you want the full picture at a glance.

## What's a placeholder you should adjust

- `resolveStatus()` in `server.js` — the mapping from Vapi's structured data to
  a status label. It's built from the field names in `vapi-analysis-plan.json`;
  if you rename or add fields there, update this function to match.
- Email copy in `server.js` (`sendEmail(...)` calls) — currently generic, swap
  in your actual tone/signature.
- The `CADENCE` array in `requeue-check.js` — the spacing/timing between
  attempts. Adjust `delayHours`/`targetHour` per row if your ideal call windows
  differ from the 11am/4pm/9am/2pm/4pm defaults.
- `hasDncLanguage()` in `leads-store.js` — the phrase list that triggers an
  automatic Do-Not-Call flag. Add any other phrasing your callers commonly use.
