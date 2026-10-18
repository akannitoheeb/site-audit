// POST /api/suppress  { op: 'list' | 'add' | 'remove', email, reason }
// Header: x-app-password. Manages the list of addresses that must never be emailed again.
import { listSuppressed, suppress, unsuppress } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });
  const { op, email, reason } = req.body || {};
  try {
    if (op === 'list') return res.status(200).json({ rows: await listSuppressed() });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '')) return res.status(400).json({ error: 'Enter a valid email.' });
    if (op === 'add') return (await suppress(email, reason || 'do_not_contact')) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: 'Could not save. Did you run the SQL for the blocked list?' });
    if (op === 'remove') return (await unsuppress(email)) ? res.status(200).json({ ok: true }) : res.status(502).json({ error: 'Could not remove' });
    return res.status(400).json({ error: 'Bad request' });
  } catch { return res.status(500).json({ error: 'Blocked list failed' }); }
}
