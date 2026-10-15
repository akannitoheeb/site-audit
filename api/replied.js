// POST /api/replied  { senders: ['owner@store.com', ...] }
// Header: x-app-password (same one the rest of the app uses)
// Marks any emailed lead (status New or Contacted) as "Replied" when a sender matches its email.

const FREE = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com',
]);
const IGNORE = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|bounces?)@/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const KEY = process.env.SUPABASE_SERVICE_KEY || '';
  const base = `${(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/${process.env.LEADS_TABLE || 'leads'}`;
  if (!KEY || !process.env.SUPABASE_URL) return res.status(500).json({ error: 'Supabase is not set up yet' });
  const h = { apikey: KEY, 'content-type': 'application/json' };
  if (KEY.startsWith('eyJ')) h.authorization = `Bearer ${KEY}`;

  const senders = [...new Set(
    (Array.isArray(req.body?.senders) ? req.body.senders : [])
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && !IGNORE.test(s))
  )];
  if (!senders.length) return res.status(200).json({ ok: true, updated: [] });

  const exact = new Set(senders);
  const domains = new Set(senders.map((s) => s.split('@')[1]).filter((d) => !FREE.has(d)));

  try {
    const r = await fetch(`${base}?select=url,name,status,emailed,data&status=in.(New,Contacted)&limit=1000`, { headers: h });
    const rows = await r.json();
    if (!r.ok) return res.status(502).json({ error: rows?.message || 'Could not load leads' });

    const updated = [];
    for (const l of rows) {
      if (!l.emailed) continue; // only leads you actually emailed
      const d = l.data || {};
      const mails = [d.to, d.found?.email, ...(d.found?.emails || [])]
        .filter(Boolean)
        .map((e) => String(e).trim().toLowerCase());
      const hit = mails.some((e) => exact.has(e) || (!FREE.has(e.split('@')[1]) && domains.has(e.split('@')[1])));
      if (!hit) continue;
      const p = await fetch(`${base}?url=eq.${encodeURIComponent(l.url)}`, {
        method: 'PATCH',
        headers: { ...h, prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'Replied', follow: null, updated_at: new Date().toISOString() }),
      });
      if (p.ok) updated.push(l.name || l.url);
    }
    return res.status(200).json({ ok: true, updated });
  } catch {
    return res.status(500).json({ error: 'Reply check failed' });
  }
}
