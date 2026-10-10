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

const TONE = `Voice: write like a seasoned consultant with decades of experience in email marketing and web design: calm, mature, precise and respectful. Never mention a number of years of experience. Never be blunt, rude, sarcastic or pushy. Always begin with a proper greeting ("Good day," or "Hello team at [Store],") and close courteously ("Warm regards, Toheeb"). Frame every observation as an opportunity and respect the store's work. No slang, no "Hey", no emojis.`;

// Country codes we know how to recognise, and what a store's web address tells us about its country
const KNOWN_CC = ['234', '233', '254', '353', '44', '61', '27', '1'];
const TLD_CC = { ng: '234', gh: '233', ke: '254', ie: '353', uk: '44', au: '61', za: '27', ca: '1', us: '1' };
const ccOf = (d) => KNOWN_CC.find((c) => d.startsWith(c)) || '';

// Turns any phone format into digits with the country code (no +). Returns null if it does not look like a real number.
function normalizePhone(raw, cc = '') {
  const t = String(raw).replace(/\(0\)/g, '').trim();
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+') || t.startsWith('00')) {
    const d = t.startsWith('+') ? digits : digits.slice(2);
    return /^[1-9]\d{7,14}$/.test(d) && (t.startsWith('+') || d.length >= 10) ? d : null; // already has a country code: keep it as it is
  }
  // US / Canada style: (415) 555-0123, 415-555-0123, 1-800-555-0123
  if (/^1?[2-9]\d{2}[2-9]\d{6}$/.test(digits) && (cc === '1' || !cc || /[()\s.-]/.test(t))) return '1' + digits.slice(-10);
  // Local format starting with 0 (Nigeria, UK and similar): the store's country decides the code
  if (/^0\d{9,10}$/.test(digits)) {
    const guess = /^0[789][01]\d{8}$/.test(digits) ? '234' : /^0(7[1-57-9]\d{8}|[123]\d{9})$/.test(digits) ? '44' : '';
    const country = (cc && cc !== '1' ? cc : '') || guess;
    if (country) return country + digits.slice(1);
  }
  return null;
}

// Finds every phone number on the page, best sources first, in any country format
function findPhones(html, host) {
  let cc = TLD_CC[host.split('.').pop().toLowerCase()] || '';
  const strong = [], weak = [];
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    try { strong.push(decodeURIComponent(m[1])); } catch { strong.push(m[1]); }
  }
  for (const m of html.matchAll(/(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=)(\d{8,15})/gi)) strong.push('+' + m[1]);
  for (const m of html.matchAll(/"telephone"\s*:\s*"([^"]+)"/gi)) strong.push(m[1]);
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
  for (const m of text.matchAll(/\+\d{1,3}[\s().-]*\d[\d\s().-]{6,16}\d/g)) strong.push(m[0]);
  for (const m of text.matchAll(/(?<!\d)00[1-9]\d{0,2}[\s().-]*\d[\d\s().-]{6,16}\d/g)) strong.push(m[0]);
  for (const m of text.matchAll(/(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g)) weak.push(m[0]);
  for (const m of text.matchAll(/\b0\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g)) weak.push(m[0]);
  if (!cc) { // no hint from the web address, so learn the country from the first number that has a code
    for (const c of strong) { if (/^\s*(\+|00)/.test(c)) { const d = normalizePhone(c); if (d) { cc = ccOf(d); break; } } }
  }
  const out = [];
  for (const c of [...strong, ...weak]) {
    const n = normalizePhone(c, cc);
    if (n && !out.some((m) => m.slice(-10) === n.slice(-10))) out.push(n); // skip repeats and the same number written two ways
  }
  return out.slice(0, 5);
}

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
  out.phones = findPhones(html, host);
  out.phone = out.phones[0] || null;
  for (const [k, re] of Object.entries(SOCIAL)) out[k] = (html.match(re) || [])[0] || null;
  return out;
}

async function postRetry(url, opts, tries = 2) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await fetch(url, opts);
    if (![429, 500, 502, 503, 504].includes(r.status)) return r;
    await new Promise((x) => setTimeout(x, 2000 * (i + 1)));
  }
  return r;
}

const friendly = (s, m) => ([429, 503].includes(s) ? 'The AI service is busy right now. Wait a minute and try again.' : m || 'AI request failed');

async function askGemini(system, user, key) {
  try {
    const model = process.env.AI_MODEL || 'gemini-3.8-flash';
    const r = await postRetry(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.4 },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: friendly(r.status, d?.error?.message) };
    return { ok: true, text: (d.candidates?.[0]?.content?.parts || []).map((x) => x.text || '').join('') };
  } catch { return { ok: false, error: 'Could not reach Gemini' }; }
}

async function askGroq(system, user, key) {
  try {
    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    const r = await postRetry('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model, temperature: 0.3, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: friendly(r.status, d?.error?.message) };
    return { ok: true, text: (d.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '') };
  } catch { return { ok: false, error: 'Could not reach Groq' }; }
}

async function askAI(system, user) {
  const order = (process.env.AI_PROVIDER || 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const keys = { gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY };
  let error = '';
  for (const p of order) {
    if (!keys[p]) continue;
    const out = await (p === 'gemini' ? askGemini : askGroq)(system, user, keys[p]);
    if (out.ok) {
      try {
        return { ok: true, provider: p, json: JSON.parse(out.text.slice(out.text.indexOf('{'), out.text.lastIndexOf('}') + 1)) };
      } catch { error = error || 'The AI reply could not be read. Try again.'; }
    } else error = error || out.error;
  }
  return { ok: false, error: error || 'No AI key is set.' };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });
    

  if (req.body?.mode === 'followup') {
    const b = req.body;
    const n = b.count || 0;
    const sys = `You write a short follow-up for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM).
${TONE}
He already sent the first message below to this store and got no reply. Write follow-up number ${n + 1}.
Rules:
- Do not repeat the first pitch. Refer to it lightly (for example "my note last week").
- Add ONE new bit of value: a quick tip or micro-idea tied to the same observation. Use only facts from the observations given; never add new claims about the store.
- Make exactly ONE easy ask, and give an easy out ("no worries if it's not a priority").
- Never guilt-trip. Never use "just checking in" or "bumping this".
- Email: under 70 words. DM: under 45 words. WhatsApp: under 60 words. Simple English, no emojis.
- ${n >= 1 ? 'This is the last follow-up: close politely and leave the door open.' : 'This is the first follow-up.'}
${b.voice ? 'Writing style: ' + b.voice : ''}
Return ONLY JSON: {"email":{"subject":string,"body":string},"dm":string,"whatsapp":string}`;
    const usr = `Store: ${b.name} (${b.url})
My services: ${b.services || 'Email marketing strategy and WordPress web design'}
Observations: ${JSON.stringify(b.observations || [])}
First email I sent: ${b.firstEmail?.body || ''}
First DM I sent: ${b.firstDm || ''}
First WhatsApp I sent: ${b.firstWa || ''}`;
    const out = await askAI(sys, usr);
    if (!out.ok) return res.status(502).json({ error: out.error });
    return res.status(200).json({ provider: out.provider, ...out.json });
  }

  const { url, email, social, services, voice } = req.body || {};
  let target;
  try {
    target = new URL(url);
    if (!/^https?:$/.test(target.protocol) || BLOCKED.test(target.hostname)) throw 0;
  } catch {
    return res.status(400).json({ error: 'Enter a valid store URL starting with https://' });
  }

  let html, status;
  try {
    const r = await fetch(target, { headers: UA, signal: AbortSignal.timeout(12000) });
    status = r.status;
    html = await r.text();
  } catch {
    return res.status(502).json({ error: 'Could not load that store. Check the link or try again.' });
  }
  const challenged = html.length < 30000 && /just a moment\.\.\.|enable javascript and cookies to continue|checking your browser|cf-browser-verification|attention required/i.test(html);
  if (challenged || status === 403 || status === 429)
    return res.status(422).json({ error: 'This store blocks automated readers (it returned a bot-check page), so it cannot be audited here. Review it by hand or try another store.' });

  // Look for contact details on the store's own public pages (homepage plus contact pages)
  const cm = html.match(/href=["']([^"']*contact[^"']*)["']/i);
  const paths = cm ? [cm[1]] : ['/pages/contact', '/contact', '/pages/contact-us', '/contact-us'];
  const pages = await Promise.allSettled(paths.map(async (p) => {
    const u = new URL(p, target);
    if (u.hostname !== target.hostname) return '';
    const rr = await fetch(u, { headers: UA, signal: AbortSignal.timeout(6000) });
    return rr.ok ? await rr.text() : '';
  }));
  const extra = pages.map((x) => (x.status === 'fulfilled' ? x.value : '')).join(' ');
  const found = findContacts(html + ' ' + extra, target.hostname);

  const platform = detect(html);
  const sig = signals(html);
  const text = toText(html);
  
    let productText = '';
  const pm = html.match(/href=["']([^"']*\/products?\/[^"'#?]+)["']/i);
  if (pm) {
    try {
      const pu = new URL(pm[1], target);
      if (pu.hostname === target.hostname) {
        const pr = await fetch(pu, { headers: UA, signal: AbortSignal.timeout(8000) });
        if (pr.ok) productText = toText(await pr.text()).slice(0, 2500);
      }
    } catch {}
  }

  const system = `You write outreach for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM, Akanni Toheeb Marketing).
You audit an online store from the evidence given and draft personal outreach.

${TONE}

Evidence rules (most important):
- You only see the raw page code and text. Content loaded by JavaScript is invisible to you: reviews, popups, chat widgets, product grids, email forms. NEVER claim any of these are missing. If something may simply be hidden from you, skip it or phrase it as a question.
- "emailToolDetected: false" only means no known email tool appeared in the page code. Treat it as a soft hint, never as proof the store has no email marketing.
- Every observation must rest on visible text or a clear signal. In the evidence field, quote or describe it in plain English. Never use field names or code terms such as signal names, JSON keys, or "false".
- If evidence is thin, give fewer observations (minimum 2) rather than inventing.

Relevance rules:
- Only raise things Toheeb could actually help with given his services: email capture and flows, copywriting, product page clarity, store design, trust and conversion. Ignore the store's business model, pricing, or how its own product works.

Drafting rules:
- Email: under 130 words, warm and professional, no hype. Greet properly, mention one or two solid observations, offer one clear next step, close with "Warm regards, Toheeb". Do not add an unsubscribe line (the app adds it).
- DM: 45 to 70 words. Greet properly, name ONE specific thing you saw on this store, then ask one easy question or offer one quick helpful idea.
- WhatsApp: 60 to 90 words. The store does not know this number, so greet properly, then introduce yourself in one line ("This is Toheeb from ATM. I help online stores with email marketing and website design."). Name ONE specific thing you saw, make ONE ask, then add a courteous line saying they can simply tell you if they would rather not be messaged. Close with "Warm regards, Toheeb". No links.
- All three must point to something concrete from this store. Never use vague filler such as "I help with that stuff", "saw your site", or "let me know".
- If something might just be hidden from you (popups, reviews, email forms), ask a question about it instead of saying it is missing.
- Simple English, no emojis, no hype words, no slang.
- Style example for a DM (match this quality; it is from a different store, so never reuse its details): "Good day, I admired the bespoke game sets on The Craft House. I noticed the homepage still shows an expired-offer banner with the timer at zero. Are you planning a new campaign soon? I would be glad to help tidy that up."

Pitch logic (follow this for every draft):
1. Pick the single best observation: something concrete the store could fix or gain that Toheeb's services solve.
2. After the greeting, open with one genuine compliment on something specific (a product, collection or line of copy), then the observation. Never open with a generic compliment.
3. Connect the observation to a benefit in plain words (more first orders, fewer abandoned carts, less confusion), not a feature.
4. Make exactly ONE ask: either a question OR an offer of one small free thing (for example "I can sketch a 3-email welcome flow"). Never both.
5. Match the offer to the observation: no sign of a welcome email means sketch a welcome flow; sold-out items mean restock or waitlist emails; an expired or broken page element means a quick fix; weak product copy means rewrite one product page.
6. A product page excerpt may be included. Comment on product descriptions only if that excerpt is there.
7. Before answering, check the draft: is every fact visible in the evidence, is there one ask, and would a stranger understand the point in 5 seconds? Fix it if not.

Return ONLY JSON in exactly this shape: {"storeName":string,"observations":[{"issue":string,"evidence":string}],"email":{"subject":string,"body":string},"dm":string,"whatsapp":string}`;

  const user = `Store URL: ${target.href}
Platform detected: ${platform}
Hints: ${JSON.stringify(sig)}
My services and offers: ${services || 'Email marketing strategy and WordPress web design'}
My writing style: ${voice || 'warm, professional, respectful'}
Homepage text (trimmed):
${text}
One product page (trimmed):
${productText || 'not available'}`;

  const order = (process.env.AI_PROVIDER || 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const keys = { gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY };
  let firstError = '';
  for (const p of order) {
    if (!keys[p]) continue;
    const out = await (p === 'gemini' ? askGemini : askGroq)(system, user, keys[p]);
    if (out.ok) {
      try {
        const json = JSON.parse(out.text.slice(out.text.indexOf('{'), out.text.lastIndexOf('}') + 1));
        return res.status(200).json({ platform, signals: sig, found, provider: p, ...json });
      } catch { firstError = firstError || 'The AI reply could not be read. Try again.'; }
    } else firstError = firstError || out.error;
  }
  return res.status(502).json({ error: firstError || 'No AI key is set. Add GEMINI_API_KEY or GROQ_API_KEY in Vercel.' });
}
