# Mera Lead System — Hotfix Deploy

## What changed in this update

### 1. Follow Up queue is now filtered properly
- **Before**: Every lead with status `declined`, `no_answer`, `voicemail`, `bad_contact`, or `callback_requested` showed up in Follow Up (90+ leads).
- **After**: Only leads that genuinely need action show up:
  - `bad_contact` — needs manual callback
  - `wants_website_pending` — needs website built & sent
  - `callback_requested` — needs callback
  - `no_answer` / `voicemail` / `busy` — only if they have a retryable telephony outcome
  - `declined` leads are REMOVED from the queue (they said no, no point calling back).

### 2. Contact Outcome shows real Vapi reasons
- Old leads showed "UNKNOWN" because the `contact_outcome` column was added in the migration and old rows had NULL values.
- **Fix**: The API now falls back to `status` when `contact_outcome` is null, so old leads show `voicemail`, `no_answer`, `declined`, etc. instead of "UNKNOWN".
- **New calls** will capture the real Vapi `endedReason` (e.g., `customer-ended-call`, `voicemail`, `assistant-ended-call`) and store it properly.

### 3. Click any lead to see full call context
- New detail modal shows:
  - Phone, email, status, outcome
  - **Vapi Ended Reason** — the raw telephony signal (voicemail, customer-busy, etc.)
  - **Objection** — what the prospect said if they declined
  - **Zoom Time** — if they booked a callback time
  - **Call Context** — a human-readable sentence explaining WHY this lead needs follow-up
  - **Attempt History** — every call attempt with outcome, ended reason, and Vapi call summary (for new calls)
- Click any row in **Leads** or **Follow Up** to open the modal.

### 4. Slack messages
- Slack notifications are real-time pings to your Slack channel. They are **not stored** in the database for display in the dashboard.
- However, the lead status updates immediately reflect Slack actions (e.g., `/send` changes status from `wants_website_pending` to `website_sent`, so the lead disappears from Pending).

## Deploy steps

```bash
cd ~/Downloads/mera-lead-system
git add .
git commit -m "Hotfix: follow-up filter, Vapi outcomes, lead detail modal"
git push origin main
```

Then verify Railway shows "Healthy" and test by clicking a lead in the dashboard.
