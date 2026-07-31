require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const twilio = require('twilio');
const multer = require('multer');
const XLSX = require('xlsx');
const {
  readLeads, upsertLead, toDashboardOutcome, writeLeads,
  updateLeadById, markDoNotCall, mapEndedReason, endedReasonLabel, appendNotification,
  importLeads, getBatches
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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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


// ---------- follow-up calling (re-engages a lead via a dedicated Vapi assistant) ----------
function buildLastContext(lead) {
  const parts = [];
  if (lead.status === 'bad_contact') parts.push('they were interested but their email/contact info came through unclear on the call');
  else if (lead.status === 'wants_website_pending') parts.push('they asked for a website to be built and sent to them');
  else if (lead.status === 'callback_requested') parts.push('they asked to be called back at a better time');
  else if (lead.status === 'declined') parts.push('they were hesitant, but not a firm no');
  else parts.push('they did not pick up on the last attempt');
  if (lead.objection) parts.push(`their stated reason/objection was: ${lead.objection}`);
  if (lead.zoom_time) parts.push(`they had discussed a time of: ${lead.zoom_time}`);
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

// ---------- Vapi webhook: classifies outcome from call.endedReason (telephony
// truth), drives the follow-up cadence, and fires the right post-call action ----------
app.post('/webhook/vapi', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== process.env.VAPI_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const msg = req.body.message || req.body;

  // Vapi fires several message types per call to this same URL (status-update,
  // speech-update, transcript, conversation-update, end-of-call-report...).
  // Only end-of-call-report carries the final endedReason + analysis — acting
  // on any earlier one writes a lead with no phone/email/summary yet, which
  // is exactly what produces "unknown" / declined-with-no-email rows.
  if (msg.type && msg.type !== 'end-of-call-report') {
    return res.sendStatus(200);
  }

  const call = msg.call || {};
  const data = msg.analysis?.structuredData || {};
  const phone = call.customer?.number || 'unknown';
  const name = call.customer?.name || phone;
  const endedReason = call.endedReason || null;
  const assistantId = call.assistantId || call.assistant?.id || null;
  // Vapi's summaryPlan output — a plain-English recap of what happened on the
  // call. This is what lets you glance at Follow Up and know *why* without
  // re-listening to the recording.
  const callSummary = msg.analysis?.summary || msg.summary || null;

  console.log(`[vapi webhook] type=${msg.type || 'n/a'} endedReason=${endedReason} phone=${phone} hasAnalysis=${!!msg.analysis} hasStructuredData=${Object.keys(data).length > 0}`);

  const contactOutcome = mapEndedReason(endedReason);
  const status = resolveStatus(data);

  const lead = await upsertLead({
    phone,
    name,
    email: data.email || null,
    status,
    contact_outcome: contactOutcome,
    ended_reason: endedReason,
    call_summary: callSummary,
    call_assistant_id: assistantId,
    zoom_time: data.zoom_time || null,
    objection: data.objection || null,
    call_id: call.id
  });

  // Compute next auto-attempt time (staggered cadence with time-of-day windows)
  const attempts = lead.call_attempts || 1;
  const nextAt = computeNextAttemptAt(attempts, lead.last_attempt_at);
  if (nextAt !== null) {
    await updateLeadById(lead.id, { next_attempt_at: nextAt });
  }

  // Every Slack/email/SMS fired below also gets logged against the lead so
  // it's visible on the dashboard, not just in the Slack channel history.
  async function notify(channel, text, sendFn) {
    try {
      await sendFn();
    } finally {
      await appendNotification(lead.id, { channel, text }).catch(() => {});
    }
  }

  try {
    if (status === 'booked') {
      if (!lead.email) {
        await notify('slack', `Zoom booked with ${name} but no email captured — needs manual follow-up.`,
          () => sendSlack(`⚠️ Zoom booked with *${name}* but no email captured. Manual follow-up needed.`));
      } else {
        const joinUrl = await createZoomMeeting(`Call with ${name} — Alpha Logics`, data.zoom_time);
        const emailText = `Hi ${name},\n\nYou're confirmed for a quick call about your website${data.zoom_time ? ' on ' + data.zoom_time : ''}.\n\nJoin here: ${joinUrl}\n\nWe'll walk through what you're looking for and how we can help — should take about 15 minutes, no pressure either way.\n\nTalk soon,\nAlpha Logics`;
        await notify('email', `Sent Zoom confirmation to ${lead.email}`,
          () => sendEmail(lead.email, `Your call is booked${data.zoom_time ? ' — ' + data.zoom_time : ''}`, emailText));
      }
      await notify('slack', `Zoom booked with ${name}${data.zoom_time ? ' for ' + data.zoom_time : ''} — confirmation emailed.`,
        () => sendSlack(`✅ Zoom booked with *${name}*${data.zoom_time ? ' for ' + data.zoom_time : ''} — confirmation emailed.`));
    } else if (status === 'wants_website_pending') {
      await notify('slack', `${name} wants their site emailed once it's built.`,
        () => sendSlack(`🔨 *${name}* wants their site emailed.\nLead #${lead.id} — ${lead.email}\nReply: \`/send ${lead.id} https://link.com\` when it's ready.`));
    } else if (status === 'bad_contact') {
      await notify('slack', `${name} was interested but contact info was unclear — needs a manual callback.`,
        () => sendSlack(`📞 *${name}* was interested but the contact info didn't come through clean. Lead #${lead.id} — worth a manual callback.`));
    } else if (contactOutcome === 'voicemail' || contactOutcome === 'no_answer') {
      // SMS nudge only on the first miss
      if (attempts === 1) {
        await notify('sms', `Sent "tried reaching you" text nudge.`,
          () => sendSms(phone, `Hi, this is Alpha Logics — tried reaching you about your website. Reply here anytime, or we'll try again soon.`));
      }
      // Silent-drop follow-up: attempt 3+ that hits voicemail gets an email
      // instead of yet another voicemail (repeated VMs read as spammy)
      if (attempts >= 3 && lead.email && contactOutcome === 'voicemail') {
        await notify('email', `Sent silent-drop follow-up email (attempt ${attempts}, went to voicemail).`,
          () => sendEmail(
            lead.email,
            'Quick follow-up from Alpha Logics',
            `Hi ${name || 'there'},\n\nWe tried calling but missed you. If you're still interested in a free website review, just reply to this email or call us back.\n\nNo pressure either way.\n\nAlpha Logics`
          )).catch(() => {});
      }
    } else if (contactOutcome === 'busy') {
      await notify('slack', `${name} was busy — auto-retry scheduled for next window.`,
        () => sendSlack(`📞 *${name}* was busy. Auto-retry scheduled for next window. Lead #${lead.id}`));
    }
  } catch (e) {
    console.error('Post-call action failed:', e.message, e.code, e.stack);
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
      await appendNotification(lead.id, { channel: 'email', text: `Sent finished website link: ${url}` }).catch(() => {});
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
      ended_reason_label: endedReasonLabel(l.ended_reason),
      call_summary: l.call_summary || null,
      notifications: l.notifications || []
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

// ---------- Follow-up tab: everyone who needs a human, a callback, or an auto-redial ----------
// Note: 'declined' (an explicit no during a connected call) is deliberately
// excluded here — only genuinely-missed contact (no answer, voicemail, busy,
// unclear info, callback requests) belongs in the active Follow Up queue.
// A firm decline still shows up in the Leads tab, just not as "needs action".
const FOLLOWUP_STATUSES = ['bad_contact', 'wants_website_pending', 'callback_requested', 'no_answer', 'voicemail'];
const CALLABLE_BY_AGENT = ['bad_contact', 'callback_requested', 'no_answer', 'voicemail'];
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
  if (CALLABLE_BY_AGENT.includes(lead.status) || RETRYABLE_OUTCOMES.includes(lead.contact_outcome)) {
    const next = lead.next_attempt_at ? new Date(lead.next_attempt_at).toLocaleString() : 'soon';
    const reason = endedReasonLabel(lead.ended_reason);
    const detail = `Attempt ${lead.call_attempts || 1}/${MAX_ATTEMPTS} · ${reason} · next: ${next}`;
    return { kind: 'call', label: 'Call now', detail };
  }
  return { kind: 'none', label: '—', detail: '' };
}

app.get('/api/followup', requireKey, async (req, res) => {
  const leads = (await readLeads())
    .filter(l => FOLLOWUP_STATUSES.includes(l.status) || RETRYABLE_OUTCOMES.includes(l.contact_outcome))
    .filter(l => !l.do_not_call || req.query.show === 'all')
    .sort((a, b) => new Date(b.last_attempt_at || b.time) - new Date(a.last_attempt_at || a.time))
    .map(l => {
      const exhausted = (l.call_attempts || 0) >= MAX_ATTEMPTS;
      return {
        ...l,
        action: followUpAction(l),
        exhausted,
        next_attempt_at: l.next_attempt_at || null,
        contact_outcome: l.contact_outcome || 'unknown',
        ended_reason_label: endedReasonLabel(l.ended_reason),
        call_summary: l.call_summary || null,
        notifications: l.notifications || []
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

    // Compute next auto-attempt window off the back of this manual trigger too
    const nextAt = computeNextAttemptAt(leads[idx].call_attempts || 1, leads[idx].last_attempt_at);
    if (nextAt !== null) leads[idx].next_attempt_at = nextAt;

    await writeLeads(leads);

    await sendSlack(`📞 Follow-up call triggered for *${lead.name}* (#${lead.id}) from the dashboard.`).catch(() => {});
    res.json({ ok: true, callId: call.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Mark lead as Do-Not-Call from dashboard — the permanent safety net
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

// ---------- CSV/Excel batch import + manual campaign start ----------
// Old-lead spreadsheets go here. Import only queues them — nothing gets
// called until you hit "Start Campaign" for that batch from the dashboard.
function normalizeImportRow(row) {
  const out = {};
  Object.keys(row).forEach(k => {
    const key = k.trim().toLowerCase();
    if (key.includes('phone')) out.phone = row[k];
    else if (key.includes('email')) out.email = row[k];
    else if (key.includes('name')) out.name = row[k];
  });
  return out;
}

app.post('/api/leads/import', requireKey, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded — attach a .csv or .xlsx file.' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw:false keeps phone numbers as formatted text instead of letting
    // Excel/XLSX coerce them into numbers (which silently drops a leading +)
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    const rows = rawRows.map(normalizeImportRow).filter(r => r.phone);

    if (!rows.length) {
      return res.status(400).json({ ok: false, error: 'No rows with a usable phone number found. Make sure a column header contains "phone".' });
    }

    const batchId = 'batch_' + Date.now();
    const batchName = (req.body && req.body.batchName) || req.file.originalname || batchId;
    const result = await importLeads(rows, batchId, batchName);

    await sendSlack(`📥 Imported *${batchName}* — ${result.total} leads (${result.inserted} new, ${result.updated} re-queued from existing). Nothing will be called until you hit Start in the Import tab.`).catch(() => {});
    res.json({ ok: true, batchId, batchName, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/batches', requireKey, async (req, res) => {
  try {
    const batches = await getBatches();
    res.json({ batches });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/campaign/start', requireKey, async (req, res) => {
  const { batchId } = req.body || {};
  if (!batchId) return res.status(400).json({ ok: false, error: 'batchId required' });

  const leads = await readLeads();
  const targets = leads.filter(l => l.batch_id === batchId && l.status === 'queued' && !l.do_not_call);
  if (!targets.length) {
    return res.status(404).json({ ok: false, error: 'No queued leads in this batch — it may already be started, or every lead in it is marked Do-Not-Call.' });
  }

  // Respond immediately; dialing continues in the background, staggered so
  // Vapi/your phone number isn't hit with every call at once.
  res.json({ ok: true, queued: targets.length });

  (async () => {
    await sendSlack(`▶️ Starting campaign *${targets[0].batch_name || batchId}* — dialing ${targets.length} leads, spaced ~20s apart.`).catch(() => {});
    for (let i = 0; i < targets.length; i++) {
      const lead = targets[i];
      try {
        await updateLeadById(lead.id, { status: 'campaign_calling' });
        await redial(lead);
      } catch (e) {
        console.error(`Campaign call failed for lead ${lead.id}:`, e.message);
        // Let it be retried by a future Start click instead of getting stuck
        await updateLeadById(lead.id, { status: 'queued' }).catch(() => {});
      }
      if (i < targets.length - 1) await new Promise(r => setTimeout(r, 20000));
    }
    await sendSlack(`✅ Finished dialing all ${targets.length} leads in batch *${targets[0].batch_name || batchId}*. Outcomes will land in Follow Up as calls complete.`).catch(() => {});
  })();
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
