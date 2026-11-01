// POST /api/inbox  { op: 'list' | 'read' | 'add', ids, reply }   Header: x-app-password
import { db, addReply, setStatus } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.APP_PASSWORD || req.headers['x-app-password'] !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  const D = db(); if (!D) return res.status(500).json({ error: 'Supabase is not set up yet' });
  const { op, ids, reply } = req.body || {};
  try {
    if (op === 'list') {
      const r = await fetch(`${D.rest}/replies?select=*&order=created_at.desc&limit=50`, { headers: D.h });
      if (!r.ok) return res.status(502).json({ error: 'Could not load replies. Run the replies SQL in Supabase first.' });
      const rows = await r.json();
      return res.status(200).json({ rows, unread: rows.filter((x) => !x.seen).length });
    }
    if (op === 'read') {
      const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Boolean);
      const f = list.length ? `id=in.(${list.join(',')})` : 'seen=eq.false';
      await fetch(`${D.rest}/replies?${f}`, { method: 'PATCH', headers: { ...D.h, prefer: 'return=minimal' }, body: JSON.stringify({ seen: true }) });
      return res.status(200).json({ ok: true });
    }
    if (op === 'add' && reply?.message) {
      await addReply(reply);
      if (reply.lead_url) await setStatus(reply.lead_url, 'Replied');
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Bad request' });
  } catch { return res.status(500).json({ error: 'Inbox failed' }); }
}
