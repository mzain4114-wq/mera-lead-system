// requeue-check.js
// Staggered multi-attempt follow-up with time-of-day windows + silent-drop cadence

const { readLeads, writeLeads } = require('./leads-store');

const MAX_ATTEMPTS = 6;
const RETRYABLE_OUTCOMES = ['no_answer', 'voicemail', 'busy', 'failed'];
const CALLBACK_STATUSES = ['callback_requested'];

// Cadence: attempt N -> attempt N+1 spacing and target hour window.
// Tuned around answer-rate research: 11am-12pm and 4-5pm see the highest
// pickup rates, so later attempts rotate through those windows; early
// attempts also probe a morning slot to catch people who never answer
// afternoon calls.
const CADENCE = [
  { delayHours: 24, targetHour: 11 },   // 1->2: next day ~11am
  { delayHours: 24, targetHour: 16 },   // 2->3: +1 day ~4pm
  { delayHours: 48, targetHour: 9 },    // 3->4: +2 days ~9am
  { delayHours: 48, targetHour: 14 },   // 4->5: +2 days ~2pm
  { delayHours: 72, targetHour: 16 },   // 5->6: +3 days ~4pm
];

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

function computeNextAttemptAt(attemptNumber, lastAttemptAt) {
  const idx = attemptNumber - 1; // CADENCE index for the next attempt
  if (idx >= CADENCE.length) return null; // Exhausted

  const { delayHours, targetHour } = CADENCE[idx];
  const base = new Date(lastAttemptAt);
  base.setHours(base.getHours() + delayHours);

  // Snap to the target window with +/-30 min jitter (avoids robotic precision)
  const jitter = Math.floor(Math.random() * 61) - 30;
  base.setHours(targetHour, jitter, 0, 0);

  // If the computed time already passed, push to the same window tomorrow
  if (base.getTime() < Date.now()) {
    base.setDate(base.getDate() + 1);
    base.setHours(targetHour, jitter, 0, 0);
  }

  return base.toISOString();
}

async function getDueForRedial() {
  const leads = await readLeads();
  const now = new Date().toISOString();

  return leads.filter(l => {
    if (l.do_not_call) return false;
    if (l.status === 'booked' || l.status === 'website_sent') return false;

    const attempts = l.call_attempts || 0;
    if (attempts >= MAX_ATTEMPTS) return false;

    const retryable = RETRYABLE_OUTCOMES.includes(l.contact_outcome) ||
                      CALLBACK_STATUSES.includes(l.status);
    if (!retryable) return false;

    // Safety: don't rapid-fire if a call was just triggered
    if (l.last_attempt_at && hoursSince(l.last_attempt_at) < 1) return false;

    // Primary gate: next_attempt_at must be reached (or null for legacy leads)
    if (l.next_attempt_at && l.next_attempt_at > now) return false;

    return true;
  });
}

// Builds a short plain-English recap of the lead's situation so the
// follow-up assistant (which is prompted to *expect* this context) knows
// why it's calling again instead of opening cold.
function buildLastContext(lead) {
  const parts = [];
  if (lead.status === 'bad_contact') parts.push('they were interested but their email/contact info came through unclear on the call');
  else if (lead.status === 'wants_website_pending') parts.push('they asked for a website to be built and sent to them');
  else if (lead.status === 'callback_requested') parts.push('they asked to be called back at a better time');
  else if (lead.status === 'declined') parts.push('they were hesitant, but not a firm no');
  else if (lead.status === 'queued' || !lead.call_attempts) parts.push('this is the first time we are calling them — no prior contact yet');
  else parts.push('they did not pick up on the last attempt');
  if (lead.objection) parts.push(`their stated reason/objection was: ${lead.objection}`);
  if (lead.zoom_time) parts.push(`they had discussed a time of: ${lead.zoom_time}`);
  return parts.join('; ');
}

// Every call this function makes is, by definition, a *repeat* touch —
// either the auto-redial cron working through attempts 2-6, or a CSV
// campaign re-engaging leads that already have history. Both belong to
// the follow-up assistant (VAPI_FOLLOWUP_ASSISTANT_ID), which is the one
// actually prompted to handle "we're calling again" — the main assistant
// has no such instructions and would open as if it were a fresh cold call.
async function redial(lead) {
  const res = await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId: process.env.VAPI_FOLLOWUP_ASSISTANT_ID,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: lead.phone },
      assistantOverrides: {
        variableValues: {
          name: lead.name || 'there',
          business: lead.name || 'your business',
          last_context: buildLastContext(lead),
          attempt_number: String((lead.call_attempts || 1) + 1)
        }
      }
    })
  });
  if (!res.ok) throw new Error(`Vapi call failed for ${lead.phone}: ${res.status}`);

  // Safety buffer: if the webhook never fires (call drops, API hiccup), retry
  // in 1h instead of leaving next_attempt_at stuck in the past forever
  const leads = await readLeads();
  const idx = leads.findIndex(l => l.id === lead.id);
  if (idx !== -1) {
    const buffer = new Date();
    buffer.setHours(buffer.getHours() + 1);
    leads[idx].next_attempt_at = buffer.toISOString();
    await writeLeads(leads);
  }
}

module.exports = {
  getDueForRedial,
  redial,
  computeNextAttemptAt,
  MAX_ATTEMPTS,
  RETRYABLE_OUTCOMES,
  CALLBACK_STATUSES
};
