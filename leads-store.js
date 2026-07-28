const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function readLeads() {
  const { data, error } = await supabase
    .from('leads')
    .select('*');

  if (error) {
    throw new Error(`Supabase readLeads failed: ${error.message}`);
  }

  return data || [];
}

async function writeLeads(leads) {
  const { error } = await supabase
    .from('leads')
    .upsert(leads, { onConflict: 'id' });

  if (error) {
    throw new Error(`Supabase writeLeads failed: ${error.message}`);
  }
}

function toDashboardOutcome(status) {
  switch (status) {
    case 'booked':
      return 'booked';
    case 'website_sent':
      return 'sent';
    case 'wants_website_pending':
      return 'pending';
    case 'bad_contact':
      return 'followup';
    default:
      return 'no';
  }
}

async function upsertLead(fields) {
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await supabase
    .from('leads')
    .select('*')
    .eq('phone', fields.phone)
    .maybeSingle();

  if (readError) {
    throw new Error(`Supabase lookup failed: ${readError.message}`);
  }

  if (existing) {
    const updatedLead = {
      ...existing,
      ...fields,
      last_attempt_at: now
    };

    const { data, error } = await supabase
      .from('leads')
      .update(updatedLead)
      .eq('id', existing.id)
      .select()
      .single();

    if (error) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }

    return data;
  }

  const newLead = {
    id: Date.now(),
    call_attempts: 1,
    last_attempt_at: now,
    time: now,
    ...fields
  };

  const { data, error } = await supabase
    .from('leads')
    .insert(newLead)
    .select()
    .single();

  if (error) {
    if (
      error.code === '23505' ||
      (error.message && error.message.includes('duplicate key'))
    ) {
      const { data: existingLead, error: fetchError } = await supabase
        .from('leads')
        .select('*')
        .eq('phone', fields.phone)
        .single();

      if (fetchError) {
        throw new Error(`Supabase fetch failed: ${fetchError.message}`);
      }

      const mergedLead = {
        ...existingLead,
        ...fields,
        last_attempt_at: now
      };

      const { data: updated, error: updateError } = await supabase
        .from('leads')
        .update(mergedLead)
        .eq('id', existingLead.id)
        .select()
        .single();

      if (updateError) {
        throw new Error(`Supabase update failed: ${updateError.message}`);
      }

      return updated;
    }

    throw new Error(`Supabase insert failed: ${error.message}`);
  }

  return data;
}

module.exports = {
  readLeads,
  writeLeads,
  upsertLead,
  toDashboardOutcome
};
