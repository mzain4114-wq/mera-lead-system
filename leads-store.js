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

function toDashboardOutcome(status) {
  switch (status) {
    case 'booked': return 'booked';
    case 'website_sent': return 'sent';
    case 'wants_website_pending': return 'pending';
    case 'bad_contact': return 'followup';
    case 'callback_requested': return 'followup';
    default: return 'no';
  }
}

async function upsertLead(fields) {
  const now = new Date().toISOString();
  const { data: existing } = await supabase.from('leads').select('*').eq('phone', fields.phone).maybeSingle();

  if (!existing) {
    const lead = { id: Date.now(), call_attempts: 1, last_attempt_at: now, time: now, ...fields };
    const { error } = await supabase.from('leads').insert(lead);
    if (error) throw new Error(`Supabase insert failed: ${error.message}`);
    return lead;
  }

  const updated = { ...existing, ...fields, last_attempt_at: now };
  const { error } = await supabase.from('leads').update(updated).eq('id', existing.id);
  if (error) throw new Error(`Supabase update failed: ${error.message}`);
  return updated;
}

module.exports = { readLeads, writeLeads, upsertLead, toDashboardOutcome };
