// POST /api/replied   Header: x-app-password
//  { op: 'targets' }                       -> which addresses and domains you are waiting to hear from
//  { items: [{ from, subject, text }] }    -> messages the Gmail script found; matching leads move to Replied
//                                             (or to Dropped, and are blocked, when the reply says no thanks)
//  { senders: ['a@b.com'] }                -> older script version, still works
import { waitingLeads, leadEmails, matches, setStatus, suppress, FREE } from './_db.js';

const IGNORE = /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|notifications?|bounces?)@/i;
const AUTO = /out of office|auto-?reply|automatic reply|autoreply|away from (the )?office|on vacation|undeliverable|delivery status/i;
const OPT_OUT = /\b(no,? thanks?|no thank you|not interested|unsubscribe|stop (emailing|messaging|contacting|sending)|remove me|take me off|do not (email|contact|message)|don'?t (email|contact|message)|leave me alone)\b/i;

// Keep only what the person wrote, not the quoted copy of your own email (it contains your "no thanks" line)
function written(text) {
  let t = String(text || '').split(/\r?\n(?:On .{5,120} wrote:|>|-{2,}\s*Original|From:\s|Sent from my)/)[0];
  t = t.replace(/not interested\?[^\n]*?(message you again|contact you again)\.?/gi, ' ');
  return t.slice(0, 500);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  try {
    const waiting = await waitingLeads();
    if (req.body?.op === 'targets') {
      const emails = new Set(), domains = new Set();
      for (const l of waiting) for (const e of leadEmails(l)) { emails.add(e); const d = e.split('@')[1]; if (!FREE.has(d)) domains.add(d); }
      return res.status(200).json({ emails: [...emails], domains: [...domains] });
    }
    const items = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body?.senders) ? req.body.senders.map((s) => ({ from: s })) : []);
    const replied = [], dropped = [], done = new Set();
    for (const it of items) {
      const from = String(it.from || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(from) || IGNORE.test(from)) continue;
      if (AUTO.test(`${it.subject || ''} ${String(it.text || '').slice(0, 300)}`)) continue; // robot replies are not real replies
      const dom = from.split('@')[1];
      const hits = waiting.filter((l) => !done.has(l.url) && matches(l, new Set([from]), FREE.has(dom) ? new Set() : new Set([dom])));
      const stop = OPT_OUT.test(written(it.text));
      for (const l of hits) {
        done.add(l.url);
        if (stop) {
          await setStatus(l.url, 'Dropped');
          for (const e of new Set([from, ...leadEmails(l)])) await suppress(e, 'asked_to_stop');
          dropped.push(l.name || l.url);
        } else { await setStatus(l.url, 'Replied'); replied.push(l.name || l.url); }
      }
    }
    return res.status(200).json({ ok: true, replied, dropped });
  } catch { return res.status(500).json({ error: 'Reply check failed' }); }
}
