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
    default: return 'no';
  }
}

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

function hasDncLanguage(objection = '') {
  const dnc = ['stop calling', 'do not call', 'take me off', 'remove me', 'dnc', "don't call", 'never call'];
  return dnc.some(phrase => objection.toLowerCase().includes(phrase));
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

  const historyEntry = {
    time: now,
    outcome: fields.contact_outcome || existing.contact_outcome || 'unknown',
    channel: 'voice',
    ended_reason: fields.ended_reason || null,
    attempt_number: isFollowUpCall ? (existing.follow_up_attempts || 0) + 1 : (existing.call_attempts || 0) + 1
  };
  updated.attempt_history = [...(existing.attempt_history || []), historyEntry];

  if (hasDncLanguage(fields.objection)) {
    updated.do_not_call = true;
    updated.contact_outcome = 'declined_permanent';
  }

  const { error } = await supabase.from('leads').update(updated).eq('id', existing.id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return updated;
}

module.exports = {
  readLeads, writeLeads, upsertLead, updateLeadById, markDoNotCall,
  toDashboardOutcome, mapEndedReason, hasDncLanguage
};
