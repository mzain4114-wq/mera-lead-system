const { readLeads, writeLeads } = require('./leads-store');

const MAX_ATTEMPTS = 6;
const RETRYABLE_OUTCOMES = ['no_answer', 'voicemail', 'busy', 'failed'];
const CALLBACK_STATUSES = ['callback_requested'];

const CADENCE = [
  { delayHours: 24, targetHour: 11 },
  { delayHours: 24, targetHour: 16 },
  { delayHours: 48, targetHour: 9 },
  { delayHours: 48, targetHour: 14 },
  { delayHours: 72, targetHour: 16 },
];

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

function computeNextAttemptAt(attemptNumber, lastAttemptAt) {
  const idx = attemptNumber - 1;
  if (idx >= CADENCE.length) return null;
  const { delayHours, targetHour } = CADENCE[idx];
  const base = new Date(lastAttemptAt);
  base.setHours(base.getHours() + delayHours);
  const jitter = Math.floor(Math.random() * 61) - 30;
  base.setHours(targetHour, jitter, 0, 0);
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
    const retryable = RETRYABLE_OUTCOMES.includes(l.contact_outcome) || CALLBACK_STATUSES.includes(l.status);
    if (!retryable) return false;
    if (l.last_attempt_at && hoursSince(l.last_attempt_at) < 1) return false;
    if (l.next_attempt_at && l.next_attempt_at > now) return false;
    return true;
  });
}

async function redial(lead) {
  const res = await fetch('https://api.vapi.ai/call', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      assistantId: process.env.VAPI_ASSISTANT_ID,
      phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
      customer: { number: lead.phone, name: lead.name }
    })
  });
  if (!res.ok) throw new Error(`Vapi call failed for ${lead.phone}: ${res.status}`);

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
