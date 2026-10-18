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
