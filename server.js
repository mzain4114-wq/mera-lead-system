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
// Everything with customer PII (names, emails, phone numbers) requires this
// key. Set DASHBOARD_KEY in your env, then use the dashboard at:
//   https://<your-app>/dashboard?key=<DASHBOARD_KEY>
// The page reads the key from the URL once and reuses it for every API call.
function requireKey(req, res, next) {
  const key = req.query.key || req.headers['x-dashboard-key'];
  if (!process.env.DASHBOARD_KEY) {
    // Fail closed: if you forgot to set it, don't silently expose leads.
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

// ---------- outcome mapping ----------
// Turns Vapi's structured data (see vapi-analysis-plan.json) into one status label.
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

  const msg = req.body.message || req.body; // Vapi wraps payload in "message"
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
      await sendEmail(
        lead.email,
        'Your meeting is confirmed',
        `Hi ${name},\n\nConfirming our Zoom meeting${data.zoom_time ? ' for ' + data.zoom_time : ''}.\nJoin here: ${process.env.ZOOM_MEETING_LINK}\n\nSee you then!`
      );
      await sendTelegram(`✅ Zoom booked with *${name}*${data.zoom_time ? ' for ' + data.zoom_time : ''} — confirmation emailed.`);
    } else if (status === 'wants_website_pending') {
      await sendTelegram(`🔨 *${name}* wants their site emailed.\nLead #${lead.id} — ${lead.email}\nReply: \`/send ${lead.id} https://link.com\` when it's ready.`);
    } else if (status === 'bad_contact') {
      await sendTelegram(`📞 *${name}* was interested but the contact info didn't come through clean. Lead #${lead.id} — worth a manual callback.`);
    } else if (status === 'voicemail' || status === 'no_answer') {
      // First miss gets a text nudge; retry queue handles the redial.
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
      await sendEmail(lead.email, 'Here\'s the website we built for you', `Hi ${lead.name},\n\nHere's the link: ${url}\n\nLet us know what you think!`);
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

// legacy simple lists (kept for quick manual checks)
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
