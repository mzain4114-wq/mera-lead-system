const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function readLeads() {
  const { data, error } = await supabase.from('leads').select('*');
  if (error) throw new Error(`Supabase readLeads failed: ${error.message}`);
  return data || [];
}

async function writeLeads(leads) {
  const { error } = await supabase.from('leads').upsert(leads, { onConflict: 'id' });
  if (error) throw new Error(`Supabase writeLeads failed: ${error.message}`);
}

async function updateLeadById(id, fields) {
  const { error } = await supabase.from('leads').update(fields).eq('id', id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
}

async function markDoNotCall(id) {
  const { error } = await supabase.from('leads')
    .update({ do_not_call: true, status: 'declined', contact_outcome: 'declined_permanent' })
    .eq('id', id);
  if (error) throw new Error(`Supabase DNC update failed: ${error.message}`);
}

function toDashboardOutcome(status) {
  switch (status) {
    case 'booked': return 'booked';
    case 'website_sent': return 'sent';
    case 'wants_website_pending': return 'pending';
    case 'bad_contact': return 'followup';
    case 'callback_requested': return 'followup';
    case 'declined': return 'declined';
    case 'no_answer': return 'no';
    case 'voicemail': return 'no';
    case 'queued': return 'pending';
    case 'campaign_calling': return 'pending';
    default: return 'no';
  }
}

// Maps Vapi's telephony-level call.endedReason into a reliable contact outcome.
// This is the source of truth for "did they pick up, voicemail, busy, etc." —
// more reliable than guessing from the transcript/structured data.
function mapEndedReason(endedReason) {
  if (!endedReason) return 'no_answer';
  const r = endedReason.toLowerCase();
  if (r === 'customer-did-not-answer') return 'no_answer';
  if (r === 'customer-busy') return 'busy';
  if (r === 'voicemail') return 'voicemail';
  if (r === 'customer-ended-call') return 'connected';
  if (r === 'silence-timed-out') return 'no_answer';
  if (r === 'exceeded-max-duration') return 'connected';
  if (r.startsWith('assistant-ended-call')) return 'connected';
  if (r === 'manually-canceled') return 'failed';
  if (r === 'worker-shutdown') return 'failed';
  if (r.startsWith('pipeline-error')) return 'failed';
  if (r.startsWith('call-start-error')) return 'failed';
  if (r === 'call-deleted') return 'failed';
  return 'failed';
}

// Safety net: if the lead explicitly says stop calling, permanently flag them
// regardless of what else is happening on the call — checked before every dial.
function hasDncLanguage(objection = '') {
  const dnc = ['stop calling', 'do not call', 'take me off', 'remove me', 'dnc', "don't call", 'never call'];
  return dnc.some(phrase => objection.toLowerCase().includes(phrase));
}

// Human-readable version of Vapi's raw endedReason, for the dashboard —
// so it reads "Went to voicemail" instead of "voicemail" or "customer-did-not-answer".
function endedReasonLabel(endedReason) {
  if (!endedReason) return 'Unknown / no data from Vapi';
  const map = {
    'customer-did-not-answer': 'No answer',
    'customer-busy': 'Line was busy',
    'voicemail': 'Went to voicemail',
    'customer-ended-call': 'Customer hung up',
    'silence-timed-out': 'No response (silence)',
    'exceeded-max-duration': 'Call completed (max duration hit)',
    'manually-canceled': 'Call was canceled',
    'worker-shutdown': 'System error (worker shutdown)',
    'call-deleted': 'Call was deleted',
  };
  if (map[endedReason]) return map[endedReason];
  if (endedReason.startsWith('assistant-ended-call')) return 'Assistant ended the call';
  if (endedReason.startsWith('pipeline-error')) return 'Technical error mid-call';
  if (endedReason.startsWith('call-start-error')) return 'Call failed to start';
  return endedReason.replace(/-/g, ' ');
}

// Read-modify-write log of every outbound touch (Slack, email, SMS) tied to a
// lead — so "what did we actually send them and when" is visible on the
// dashboard instead of only living in the Slack channel history.
async function appendNotification(id, entry) {
  const { data: existing, error: readErr } = await supabase.from('leads').select('notifications').eq('id', id).maybeSingle();
  if (readErr) throw new Error(`Supabase notification read failed: ${readErr.message}`);
  const notifications = [...(existing?.notifications || []), { ...entry, time: new Date().toISOString() }];
  const { error } = await supabase.from('leads').update({ notifications }).eq('id', id);
  if (error) throw new Error(`Supabase notification update failed: ${error.message}`);
  return notifications;
}

async function upsertLead(fields) {
  const now = new Date().toISOString();
  const { data: existing } = await supabase.from('leads').select('*').eq('phone', fields.phone).maybeSingle();

  if (!existing) {
    const lead = {
      id: Date.now(),
      call_attempts: 1,
      last_attempt_at: now,
      time: now,
      attempt_history: [],
      do_not_call: false,
      follow_up_attempts: 0,
      ...fields
    };
    const { error } = await supabase.from('leads').insert(lead);
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    return lead;
  }

  const isFollowUpCall = fields.call_assistant_id === process.env.VAPI_FOLLOWUP_ASSISTANT_ID;
  const updated = {
    ...existing,
    ...fields,
    last_attempt_at: now,
    call_attempts: isFollowUpCall ? (existing.call_attempts || 1) : (existing.call_attempts || 0) + 1,
    follow_up_attempts: isFollowUpCall ? (existing.follow_up_attempts || 0) + 1 : (existing.follow_up_attempts || 0)
  };

  // Append to the full attempt audit trail (not just a counter)
  const historyEntry = {
    time: now,
    outcome: fields.contact_outcome || existing.contact_outcome || 'unknown',
    channel: 'voice',
    ended_reason: fields.ended_reason || null,
    summary: fields.call_summary || null,
    attempt_number: isFollowUpCall ? (existing.follow_up_attempts || 0) + 1 : (existing.call_attempts || 0) + 1
  };
  updated.attempt_history = [...(existing.attempt_history || []), historyEntry];

  // DNC safety: if they explicitly said stop calling, this overrides everything else
  if (hasDncLanguage(fields.objection)) {
    updated.do_not_call = true;
    updated.contact_outcome = 'declined_permanent';
  }

  const { error } = await supabase.from('leads').update(updated).eq('id', existing.id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return updated;
}

// CSV/Excel phone columns show up in all kinds of shapes — "+15551234567",
// "5551234567", "(555) 123-4567", or (worst case) a bare number that lost its
// leading + when a spreadsheet app auto-formatted the cell. Vapi needs E.164
// (+15551234567), so normalize on the way in rather than failing calls later.
function normalizePhone(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (hasPlus) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;      // bare US number, no country code
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return '+' + digits; // assume country code is already present, just missing the +
}

// Bulk-import leads from a parsed CSV/Excel sheet (array of {name, phone, email}
// objects). Existing leads (matched by phone) get tagged into the new batch
// and reset to 'queued' so they re-enter the follow-up queue; leads with no
// phone are skipped since phone is how everything else in the system keys a lead.
async function importLeads(rows, batchId, batchName) {
  const now = new Date().toISOString();
  const { data: existingLeads, error: readErr } = await supabase.from('leads').select('id,phone');
  if (readErr) throw new Error(`Supabase import read failed: ${readErr.message}`);
  const existingByPhone = new Map((existingLeads || []).map(l => [l.phone, l.id]));

  const toInsert = [];
  const toUpdate = [];

  rows.forEach((row, i) => {
    const phone = normalizePhone(row.phone);
    if (!phone) return;
    if (existingByPhone.has(phone)) {
      toUpdate.push({ id: existingByPhone.get(phone), phone });
    } else {
      toInsert.push({
        id: Date.now() + i,
        phone,
        name: row.name || phone,
        email: row.email || null,
        status: 'queued',
        contact_outcome: null,
        call_attempts: 0,
        follow_up_attempts: 0,
        attempt_history: [],
        notifications: [],
        do_not_call: false,
        batch_id: batchId,
        batch_name: batchName,
        time: now,
        last_attempt_at: null,
        next_attempt_at: null
      });
    }
  });

  if (toInsert.length) {
    const { error } = await supabase.from('leads').insert(toInsert);
    if (error) throw new Error(`Supabase import insert failed: ${error.message}`);
  }
  for (const u of toUpdate) {
    // Re-queue an existing lead into this batch. Leaves their history intact —
    // only status/batch fields reset so they're eligible for a fresh campaign.
    const { error } = await supabase.from('leads').update({
      status: 'queued',
      batch_id: batchId,
      batch_name: batchName
    }).eq('id', u.id);
    if (error) throw new Error(`Supabase import update failed: ${error.message}`);
  }

  return { inserted: toInsert.length, updated: toUpdate.length, total: toInsert.length + toUpdate.length };
}

// Groups leads by batch_id for the Import tab — lets you see each uploaded
// list, how many are still queued (untouched) vs already dialed, and start
// or re-check a specific batch without affecting any others.
async function getBatches() {
  const leads = await readLeads();
  const map = new Map();
  leads.filter(l => l.batch_id).forEach(l => {
    if (!map.has(l.batch_id)) {
      map.set(l.batch_id, { batch_id: l.batch_id, batch_name: l.batch_name || l.batch_id, total: 0, queued: 0, started: 0, uploaded_at: l.time });
    }
    const b = map.get(l.batch_id);
    b.total += 1;
    if (l.status === 'queued') b.queued += 1; else b.started += 1;
    if (l.time && l.time < b.uploaded_at) b.uploaded_at = l.time;
  });
  return [...map.values()].sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
}

module.exports = {
  readLeads, writeLeads, upsertLead, updateLeadById, markDoNotCall,
  toDashboardOutcome, mapEndedReason, hasDncLanguage, endedReasonLabel, appendNotification,
  importLeads, getBatches, normalizePhone
};
