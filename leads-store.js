// leads-store.js
// Single source of truth for reading/writing leads.json.
// Swap this file's internals for a Supabase client later —
// every other module only calls readLeads/writeLeads/upsertLead,
// so nothing else needs to change.

const fs = require('fs');
const path = require('path');
const LEADS_FILE = path.join(__dirname, 'leads.json');

function readLeads() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  const raw = fs.readFileSync(LEADS_FILE, 'utf8').trim();
  return raw ? JSON.parse(raw) : [];
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

// Maps our detailed status to the 5 buckets the dashboard understands.
function toDashboardOutcome(status) {
  switch (status) {
    case 'booked': return 'booked';
    case 'website_sent': return 'sent';
    case 'wants_website_pending': return 'pending';
    case 'bad_contact': return 'followup';
    default: return 'no'; // declined, no_answer, voicemail, callback_requested
  }
}

// Creates a new lead or updates an existing one (matched by phone number).
function upsertLead(fields) {
  const leads = readLeads();
  const idx = leads.findIndex(l => l.phone === fields.phone);
  const now = new Date().toISOString();

  if (idx === -1) {
    const lead = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      call_attempts: 1,
      last_attempt_at: now,
      time: now,
      ...fields
    };
    leads.push(lead);
    writeLeads(leads);
    return lead;
  }

  leads[idx] = { ...leads[idx], ...fields, last_attempt_at: now };
  writeLeads(leads);
  return leads[idx];
}

module.exports = { readLeads, writeLeads, upsertLead, toDashboardOutcome, LEADS_FILE };
