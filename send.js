// POST /api/send  { to, subject, body }
// Header: x-app-password

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const { to, subject, body } = req.body || {};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to || '') || !subject || !body)
    return res.status(400).json({ error: 'Add a valid email, subject, and message.' });

  const text = `${body}\n\n--\nToheeb Akanni | ATM (Akanni Toheeb Marketing)\ntoheebakanni.name.ng\nNot interested? Just reply "no thanks" and I won't message you again.`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL, // e.g. Toheeb Akanni <toheeb@toheebakanni.name.ng>
      reply_to: process.env.REPLY_TO || undefined,
      to,
      subject,
      text,
    }),
  });
  const data = await r.json();
  if (!r.ok) return res.status(502).json({ error: data?.message || 'Email failed to send' });
  return res.status(200).json({ ok: true });
}
