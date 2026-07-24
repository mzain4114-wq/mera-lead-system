// requeue-check.js
// Redials leads stuck on no_answer / voicemail / callback_requested,
// up to MAX_ATTEMPTS, spaced HOURS_BETWEEN_ATTEMPTS apart.

const { readLeads, writeLeads } = require('./leads-store');

const MAX_ATTEMPTS = 6;
const HOURS_BETWEEN_ATTEMPTS = 24;
const REDIAL_STATUSES = ['no_answer', 'voicemail', 'callback_requested'];

function hoursSince(iso) {
  return (Date.now() - new Date(iso).getTime()) / 36e5;
}

function getDueForRedial() {
  const leads = readLeads();
  return leads.filter(l =>
    REDIAL_STATUSES.includes(l.status) &&
    (l.call_attempts || 1) < MAX_ATTEMPTS &&
    hoursSince(l.last_attempt_at || l.time) >= HOURS_BETWEEN_ATTEMPTS
  );
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

  const leads = readLeads();
  const idx = leads.findIndex(l => l.id === lead.id);
  if (idx !== -1) {
    leads[idx].call_attempts = (leads[idx].call_attempts || 1) + 1;
    leads[idx].last_attempt_at = new Date().toISOString();
    writeLeads(leads);
  }
}

module.exports = { getDueForRedial, redial, MAX_ATTEMPTS, REDIAL_STATUSES };
