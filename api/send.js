// POST /api/send  { to, subject, body }
// Header: x-app-password
import { suppressedReason } from './_db.js';

const WHY = {
  bounced: 'This address bounced before, so it is blocked to protect your sender reputation.',
  complained: 'This person marked an earlier email as spam. Do not email them again.',
  asked_to_stop: 'This person asked not to be contacted again.',
  do_not_contact: 'You put this address on your do-not-contact list.',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const { to, subject, body, withLink } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || '') || !subject || !body)
    return res.status(400).json({ error: 'Add a valid email, subject, and message.' });

  const why = await suppressedReason(to);
  if (why) return res.status(400).json({ error: WHY[why] || 'This address is on your blocked list.' });

  // First emails carry no link (better for inbox placement). Follow-ups include the portfolio.
  const text = `${body}\n\n--\nToheeb Akanni | ATM (Akanni Toheeb Marketing)${withLink ? '\nPortfolio: https://toheebakanni.name.ng' : ''}\nNot interested? Just reply "no thanks" and I won't message you again.`;

  // Gives mailbox providers a built-in "unsubscribe" option, which helps trust and placement
  const addr = (s) => ((s || '').match(/<([^>]+)>/) || [null, s || ''])[1].trim();
  const unsub = addr(process.env.REPLY_TO) || addr(process.env.FROM_EMAIL);

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL, // e.g. Toheeb Akanni <toheeb@toheebakanni.name.ng>
      reply_to: process.env.REPLY_TO || undefined,
      to,
      subject,
      text,
      headers: unsub ? { 'List-Unsubscribe': `<mailto:${unsub}?subject=unsubscribe>` } : undefined,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: data?.message || 'Email failed to send' });
  return res.status(200).json({ ok: true });
}
