require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { readLeads, upsertLead, toDashboardOutcome } = require('./leads-store');
const { getDueForRedial, redial } = require('./requeue-check');

const path = require('path');
const app = express();
app.use(express.json());

// Allow the dashboard to call this API even if it's ever hosted elsewhere.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST');
  next();
});

// ---------- dashboard auth ----------
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

// ---------- serve the dashboard itself ----------
app.get('/dashboard', requireKey, (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// ---------- mail ----------
const mailer = nodemailer.createTransport({
  host: process.env.HOSTINGER_SMTP_HOST,
  port: Number(process.env.HOSTINGER_SMTP_PORT || 465),
  secure: true,
  auth: { user: process.env.HOSTINGER_EMAIL, pass: process.env.HOSTINGER_PASSWORD }
});

async function sendEmail(to, subject, text) {
  return mailer.sendMail({ from: process.env.HOSTINGER_EMAIL, to, subject, text });
}

// ---------- telegram ----------
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' })
  });
}

// ---------- sms (toll-free fallback nudge) ----------
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

// ---------- zoom (server-to-server oauth, creates a real meeting per booking) ----------
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

// ---------- outcome mapping ----------
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

// ================= WEBHOOK: Vapi end-of-call report =================
app.post('/webhook/vapi', async (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (token !== process.env.VAPI_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const msg = req.body.message || req.body;
  const call = msg.call || {};
  const data = msg.analysis?.structuredData || {};
  const phone = call.customer?.number || 'unknown';
  const name = call.customer?.name || phone;

  const status = resolveStatus(data);
  const lead = upsertLead({
    phone,
    name,
    email: data.email || null,
    status,
    zoom_time: data.zoom_time || null,
    objection: data.objection || null,
    call_id: call.id
  });

  try {
    if (status === 'booked') {
      const joinUrl = await createZoomMeeting(`Call with ${name} — Alpha Logics`, data.zoom_time);
      await sendEmail(
        lead.email,
        `Your call is booked${data.zoom_time ? ' — ' + data.zoom_time : ''}`,
        `Hi ${name},\n\nYou're confirmed for a quick call about your website${data.zoom_time ? ' on ' + data.zoom_time : ''}.\n\nJoin here: ${joinUrl}\n\nWe'll walk through what you're looking for and how we can help — should take about 15 minutes, no pressure either way.\n\nTalk soon,\nAlpha Logics`
      );
      await sendTelegram(`✅ Zoom booked with *${name}*${data.zoom_time ? ' for ' + data.zoom_time : ''} — confirmation emailed.`);
    } else if (status === 'wants_website_pending') {
      await sendTelegram(`🔨 *${name}* wants their site emailed.\nLead #${lead.id} — ${lead.email}\nReply: \`/send ${lead.id} https://link.com\` when it's ready.`);
    } else if (status === 'bad_contact') {
      await sendTelegram(`📞 *${name}* was interested but the contact info didn't come through clean. Lead #${lead.id} — worth a manual callback.`);
    } else if (status === 'voicemail' || status === 'no_answer') {
      if ((lead.call_attempts || 1) === 1) {
        await sendSms(phone, `Hi, this is Alphalogics — tried reaching you about your website. Reply here anytime, or we'll try again soon.`);
      }
    }
  } catch (e) {
    console.error('Post-call action failed:', e.message);
    await sendTelegram(`⚠️ Action failed for lead #${lead.id} (${name}): ${e.message}`).catch(() => {});
  }

  res.sendStatus(200);
});

// ================= TELEGRAM: reply commands =================
app.post('/webhook/telegram', async (req, res) => {
  const text = req.body?.message?.text || '';
  const [cmd, idStr, url] = text.trim().split(/\s+/);

  if (cmd === '/send' && idStr && url) {
    const leads = readLeads();
    const lead = leads.find(l => String(l.id) === idStr);
    if (!lead) {
      await sendTelegram(`No lead found with id ${idStr}.`);
      return res.sendStatus(200);
    }
    try {
      await sendEmail(
        lead.email,
        'Your website is ready',
        `Hi ${lead.name},\n\nYour website is ready — take a look here: ${url}\n\nLet us know if you'd like any changes or have any questions.\n\nTalk soon,\nAlpha Logics`
      );
      const all = readLeads();
      const idx = all.findIndex(l => l.id === lead.id);
      all[idx].status = 'website_sent';
      require('./leads-store').writeLeads(all);
      await sendTelegram(`✅ Sent to *${lead.name}* (#${lead.id}).`);
    } catch (e) {
      await sendTelegram(`⚠️ Failed to send to #${lead.id}: ${e.message}`);
    }
  } else if (cmd === '/pending') {
    const pending = readLeads().filter(l => l.status === 'wants_website_pending');
    const list = pending.length
      ? pending.map(l => `#${l.id} — ${l.name}`).join('\n')
      : 'Nothing pending.';
    await sendTelegram(`🔨 Waiting on you:\n${list}`);
  }

  res.sendStatus(200);
});

// ================= DASHBOARD API =================
app.get('/api/leads', requireKey, (req, res) => {
  const leads = [...readLeads()]
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .map(l => ({ ...l, outcome: toDashboardOutcome(l.status) }));
  res.json({ leads });
});

app.get('/api/stats', requireKey, (req, res) => {
  const leads = readLeads();
  const pulse = [...leads]
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .slice(-60)
    .map(l => toDashboardOutcome(l.status));
  res.json({ totalCalls: leads.length, pulse });
});

app.get('/leads/pending', requireKey, (req, res) => {
  res.json(readLeads().filter(l => l.status === 'wants_website_pending'));
});
app.get('/leads/needs-follow-up', requireKey, (req, res) => {
  res.json(readLeads().filter(l => l.status === 'bad_contact'));
});

// ================= RETRY QUEUE CRON =================
app.get('/cron/redial', async (req, res) => {
  if (req.query.key !== process.env.CRON_SECRET) return res.sendStatus(401);
  const due = getDueForRedial();
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

// ================= HEALTH =================
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mera lead system running on port ${PORT}`));
