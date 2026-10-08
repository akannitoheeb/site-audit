// POST /api/leads  { op: 'list' | 'save' | 'delete', lead, url }
// Header: x-app-password. Stores leads in Supabase using a secret key kept in Vercel.

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const KEY = process.env.SUPABASE_SERVICE_KEY || '';
  const base = `${(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/rest/v1/${process.env.LEADS_TABLE || 'leads'}`;
  if (!KEY || !process.env.SUPABASE_URL) return res.status(500).json({ error: 'Supabase is not set up yet' });
  const h = { apikey: KEY, 'content-type': 'application/json' };
  if (KEY.startsWith('eyJ')) h.authorization = `Bearer ${KEY}`;

  const { op, lead, url } = req.body || {};
  try {
    let r;
    if (op === 'list') {
      r = await fetch(`${base}?select=url,name,status,follow,emailed,data&order=updated_at.desc&limit=1000`, { headers: h });
      const rows = await r.json();
      if (!r.ok) return res.status(502).json({ error: rows?.message || 'Could not load leads' });
      return res.status(200).json({ leads: rows });
    }
    if (op === 'save' && lead?.url) {
      r = await fetch(base, {
        method: 'POST',
        headers: { ...h, prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          url: lead.url, name: lead.name || lead.url, status: lead.status || 'New',
          follow: lead.follow || null, emailed: lead.emailed || null, data: lead.data || null,
          updated_at: new Date().toISOString(),
        }),
      });
    } else if (op === 'delete' && url) {
      r = await fetch(`${base}?url=eq.${encodeURIComponent(url)}`, { method: 'DELETE', headers: h });
    } else {
      return res.status(400).json({ error: 'Bad request' });
    }
    if (!r.ok) return res.status(502).json({ error: (await r.json().catch(() => ({})))?.message || 'Could not save' });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(500).json({ error: 'Leads service failed' });
  }
}
