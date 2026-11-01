// Meta calls this when someone messages your Instagram professional account.
// Needs in Vercel: IG_VERIFY_TOKEN (any long text you choose), META_APP_SECRET, and optionally IG_ACCESS_TOKEN (lets it look up the @username).
import crypto from 'node:crypto';
import { db, addReply, setStatus } from './_db.js';
export const config = { api: { bodyParser: false } };

const rawBody = (req) => new Promise((ok, no) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', no); });

export default async function handler(req, res) {
  if (req.method === 'GET') { // Meta's one-time check when you save the webhook
    const q = req.query || {};
    return q['hub.mode'] === 'subscribe' && process.env.IG_VERIFY_TOKEN && q['hub.verify_token'] === process.env.IG_VERIFY_TOKEN
      ? res.status(200).send(q['hub.challenge']) : res.status(403).send('Forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await rawBody(req);
  const secret = process.env.META_APP_SECRET;
  const sig = String(req.headers['x-hub-signature-256'] || '');
  const want = secret ? 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex') : '';
  if (!secret || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return res.status(401).end();
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  try {
    const D = db();
    const leads = D ? await (await fetch(`${D.leads}?select=url,name,status,data&limit=1000`, { headers: D.h })).json().catch(() => []) : [];
    for (const e of body.entry || []) for (const m of e.messaging || []) {
      const text = m.message && m.message.text;
      if (!text || m.message.is_echo || m.sender?.id === e.id) continue; // skip your own messages
      let who = 'Instagram user', handle = '';
      if (process.env.IG_ACCESS_TOKEN) {
        try { const p = await (await fetch(`https://graph.instagram.com/${m.sender.id}?fields=username&access_token=${process.env.IG_ACCESS_TOKEN}`)).json(); if (p.username) { handle = p.username.toLowerCase(); who = '@' + p.username; } } catch {}
      }
      const lead = handle && Array.isArray(leads) ? leads.find((l) => String((l.data && (l.data.profile || (l.data.found && l.data.found.instagram))) || '').toLowerCase().includes('instagram.com/' + handle)) : null;
      await addReply({ channel: 'instagram', from_name: lead ? `${lead.name} (${who})` : who, lead_url: lead ? lead.url : null, message: text, ext_id: m.message.mid });
      if (lead && ['New', 'Contacted'].includes(lead.status)) await setStatus(lead.url, 'Replied');
    }
  } catch {}
  return res.status(200).end('ok');
}
