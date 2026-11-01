// POST /api/send  { to, subject, body, withLink }   or   { op: 'cap' } to read today's limit
// Header: x-app-password
import { suppressedReason, sentLast24h, dailyCap } from './_db.js';

const WHY = {
  bounced: 'This address bounced before, so it is blocked to protect your sender reputation.',
  complained: 'This person marked an earlier email as spam. Do not email them again.',
  asked_to_stop: 'This person asked not to be contacted again.',
  do_not_contact: 'You put this address on your do-not-contact list.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.APP_PASSWORD || req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const cap = dailyCap(), used = await sentLast24h();
  if (req.body?.op === 'cap') return res.status(200).json({ cap, used });

  const { to, subject, body, withLink } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || '') || !subject || !body)
    return res.status(400).json({ error: 'Add a valid email, subject, and message.' });
  if (used >= cap)
    return res.status(429).json({ error: `Limit reached: ${used} of ${cap} emails in the last 24 hours. The limit rises each week while your new sending domain warms up.` });

  const why = await suppressedReason(to);
  if (why) return res.status(400).json({ error: WHY[why] || 'This address is on your blocked list.' });

  // First emails carry no link (better for inbox placement). Follow-ups include the portfolio.
  // MAIL_ADDRESS (optional env) adds your postal address, which US law expects in marketing email.
  const text = `${body}\n\n--\nToheeb Akanni | ATM (Akanni Toheeb Marketing)${withLink ? '\nPortfolio: https://toheebakanni.name.ng' : ''}${process.env.MAIL_ADDRESS ? '\n' + process.env.MAIL_ADDRESS : ''}\nNot interested? Just reply "no thanks" and I won't message you again.`;

  const addr = (s) => ((s || '').match(/<([^>]+)>/) || [null, s || ''])[1].trim();
  const unsub = addr(process.env.REPLY_TO) || addr(process.env.FROM_EMAIL);

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL, // e.g. Toheeb Akanni <toheeb@send.toheebakanni.name.ng>
      reply_to: process.env.REPLY_TO || undefined,
      to, subject, text,
      headers: unsub ? { 'List-Unsubscribe': `<mailto:${unsub}?subject=unsubscribe>` } : undefined,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: data?.message || 'Email failed to send' });
  return res.status(200).json({ ok: true });
}
