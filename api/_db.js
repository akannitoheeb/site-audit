// Shared helpers for Supabase. Files that start with an underscore are not public endpoints.
export const FREE = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'outlook.com', 'hotmail.com', 'live.com', 'icloud.com', 'proton.me', 'protonmail.com', 'aol.com']);
const clean = (e) => String(e || '').trim().toLowerCase();
const domainOf = (e) => clean(e).split('@')[1] || '';

export function db() {
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!key || !url) return null;
  const h = { apikey: key, 'content-type': 'application/json' };
  if (key.startsWith('eyJ')) h.authorization = `Bearer ${key}`;
  return { h, rest: `${url}/rest/v1`, leads: `${url}/rest/v1/${process.env.LEADS_TABLE || 'leads'}` };
}

// ---- blocked addresses (bounced, spam complaint, or asked to stop) ----
export async function suppressedReason(email) {
  const D = db(); if (!D) return null;
  try {
    const r = await fetch(`${D.rest}/suppressed?select=reason&email=eq.${encodeURIComponent(clean(email))}&limit=1`, { headers: D.h });
    if (!r.ok) return null; // table not created yet: do not block sending
    const rows = await r.json();
    return rows[0]?.reason || null;
  } catch { return null; }
}
export async function suppress(email, reason) {
  const D = db(); if (!D || !email) return false;
  try {
    const r = await fetch(`${D.rest}/suppressed?on_conflict=email`, {
      method: 'POST', headers: { ...D.h, prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ email: clean(email), reason }),
    });
    return r.ok;
  } catch { return false; }
}
export async function listSuppressed() {
  const D = db(); if (!D) return [];
  const r = await fetch(`${D.rest}/suppressed?select=email,reason,created_at&order=created_at.desc&limit=500`, { headers: D.h });
  return r.ok ? r.json() : [];
}
export async function unsuppress(email) {
  const D = db(); if (!D) return false;
  const r = await fetch(`${D.rest}/suppressed?email=eq.${encodeURIComponent(clean(email))}`, { method: 'DELETE', headers: D.h });
  return r.ok;
}

// ---- leads you have emailed that are still waiting (status New or Contacted) ----
export const leadEmails = (l) => {
  const d = l.data || {};
  return [d.to, d.found?.email, ...(d.found?.emails || [])].filter(Boolean).map(clean);
};
export async function waitingLeads() {
  const D = db(); if (!D) return [];
  const r = await fetch(`${D.leads}?select=url,name,status,emailed,data&status=in.(New,Contacted)&emailed=not.is.null&limit=1000`, { headers: D.h });
  return r.ok ? r.json() : [];
}
// exact: Set of full addresses. domains: Set of business domains. Free mail domains never match by domain.
export const matches = (l, exact, domains) =>
  leadEmails(l).some((e) => exact.has(e) || (!FREE.has(domainOf(e)) && domains.has(domainOf(e))));

export async function setStatus(url, status) {
  const D = db(); if (!D) return false;
  const r = await fetch(`${D.leads}?url=eq.${encodeURIComponent(url)}`, {
    method: 'PATCH', headers: { ...D.h, prefer: 'return=minimal' },
    body: JSON.stringify({ status, follow: null, updated_at: new Date().toISOString() }),
  });
  return r.ok;
}

// ---- sending cap that grows as the sending domain ages ----
const ms = (x) => (x == null ? 0 : /^\d+$/.test(String(x)) ? Number(x) : Date.parse(x) || 0);
// Every email counts, even when one store gets 2 or 3 addresses. Uses the `sends` table; falls back to counting leads if it is missing.
export async function sentLast24h() {
  const D = db(); if (!D) return 0;
  try {
    const since = new Date(Date.now() - 864e5).toISOString();
    const r = await fetch(`${D.rest}/sends?select=id&created_at=gte.${encodeURIComponent(since)}`, { headers: { ...D.h, prefer: 'count=exact', range: '0-0' } });
    if (r.ok) { const n = Number((r.headers.get('content-range') || '').split('/')[1]); if (!Number.isNaN(n)) return n; }
  } catch {}
  try {
    const r = await fetch(`${D.leads}?select=emailed&emailed=not.is.null&order=emailed.desc&limit=300`, { headers: D.h });
    if (!r.ok) return 0;
    const since = Date.now() - 864e5;
    return (await r.json()).filter((l) => ms(l.emailed) >= since).length;
  } catch { return 0; }
}
export async function logSend(to) {
  const D = db(); if (!D) return false;
  try { return (await fetch(`${D.rest}/sends`, { method: 'POST', headers: { ...D.h, prefer: 'return=minimal' }, body: JSON.stringify({ to_email: String(to).toLowerCase() }) })).ok; } catch { return false; }
}
// SENDING_START = the date you began sending real emails from the new domain (YYYY-MM-DD). DAILY_MAX = the ceiling after week 6.
export function dailyCap() {
  const max = Number(process.env.DAILY_MAX) || 60;
  const start = Date.parse(process.env.SENDING_START || '');
  if (!start) return Math.min(10, max);
  const wk = Math.max(0, Math.floor((Date.now() - start) / (7 * 864e5)));
  return wk >= 6 ? max : Math.min([10, 15, 20, 30, 40, 50][wk], max);
}

// ---- replies shown under the bell ----
export async function addReply(r) {
  const D = db(); if (!D) return false;
  try {
    const x = await fetch(`${D.rest}/replies?on_conflict=ext_id`, {
      method: 'POST', headers: { ...D.h, prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ channel: r.channel || 'other', from_name: r.from_name || '', lead_url: r.lead_url || null, subject: r.subject || '', message: String(r.message || '').slice(0, 2000), ext_id: r.ext_id || null }),
    });
    return x.ok;
  } catch { return false; }
}
