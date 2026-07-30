# Mera Lead System — Phase 1 & 2 Deployment

## Step 1: Run Supabase migration

Open your Supabase SQL Editor and run:

```sql
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS contact_outcome TEXT,
ADD COLUMN IF NOT EXISTS attempt_history JSONB DEFAULT '[]'::jsonb,
ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS do_not_call BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS follow_up_attempts INTEGER DEFAULT 0;
```

## Step 2: Confirm environment variables

Make sure these are set in Railway (or your host):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `VAPI_API_KEY`
- `VAPI_ASSISTANT_ID`
- `VAPI_FOLLOWUP_ASSISTANT_ID`
- `VAPI_PHONE_NUMBER_ID`
- `VAPI_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `HOSTINGER_EMAIL` (verified sender in Resend)
- `SLACK_WEBHOOK_URL`
- `SLACK_SIGNING_SECRET`
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_TOLLFREE_NUMBER`
- `DASHBOARD_KEY`
- `CRON_SECRET`
- `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` (if using Zoom)

## Step 3: Deploy

Push all files to your repo. Railway auto-builds on `npm install` + `npm start`.

## Step 4: Verify

1. Make one test call via Vapi.
2. Check the dashboard at `https://<your-app>/dashboard?key=<DASHBOARD_KEY>`.
3. Confirm the Follow Up tab shows attempt counts, next retry times, and DNC buttons.
4. Set your cron job (cron-job.org) to hit `/cron/redial?key=<CRON_SECRET>` daily.

## What changed in Phase 1 + 2

- **leads-store.js**: Now tracks `contact_outcome`, `attempt_history`, `next_attempt_at`, `do_not_call`, `follow_up_attempts`. Classifies Vapi `endedReason` into reliable outcomes. Detects DNC language in objections.
- **requeue-check.js**: Smart cadence with 6 attempts, time-of-day windows (11am, 4pm, 9am, 2pm), ±30min jitter. Excludes booked/sent/DNC leads. Computes `next_attempt_at`.
- **server.js**: Webhook now records telephony-level outcomes. SMS nudge on 1st miss. Silent drop + email on 3rd+ voicemail. New `/api/dnc` endpoint. Smarter `/api/followup` with `exhausted` flag and action labels.
- **dashboard/index.html**: New sidebar layout. Follow Up queue shows attempt count, next scheduled time, DNC button, exhausted filter. Leads table shows contact outcome. Export CSV.
