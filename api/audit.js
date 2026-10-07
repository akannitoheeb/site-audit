// POST /api/audit  { url, email, social, services }
// Header: x-app-password

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/;
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; ATM-Audit/1.0)' };
const JUNK = /\.(png|jpe?g|gif|webp|svg)$|sentry|wixpress|example\.|domain\.com|your@|@2x/i;
const SOCIAL = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel|explore|accounts|sharer)[A-Za-z0-9._]+\/?/i,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|tr\b|plugins|dialog)[A-Za-z0-9.\-_\/]+/i,
  linkedin: /https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9\-_%]+/i,
  tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._]+/i,
  x: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home)[A-Za-z0-9_]+/i,
  whatsapp: /https?:\/\/(?:wa\.me\/\d+|api\.whatsapp\.com\/send\?phone=\d+)/i,
};

function detect(html) {
  const h = html.toLowerCase();
  if (h.includes('cdn.shopify.com') || h.includes('shopify.theme')) return 'Shopify';
  if (h.includes('woocommerce')) return 'WordPress + WooCommerce';
  if (h.includes('wp-content')) return 'WordPress';
  return 'Unknown';
}

function signals(html) {
  const h = html.toLowerCase();
  const has = (...k) => k.some((x) => h.includes(x));
  return {
    title: (html.match(/<title[^>]*>([^<]*)/i) || [])[1]?.trim() || null,
    metaDescription: /<meta[^>]+name=["']description["']/i.test(html),
    mobileViewportTag: /name=["']viewport["']/i.test(html),
    emailToolDetected: has('klaviyo', 'mailchimp', 'omnisend', 'mailerlite', 'sendinblue', 'brevo', 'convertkit'),
    newsletterOrSubscribeText: has('newsletter', 'subscribe', 'join our list'),
    pageSizeKB: Math.round(html.length / 1024),
  };
}

function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

function findContacts(html, host) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    try { found.add(decodeURIComponent(m[1]).toLowerCase()); } catch {}
  }
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0].toLowerCase());
  const list = [...found].filter((e) => !JUNK.test(e));
  const base = host.replace(/^www\./, '');
  const out = { email: list.find((e) => e.split('@')[1] === base) || list[0] || null };
  for (const [k, re] of Object.entries(SOCIAL)) out[k] = (html.match(re) || [])[0] || null;
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });

  const { url, email, social, services } = req.body || {};
  let target;
  try {
    target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || BLOCKED.test(target.hostname)) throw 0;
  } catch {
    return res.status(400).json({ error: 'Enter a valid store URL starting with https://' });
  }

  let html;
  try {
    const r = await fetch(target, { headers: UA, signal: AbortSignal.timeout(12000) });
    html = await r.text();
  } catch {
    return res.status(502).json({ error: 'Could not load that store. Check the link or try again.' });
  }

  // Look for contact details on the homepage and one contact page (the store's own public pages)
  let extra = '';
  const cm = html.match(/href=["']([^"']*contact[^"']*)["']/i);
  if (cm) {
    try {
      const u = new URL(cm[1], target);
      if (u.hostname === target.hostname) {
        extra = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) })).text();
      }
    } catch {}
  }
  const found = findContacts(html + ' ' + extra, target.hostname);

  const platform = detect(html);
  const sig = signals(html);
  const text = toText(html);

  const system = `You write outreach for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM, Akanni Toheeb Marketing).
You audit an online store from the evidence given and draft personal outreach.

Evidence rules (most important):
- You only see the raw page code and text. Content loaded by JavaScript is invisible to you: reviews, popups, chat widgets, product grids, email forms. NEVER claim any of these are missing. If something may simply be hidden from you, skip it or phrase it as a question.
- "emailToolDetected: false" only means no known email tool appeared in the page code. Treat it as a soft hint, never as proof the store has no email marketing.
- Every observation must rest on visible text or a clear signal. In the evidence field, quote or describe it in plain English. Never use field names or code terms such as signal names, JSON keys, or "false".
- If evidence is thin, give fewer observations (minimum 2) rather than inventing.

Relevance rules:
- Only raise things Toheeb could actually help with given his services: email capture and flows, copywriting, product page clarity, store design, trust and conversion. Ignore the store's business model, pricing, or how its own product works.

Drafting rules:
- Email: under 130 words, plain and friendly, no hype, mention one or two solid observations, offer one clear next step, sign off as Toheeb. Do not add an unsubscribe line (the app adds it).
- DM: under 60 words, casual, one observation, one question.
- Simple English.

Return ONLY JSON: {"storeName":string,"observations":[{"issue":string,"evidence":string}],"email":{"subject":string,"body":string},"dm":string}`;

  const user = `Store URL: ${target.href}
Platform detected: ${platform}
Hints: ${JSON.stringify(sig)}
My services and offers: ${services || 'Email marketing strategy and WordPress web design'}
Homepage text (trimmed):
${text}`;

  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  try {
    let raw = '';
    if (provider === 'gemini') {
      const model = process.env.AI_MODEL || 'gemini-3.8-flash';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
        }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(502).json({ error: d?.error?.message || 'AI request failed' });
      raw = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    } else {
      const model = process.env.AI_MODEL || 'llama-3.3-70b-versatile';
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model,
          temperature: 0.4,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(502).json({ error: d?.error?.message || 'AI request failed' });
      raw = d.choices?.[0]?.message?.content || '';
    }
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return res.status(200).json({ platform, signals: sig, found, ...json });
  } catch {
    return res.status(500).json({ error: 'The AI reply could not be read. Try again.' });
  }
}
