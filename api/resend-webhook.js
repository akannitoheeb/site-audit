// Resend calls this when an email bounces or is marked as spam.
// Set it up in Resend > Webhooks:  https://YOUR-SITE.vercel.app/api/resend-webhook?token=YOUR_WEBHOOK_TOKEN
// and add WEBHOOK_TOKEN (any long random text) in Vercel. Events to tick: email.bounced, email.complained.
import { suppress, waitingLeads, matches, setStatus } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.WEBHOOK_TOKEN || req.query?.token !== process.env.WEBHOOK_TOKEN)
    return res.status(401).json({ error: 'Bad token' });

  const ev = req.body || {};
  if (!/^email\.(bounced|complained)$/.test(ev.type || '')) return res.status(200).json({ ok: true, ignored: ev.type || true });
  const bounced = ev.type === 'email.bounced';
  // A temporary problem (full mailbox, server down) should not block the address for good
  if (bounced && String(ev.data?.bounce?.type || '').toLowerCase() === 'transient') return res.status(200).json({ ok: true, ignored: 'temporary bounce' });

  const to = Array.isArray(ev.data?.to) ? ev.data.to : [ev.data?.to].filter(Boolean);
  const emails = to.map((x) => (String(x).match(/<([^>]+)>/) || [null, x])[1].trim().toLowerCase());
  try {
    const waiting = await waitingLeads();
    for (const email of emails) {
      await suppress(email, bounced ? 'bounced' : 'complained');
      for (const l of waiting.filter((x) => matches(x, new Set([email]), new Set()))) await setStatus(l.url, bounced ? 'Bounced' : 'Dropped');
    }
    return res.status(200).json({ ok: true, blocked: emails });
  } catch { return res.status(500).json({ error: 'Webhook failed' }); }
}
