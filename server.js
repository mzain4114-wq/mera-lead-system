require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const {
  readLeads, upsertLead, toDashboardOutcome, writeLeads,
  updateLeadById, markDoNotCall, mapEndedReason
} = require('./leads-store');
const {
  getDueForRedial, redial, computeNextAttemptAt, MAX_ATTEMPTS
} = require('./requeue-check');

const path = require('path');
const app = express();
app.use(express.json());
app.use('/webhook/slack', express.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST');
  next();
});

function requireKey(req, res, next) {
  const key = req.query.key || req.headers['x-dashboard-key'];
  if (!process.env.DASHBOARD_KEY) {
    return res.status(500).json({ error: 'DASHBOARD_KEY not configured on the server' });
  }
  if (key !== process.env.DASHBOARD_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/dashboard', requireKey, async (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

async function sendEmail(to, subject, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.HOSTINGER_EMAIL,
      to: [to],
      subject,
      text
    })
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function sendSlack(text) {
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text })
  });
}

function verifySlackRequest(req) {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  if (!signature || !timestamp || !req.rawBody) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;
  const base = `v0:${timestamp}:${req.rawBody}`;
  const expected = 'v0=' + crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET).update(base).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

async function sendSms(to, body) {
  if (!twilioClient || !process.env.TWILIO_TOLLFREE_NUMBER) return;
  try {
    await twilioClient.messages.create({ to, from: process.env.TWILIO_TOLLFREE_NUMBER, body });
  } catch (e) {
    console.error('SMS send failed:', e.message);
  }
}

let zoomTokenCache = { token: null, expiresAt: 0 };

async function getZoomAccessToken() {
  if (zoomTokenCache.token && Date.now() < zoomTokenCache.expiresAt) {
    return zoomTokenCache.token;
  }
  const params = new URLSearchParams({
    grant_type: 'account_credentials',
    account_id: process.env.ZOOM_ACCOUNT_ID
  });
  const auth = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch(`https://zoom.us/oauth/token?${params}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}` }
  });
  if (!resp.ok) {
    throw new Error(`Zoom token request failed: ${resp.status} ${await resp.text()}`);
  }
  const json = await resp.json();
  zoomTokenCache = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return json.access_token;
}

function buildLastContext(lead) {
  const parts = [];
  if (lead.status === 'bad_contact') parts.push('they were interested but their email/contact info came through unclear on the call');
  else if (lead.status === 'wants_website_pending') parts.push('they asked for a website to be built and sent to them');
  else if (lead.status === 'callback_requested') parts.push('they asked to be called back at a better time');
  else if (lead.status === 'declined') parts.push('they were hesitant, but not a firm no');
  else if (lead.status === 'booked') parts.push('they booked a Zoom meeting');
  else if (lead.status === 'website_sent') parts.push('their website link was already sent');
  else parts.push('they did not pick up on the last attempt');
  if (lead.objection) parts.push(`their stated reason/objection was: "${lead.objection}"`);
  if (lead.zoom_time) parts.push(`they had discussed a time of: ${lead.zoom_time}`);
  if (lead.ended_reason) parts.push(`call ended because: ${lead.ended_reason}`);
  return parts.join('; ');
}

async function triggerFollowUpCall(lead) {
  const resp = await fetch('https://api.vapi.ai/call', {
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
          attempt_number: String((lead.follow_up_attempts || 0) + 1)
        }
      }
    })
  });
  if (!resp.ok) {
    throw new Error(`Vapi follow-up call failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function createZoomMeeting(topic, zoomTimeRaw) {
  const token = await getZoomAccessToken();
  const parsed = zoomTimeRaw ? new Date(zoomTimeRaw) : null;
  const hasValidTime = parsed && !isNaN(parsed.getTime());

  const body = hasValidTime
    ? {
        topic,
        type: 2,
        start_time: parsed.toISOString(),
        duration: 30,
        timezone: 'UTC',
        settings: { join_before_host: true, waiting_room: false }
      }
    : {
        topic,
        type: 1,
        settings: { join_before_host: true, waiting_room: false }
      };

  const resp = await fetch('https://api.zoom.us/v2/users/me/meetings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    throw new Error(`Zoom meeting creation failed: ${resp.status} ${await resp.text()}`);
  }
  const meeting = await resp.json();
  return meeting.join_url;
}

function resolveStatus(data) {
  if (data.ivr_detected) return 'voicemail';
  if (!data.interested) {
    return data.call_outcome === 'no_answer' ? 'no_answer' : 'declined';
  }
  if (data.zoom_scheduled) return 'booked';
  if (data.wants_website) {
    const goodEmail = data.email && data.email_confidence === 'high';
    return goodEmail ? 'wants_website_pending' : 'bad_contact';
  }
  if (data.best_callback_time) return 'callback_requested';
  return 'bad_contact';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  Webhook & API routes
// ═══════════════════════════════════════════════════════════════════════════════

app.post('/webhook/vapi', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== process.env.VAPI_WEBHOOK_SECRET) return res.sendStatus(401);

  const msg = req.body.message || req.body;
  const call = msg.call || {};
  const data = msg.analysis?.structuredData || {};
  const summary = msg.analysis?.summary || null;
  const phone = call.customer?.number || 'unknown';
  const name = call.customer?.name || phone;
  const endedReason = call.endedReason || null;
  const assistantId = call.assistantId || call.assistant?.id || null;
  const contactOutcome = mapEndedReason(endedReason);
  const status = resolveStatus(data);

  const lead = await upsertLead({
    phone, name,
    email: data.email || null,
    status,
    contact_outcome: contactOutcome,
    ended_reason: endedReason,
    call_assistant_id: assistantId,
    zoom_time: data.zoom_time || null,
    objection: data.objection || null,
    call_id: call.id,
    call_summary: summary
  });

  const attempts = lead.call_attempts || 1;
  const nextAt = computeNextAttemptAt(attempts, lead.last_attempt_at);
  if (nextAt !== null) await updateLeadById(lead.id, { next_attempt_at: nextAt });

  try {
    if (status === 'booked') {
      if (!lead.email) {
        await sendSlack(`⚠️ Zoom booked with *${name}* but no email captured. Manual follow-up needed.`);
      } else {
        const joinUrl = await createZoomMeeting(`Call with ${name} — Alpha Logics`, data.zoom_time);
        await sendEmail(lead.email, `Your call is booked${data.zoom_time ? ' — ' + data.zoom_time : ''}`,
          `Hi ${name},\n\nYou're confirmed for a quick call about your website${data.zoom_time ? ' on ' + data.zoom_time : ''}.\n\nJoin here: ${joinUrl}\n\nWe'll walk through what you're looking for and how we can help — should take about 15 minutes, no pressure either way.\n\nTalk soon,\nAlpha Logics`
        );
      }
      await sendSlack(`✅ Zoom booked with *${name}*${data.zoom_time ? ' for ' + data.zoom_time : ''} — confirmation emailed.`);
    } else if (status === 'wants_website_pending') {
      await sendSlack(`🔨 *${name}* wants their site emailed.\nLead #${lead.id} — ${lead.email}\nReply: \`/send ${lead.id} https://link.com\` when it's ready.`);
    } else if (status === 'bad_contact') {
      await sendSlack(`📞 *${name}* was interested but the contact info didn't come through clean. Lead #${lead.id} — worth a manual callback.`);
    } else if (contactOutcome === 'voicemail' || contactOutcome === 'no_answer') {
      if (attempts === 1) {
        await sendSms(phone, `Hi, this is Alpha Logics — tried reaching you about your website. Reply here anytime, or we'll try again soon.`);
      }
      if (attempts >= 3 && lead.email && contactOutcome === 'voicemail') {
        await sendEmail(lead.email, 'Quick follow-up from Alpha Logics',
          `Hi ${name || 'there'},\n\nWe tried calling but missed you. If you're still interested in a free website review, just reply to this email or call us back.\n\nNo pressure either way.\n\nAlpha Logics`
        ).catch(() => {});
      }
    } else if (contactOutcome === 'busy') {
      await sendSlack(`📞 *${name}* was busy. Auto-retry scheduled. Lead #${lead.id}`);
    }
  } catch (e) {
    console.error('Post-call action failed:', e.message);
    await sendSlack(`⚠️ Action failed for lead #${lead.id} (${name}): ${e.message}`).catch(() => {});
  }

  res.sendStatus(200);
});

app.post('/webhook/slack', async (req, res) => {
  if (!verifySlackRequest(req)) return res.sendStatus(401);

  const cmd = req.body.command;
  const [idStr, url] = (req.body.text || '').trim().split(/\s+/);

  if (cmd === '/send' && idStr && url) {
    const leads = await readLeads();
    const lead = leads.find(l => String(l.id) === idStr);
    if (!lead) {
      await sendSlack(`No lead found with id ${idStr}.`);
      return res.sendStatus(200);
    }
    try {
      await sendEmail(
        lead.email,
        'Your website is ready',
        `Hi ${lead.name},\n\nYour website is ready — take a look here: ${url}\n\nLet us know if you'd like any changes or have any questions.\n\nTalk soon,\nAlpha Logics`
      );
      const all = await readLeads();
      const idx = all.findIndex(l => l.id === lead.id);
      all[idx].status = 'website_sent';
      await writeLeads(all);
      await sendSlack(`✅ Sent to *${lead.name}* (#${lead.id}).`);
    } catch (e) {
      await sendSlack(`⚠️ Failed to send to #${lead.id}: ${e.message}`);
    }
  } else if (cmd === '/pending') {
    const pending = (await readLeads()).filter(l => l.status === 'wants_website_pending');
    const list = pending.length
      ? pending.map(l => `#${l.id} — ${l.name}`).join('\n')
      : 'Nothing pending.';
    await sendSlack(`🔨 Waiting on you:\n${list}`);
  }

  res.sendStatus(200);
});

app.get('/api/leads', requireKey, async (req, res) => {
  const leads = [...await readLeads()]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .map(l => ({
      ...l,
      outcome: toDashboardOutcome(l.status),
      contact_outcome: l.contact_outcome || l.status || 'unknown'
    }));
  res.json({ leads });
});

app.get('/api/stats', requireKey, async (req, res) => {
  const leads = await readLeads();
  const pulse = [...leads]
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-60)
    .map(l => toDashboardOutcome(l.status));
  res.json({ totalCalls: leads.length, pulse });
});

app.get('/leads/pending', requireKey, async (req, res) => {
  res.json((await readLeads()).filter(l => l.status === 'wants_website_pending'));
});

app.get('/leads/needs-follow-up', requireKey, async (req, res) => {
  res.json((await readLeads()).filter(l => l.status === 'bad_contact'));
});

// ── Follow-up tab logic ──────────────────────────────────────────────────────
const FOLLOWUP_STATUSES = ['bad_contact', 'wants_website_pending', 'callback_requested'];
const CALLABLE_BY_AGENT = ['bad_contact', 'callback_requested'];
const RETRYABLE_OUTCOMES = ['no_answer', 'voicemail', 'busy', 'failed'];

function followUpAction(lead) {
  if (lead.do_not_call) {
    return { kind: 'none', label: 'DNC', detail: 'Lead requested no further contact.' };
  }
  if ((lead.call_attempts || 0) >= MAX_ATTEMPTS) {
    return { kind: 'none', label: 'Exhausted', detail: `All ${MAX_ATTEMPTS} attempts used. Manual decision needed.` };
  }
  if (lead.status === 'wants_website_pending') {
    return { kind: 'send_link', label: 'Build & send site', detail: `Reply /send ${lead.id} <url> in Slack.` };
  }
  const effectiveOutcome = lead.contact_outcome || lead.status;
  if (CALLABLE_BY_AGENT.includes(lead.status) || RETRYABLE_OUTCOMES.includes(effectiveOutcome)) {
    const next = lead.next_attempt_at ? new Date(lead.next_attempt_at).toLocaleString() : 'soon';
    const detail = `Attempt ${lead.call_attempts || 1}/${MAX_ATTEMPTS} · ${effectiveOutcome} · next: ${next}`;
    return { kind: 'call', label: 'Call now', detail };
  }
  return { kind: 'none', label: '—', detail: '' };
}

app.get('/api/followup', requireKey, async (req, res) => {
  const leads = (await readLeads())
    .filter(l => {
      const effectiveOutcome = l.contact_outcome || l.status;
      return FOLLOWUP_STATUSES.includes(l.status) || RETRYABLE_OUTCOMES.includes(effectiveOutcome);
    })
    .filter(l => !l.do_not_call || req.query.show === 'all')
    .sort((a, b) => new Date(b.last_attempt_at || b.time) - new Date(a.last_attempt_at || a.time))
    .map(l => {
      const exhausted = (l.call_attempts || 0) >= MAX_ATTEMPTS;
      const effectiveOutcome = l.contact_outcome || l.status || 'unknown';
      return {
        ...l,
        action: followUpAction(l),
        exhausted,
        next_attempt_at: l.next_attempt_at || null,
        contact_outcome: effectiveOutcome,
        last_context: buildLastContext(l)
      };
    });
  res.json({ leads });
});

app.post('/api/followup/trigger', requireKey, async (req, res) => {
  const { leadId } = req.body || {};
  if (!leadId) return res.status(400).json({ ok: false, error: 'leadId required' });

  try {
    const leads = await readLeads();
    const lead = leads.find(l => String(l.id) === String(leadId));
    if (!lead) return res.status(404).json({ ok: false, error: `No lead found with id ${leadId}` });
    if (lead.do_not_call) return res.status(403).json({ ok: false, error: 'Lead is marked Do-Not-Call' });

    const call = await triggerFollowUpCall(lead);

    const idx = leads.findIndex(l => l.id === lead.id);
    leads[idx].follow_up_attempts = (lead.follow_up_attempts || 0) + 1;
    leads[idx].last_attempt_at = new Date().toISOString();

    const nextAt = computeNextAttemptAt(leads[idx].call_attempts || 1, leads[idx].last_attempt_at);
    if (nextAt !== null) leads[idx].next_attempt_at = nextAt;

    await writeLeads(leads);

    await sendSlack(`📞 Follow-up call triggered for *${lead.name}* (#${lead.id}) from the dashboard.`).catch(() => {});
    res.json({ ok: true, callId: call.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/dnc', requireKey, async (req, res) => {
  const { leadId } = req.body || {};
  if (!leadId) return res.status(400).json({ ok: false, error: 'leadId required' });
  try {
    await markDoNotCall(leadId);
    await sendSlack(`🚫 Lead #${leadId} marked Do-Not-Call from the dashboard.`).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Cron / manual trigger (legacy GET route, kept for backward compat) ───────
app.get('/followup/trigger', async (req, res) => {
  if (req.query.key !== process.env.CRON_SECRET) return res.sendStatus(401);
  const leadId = req.query.leadId;
  if (!leadId) return res.status(400).json({ error: 'leadId query param required' });

  try {
    const leads = await readLeads();
    const lead = leads.find(l => String(l.id) === String(leadId));
    if (!lead) return res.status(404).json({ error: `No lead found with id ${leadId}` });

    const call = await triggerFollowUpCall(lead);
    res.json({ ok: true, callId: call.id, calledContext: buildLastContext(lead) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/cron/redial', async (req, res) => {
  if (req.query.key !== process.env.CRON_SECRET) return res.sendStatus(401);
  const due = await getDueForRedial();
  const results = [];
  for (const lead of due) {
    try {
      await redial(lead);
      results.push({ id: lead.id, phone: lead.phone, status: 'redialed' });
    } catch (e) {
      results.push({ id: lead.id, phone: lead.phone, status: 'failed', error: e.message });
    }
  }
  res.json({ redialed: results.length, results });
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get('/diag/email', async (req, res) => {
  if (req.query.key !== process.env.CRON_SECRET) return res.sendStatus(401);
  const start = Date.now();
  try {
    const info = await sendEmail(process.env.HOSTINGER_EMAIL, 'Railway diagnostic', 'Testing Resend API from Railway.');
    res.json({ ok: true, ms: Date.now() - start, response: info });
  } catch (e) {
    res.json({ ok: false, ms: Date.now() - start, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mera lead system running on port ${PORT}`));
