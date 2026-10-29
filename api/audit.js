// POST /api/audit  { url, email, social, services }
// Header: x-app-password

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[|.*\.(local|internal|localhost)$)/i;
const UA = { 'user-agent': 'Mozilla/5.0 (compatible; ATM-Audit/1.0)' };
const JUNK = /\.(png|jpe?g|gif|webp|svg)$|sentry|wixpress|example\.|domain\.com|your@|@2x/i;
const SOCIAL = {
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reels?\/|explore|accounts|sharer|share|stories|direct|tv\/|about|legal|developer)[A-Za-z0-9._]{2,30}\/?/i,
  facebook: /https?:\/\/(?:www\.)?facebook\.com\/(?!sharer|share|tr\b|plugins|dialog)[A-Za-z0-9.\-_\/]+/i,
  linkedin: /https?:\/\/(?:[a-z]+\.)?linkedin\.com\/(?:company|in)\/[A-Za-z0-9\-_%]+/i,
  tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[A-Za-z0-9._]+/i,
  x: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home)[A-Za-z0-9_]+/i,
  whatsapp: /https?:\/\/(?:wa\.me\/\d+|api\.whatsapp\.com\/send\?phone=\d+)/i,
};

// Words and habits that busy store owners and mailbox filters read as mass mail. The AI is told never to use them.
const AVOID = 'free, guarantee, guaranteed, risk-free, no obligation, act now, limited time, urgent, click here, buy now, exclusive, amazing, incredible, game-changer, revolutionary, boost, skyrocket, supercharge, dominate, unlock, leverage, synergy, elevate, streamline, enhance, optimize, maximize, transform, refine, cutting-edge, state-of-the-art, best-in-class, world-class, nurture, funnel, engagement, customer journey, brand voice, increase your sales';

const TONE = `Voice: write like one thoughtful professional emailing a shop owner they respect: polite, plain and human. Greet with "Hi [first name]," when a name is known, otherwise "Hello," or "Hello [Store] team,". Short sentences, everyday words, no marketing jargon. Never mention a number of years of experience. Never be blunt, rude, sarcastic or pushy. Close with "Kind regards," then "Toheeb". No slang, no emojis. Never use these words or phrases, because they read as mass mail and trigger spam filters: ${AVOID}. In emails, also no exclamation marks, no ALL CAPS words, no links, and no $ or % signs.`;

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

// Numbers that are clearly not real phone lines (1234567890, 0000000000, 5555555555 ...)
function junkPhone(d) {
  const t = d.slice(-10);
  return /^(\d)\1+$/.test(t) || '01234567890123456789'.includes(t) || '98765432109876543210'.includes(t);
}

// Picks the Instagram / Facebook handle that most looks like the store's own, not a theme author's or an app's
const BAD_HANDLE = /^(p|reels?|explore|accounts|sharer|share|stories|direct|tv|about|legal|developer|shopify|instagram|facebook|meta|login|policies|tr|plugins|dialog|dialog|intent|home|profile\.php|sharer\.php|share\.php)$/i;
function pickSocial(html, host, kind) {
  const re = kind === 'instagram' ? /instagram\.com\/([A-Za-z0-9._]{2,30})/gi : /facebook\.com\/([A-Za-z0-9.\-_]{3,50})/gi;
  const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = flat(host.replace(/^www\./, '').split('.')[0]);
  const seen = [];
  for (const m of html.matchAll(re)) {
    const h = m[1].replace(/\.$/, '');
    if (BAD_HANDLE.test(h) || /\.(php|html?|png|jpe?g|gif|svg|js|css)$/i.test(h)) continue;
    if (!seen.includes(h)) seen.push(h);
  }
  if (!seen.length) return null;
  const hit = seen.find((h) => label.length > 2 && (flat(h).includes(label) || label.includes(flat(h))));
  const best = hit || seen[0];
  return { url: `https://${kind === 'instagram' ? 'www.instagram.com' : 'www.facebook.com'}/${best}`, sure: Boolean(hit) };
}

// Same-site contact page links only. A "mailto:contact@..." link must never count as a contact page.
function contactPaths(html, target) {
  const out = [];
  for (const m of html.matchAll(/href=["']([^"'#\s]*contact[^"'#\s]*)["']/gi)) {
    if (/^(mailto|tel|javascript|sms|whatsapp):/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], target);
      if (u.hostname.replace(/^www\./, '') === target.hostname.replace(/^www\./, '') && !out.includes(u.pathname)) out.push(u.pathname);
    } catch {}
    if (out.length >= 2) break;
  }
  for (const p of ['/pages/contact', '/contact', '/pages/contact-us', '/contact-us']) if (!out.includes(p)) out.push(p);
  return out.slice(0, 4);
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
    if (n && !junkPhone(n) && !out.some((m) => m.slice(-10) === n.slice(-10))) out.push(n); // skip repeats and the same number written two ways
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
    emailSignupFormDetected: /<input[^>]+type=["']email["']/i.test(html) || has('contact[email]', 'klaviyo-form', 'needsclick', 'mc-embedded-subscribe'),
    pageSizeKB: Math.round(html.length / 1024),
  };
}

function toText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(template|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(\w+)\b[^>]*(?:\shidden(?=[\s>=])|aria-hidden=["']true["']|display:\s*none)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

// Which address is most likely to reach a real person? Help-desk inboxes (support@, orders@) rarely pass a pitch on.
const FREEMAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|ymail|icloud|me|proton|protonmail|aol|gmx|zoho)\./i;
const NEVER = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|abuse|privacy|legal|dpo|gdpr|security|unsubscribe|bounce|webmaster)$/i;
const HELPDESK = /^(support|help|care|customer-?care|customer-?service|service|orders?|returns?|shipping|billing|accounts?|refunds?|tickets?|helpdesk)$/i;
const FRIENDLY = /^(hello|hi|hey|contact|team|studio|shop|store|info|mail|enquiries|enquiry|sales|office)$/i;

function rankEmails(list, base) {
  const scored = [];
  list.forEach((e, i) => {
    const [local0, dom] = e.split('@');
    const local = local0.replace(/\+.*$/, '');
    const same = dom.replace(/^www\./, '') === base;
    if (!same && !FREEMAIL.test(dom)) return;   // other companies' addresses (platforms, agencies) are not the store
    if (NEVER.test(local)) return;
    const tier = HELPDESK.test(local) ? 2 : FRIENDLY.test(local) ? 1 : 0; // 0 = looks like a person or the owner
    scored.push({ e, score: tier * 2 + (same ? 0 : 1), i });
  });
  return scored.sort((a, b) => a.score - b.score || a.i - b.i).map((x) => x.e);
}

function findContacts(html, host) {
  const found = new Set();
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    try { found.add(decodeURIComponent(m[1]).toLowerCase()); } catch {}
  }
  for (const m of html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) found.add(m[0].toLowerCase());
  const list = [...found].filter((e) => !JUNK.test(e));
  const base = host.replace(/^www\./, '');
  const emails = rankEmails(list, base).slice(0, 5);
  const out = { email: emails[0] || null, emails };
  out.phones = findPhones(html, host);
  out.phone = out.phones[0] || null;
  for (const [k, re] of Object.entries(SOCIAL)) out[k] = (html.match(re) || [])[0] || null;
  const ig = pickSocial(html, host, 'instagram'), fb = pickSocial(html, host, 'facebook');
  if (ig) { out.instagram = ig.url; out.instagramUnsure = !ig.sure; } // unsure = handle does not look like the store name
  if (fb) { out.facebook = fb.url; out.facebookUnsure = !fb.sure; }
  // Only a wa.me / api.whatsapp.com link PROVES a number is on WhatsApp. Other phone numbers may be landlines.
  const wa = html.match(/(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=)(\d{8,15})/i);
  out.waNumber = wa ? wa[1] : null;
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

const friendly = (s, m) => {
  const t = String(m || '');
  if ([429, 503].includes(s)) return 'The AI service is busy or today\'s free limit is used up. Wait a minute and try again, or try later.';
  if (s === 401 || s === 403 || /api key|permission denied|unauthori[sz]ed/i.test(t)) return 'The AI key was rejected. Check GEMINI_API_KEY or GROQ_API_KEY in Vercel.';
  if (s === 404 || /decommission|no longer supported|does not exist|not found/i.test(t)) return 'That AI model is not available any more. Update AI_MODEL (Gemini) or GROQ_MODEL (Groq) in Vercel.';
  return t || 'AI request failed';
};

// Keeps only the points whose quote really appears in the page text we gave the AI.
const normQ = (x) => String(x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function verifyObs(list, corpus) {
  const hay = ' ' + normQ(corpus) + ' ';
  const kept = []; let dropped = 0;
  for (const o of Array.isArray(list) ? list : []) {
    if (!o || !o.issue) continue;
    const q = normQ(o.quote);
    if (!q) { kept.push({ issue: o.issue, evidence: o.evidence || '', check: 'unchecked' }); continue; }
    if (hay.includes(' ' + q + ' ')) kept.push({ issue: o.issue, evidence: o.evidence || '', quote: o.quote, check: 'quote' });
    else dropped++;
  }
  return { kept, dropped };
}

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

// Shopify publishes real stock data for every product at <product link>.js.
// Page text cannot be trusted for this: themes keep hidden "Sold out" labels in the page even when an item is in stock.
async function checkProduct(pu) {
  const none = { stock: 'not checked', facts: null };
  try {
    const r = await fetch(new URL(pu.pathname.replace(/\/$/, '') + '.js', pu.origin), { headers: UA, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return none;
    const p = await r.json();
    const vs = Array.isArray(p.variants) ? p.variants : [];
    if (!vs.length && typeof p.available !== 'boolean') return none;
    const n = vs.filter((v) => v.available).length;
    const stock = !p.available ? 'SOLD OUT (no variant is available)' : n === vs.length ? 'IN STOCK (all variants available)' : `IN STOCK (${n} of ${vs.length} variants available)`;
    const html = String(p.description || '');
    const words = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const bullets = (html.match(/<li\b/gi) || []).length, paras = (html.match(/<p\b/gi) || []).length;
    const breaks = (html.match(/<br\b/gi) || []).length, heads = (html.match(/<h[1-6]\b/gi) || []).length;
    const facts = {
      productTitle: p.title || '', descriptionWords: words, bulletItems: bullets, paragraphs: paras, lineBreaks: breaks, headings: heads,
      oneBlock: words >= 70 && bullets === 0 && paras <= 1 && breaks === 0 && heads === 0,
      images: (p.images || []).length, variants: vs.length, onSale: Number(p.compare_at_price) > Number(p.price),
    };
    return { stock, facts };
  } catch { return none; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD)
    return res.status(401).json({ error: 'Wrong password' });
    

  if (req.body?.mode === 'reply') {
    const b = req.body;
    const sys = `You write a reply for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM).
${TONE}
A store owner answered his outreach. Write Toheeb's answer to what they actually wrote.
Rules:
- 40 to 90 words. Plain, warm, human. Greet by name only if the reply gives one.
- If they are interested: thank them, say what you will send, and make ONE easy next step.
- If they ask a question: answer briefly using only the facts given. NEVER invent prices, timelines, results, past clients or promises. If you do not know, say you will confirm and ask ONE question.
- If they decline or ask you to stop: thank them politely, confirm you will not message again, and do not pitch.
- If it is unclear: ask ONE short question.
- Claims about their store only from the observations given.
Return ONLY JSON: {"intent":"interested"|"question"|"declined"|"unclear","subject":string,"body":string}`;
    const usr = `Store: ${b.name} (${b.url})
My services: ${b.services || 'Email marketing strategy and WordPress web design'}
Observations: ${JSON.stringify(b.observations || [])}
My first email: ${b.firstEmail?.body || ''}
Their reply:
${String(b.theirReply || '').slice(0, 2000)}`;
    const out = await askAI(sys, usr);
    if (!out.ok) return res.status(502).json({ error: out.error });
    return res.status(200).json({ provider: out.provider, ...out.json });
  }

  if (req.body?.mode === 'followup') {
    const b = req.body;
    const n = b.count || 0;
    const sys = `You write a short follow-up for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM).
${TONE}
He already sent the first message below to this store and got no reply. Write follow-up number ${n + 1}.
Rules:
- If an observation is about a signup form or email capture, keep it as a question ("did I miss one?") and never state that the store has none.
- Do not repeat the first pitch. Refer to it lightly (for example "my note last week").
- Add ONE new bit of value: a quick tip or micro-idea tied to the same observation. Use only facts from the observations given; never add new claims about the store.
- Make exactly ONE easy ask, and give an easy out ("no worries if it's not a priority").
- If a speed test result is given and its score is below 60, you may use it as the ONE new bit of value, stated plainly and kindly (for example "your page took about 5 seconds to show its main content on a phone"). Otherwise ignore it.
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
First WhatsApp I sent: ${b.firstWa || ''}
Speed test (Google PageSpeed, mobile): ${b.speed ? `score ${b.speed.score} of 100, main content shows in ${b.speed.lcp}` : 'not run'}`;
    const out = await askAI(sys, usr);
    if (!out.ok) return res.status(502).json({ error: out.error });
    return res.status(200).json({ provider: out.provider, ...out.json });
  }

  if (req.body?.mode === 'rewrite') {
    // Rewrites ONE draft (email, DM or WhatsApp) from the points already verified. No page is loaded, so it is fast and cheap.
    const b = req.body;
    const kind = ['email', 'dm', 'whatsapp'].includes(b.kind) ? b.kind : 'email';
    const obs = (Array.isArray(b.observations) ? b.observations : []).slice(0, 6).map((o) => ({ issue: o.issue, evidence: o.evidence || '' }));
    if (!obs.length) return res.status(400).json({ error: 'There are no verified points to write from. Audit the store again.' });
    const RULES = {
      email: 'Write ONE email. Subject: 2 to 6 words, specific to this store, written the way a person would type it, no colons, no marketing verbs. Body: 45 to 75 words in two or three short paragraphs. Start with the one specific thing you noticed, then one plain sentence on why it matters to them, then ONE easy ask. No lists, no bold, no links, no exclamation marks, and no money, currency or percent signs. Close with "Kind regards," and "Toheeb". Do not add an unsubscribe line (the app adds it).',
      dm: 'Write ONE Instagram or social DM. 45 to 70 words. Greet properly, name ONE specific thing you saw on this store, then ask one easy question or offer one quick helpful idea. No links, no emojis.',
      whatsapp: 'Write ONE WhatsApp message. 60 to 90 words. The store does not know this number, so greet properly, then introduce yourself in one line ("This is Toheeb from ATM. I help online stores with email marketing and website design."). Name ONE specific thing you saw, make ONE ask, then add a courteous line saying they can simply tell you if they would rather not be messaged. Close with "Kind regards, Toheeb", then on a new line "Portfolio: toheebakanni.name.ng". No other links, no emojis.',
    };
    const SHAPE = { email: '{"email":{"subject":string,"body":string}}', dm: '{"dm":string}', whatsapp: '{"whatsapp":string}' };
    const cur = kind === 'email' ? `${b.current?.email?.subject || ''}\n${b.current?.email?.body || ''}` : String(b.current?.[kind] || '');
    const sys = `You rewrite outreach for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM).
${TONE}
${RULES[kind]}
Rules:
- Use ONLY the verified points given. Never add a new claim about the store, its products, prices, stock or design.
- If a point is about a missing signup form or email capture, keep it as a question ("I could not find a way to join your email list. Did I miss one?") and never state that the store has none.
- Make exactly ONE ask. Never use the word "free".
- Write a clearly different version from the current draft: a different opening and different sentence shapes, but the same facts and the same offer.
${b.voice ? 'Writing style: ' + String(b.voice).slice(0, 300) : ''}
Return ONLY JSON in exactly this shape: ${SHAPE[kind]}`;
    const wcount = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
    const lint = (j) => {
      const p = [];
      const text = kind === 'email' ? `${j.email?.subject || ''} ${j.email?.body || ''}` : String(j[kind] || '');
      const body = kind === 'email' ? j.email?.body : text;
      if (!String(body || '').trim()) return ['the draft was empty'];
      if (/[$€£%]/.test(text)) p.push('remove every money, currency and percent sign');
      if (/https?:\/\/|www\./i.test(text)) p.push('remove links');
      const bad = AVOID.split(', ').filter((w) => new RegExp('\\b' + w.replace(/[-]/g, '[- ]?') + '\\b', 'i').test(text));
      if (bad.length) p.push('do not use these words: ' + bad.join(', '));
      if (kind === 'email') {
        if (text.includes('!')) p.push('remove exclamation marks');
        if (wcount(j.email?.subject) > 6) p.push('shorten the subject to 6 words or fewer');
        const n = wcount(body);
        if (n < 40 || n > 80) p.push(`make the body 45 to 75 words (it is ${n} now)`);
      } else if (kind === 'dm' && wcount(text) > 75) p.push('shorten to under 70 words');
      else if (kind === 'whatsapp' && wcount(text) > 95) p.push('shorten to under 90 words');
      return p;
    };
    const usr = `Store: ${b.name} (${b.url})
My services: ${b.services || 'Email marketing strategy and WordPress web design'}
Verified points: ${JSON.stringify(obs)}
Speed test (mobile): ${b.speed ? `score ${b.speed.score} of 100, main content shows in ${b.speed.lcp}` : 'not run'}
Current draft to replace:
${cur.slice(0, 1500)}
${b.problems ? 'Problems found in the current draft that the new one must NOT have: ' + String(b.problems).slice(0, 400) : ''}`;
    let out = await askAI(sys, usr);
    if (!out.ok) return res.status(502).json({ error: out.error });
    let issues = lint(out.json);
    if (issues.length) {
      const again = await askAI(sys, usr + `\n\nYour last attempt had these problems. Fix all of them: ${issues.join('; ')}.`);
      if (again.ok && lint(again.json).length <= issues.length) out = again;
    }
    return res.status(200).json({ provider: out.provider, kind, [kind]: out.json[kind] });
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
  const paths = contactPaths(html, target);
  const pages = await Promise.allSettled(paths.map(async (p) => {
    const u = new URL(p, target);
    const rr = await fetch(u, { headers: UA, signal: AbortSignal.timeout(6000) });
    return rr.ok ? await rr.text() : '';
  }));
  const extra = pages.map((x) => (x.status === 'fulfilled' ? x.value : '')).join(' ');
  const found = findContacts(html + ' ' + extra, target.hostname);

  const platform = detect(html);
  const sig = signals(html);
  const text = toText(html);
  
  let productText = '', stock = 'not checked', facts = null;
  const pm = html.match(/href=["']([^"']*\/products?\/[^"'#?]+)["']/i);
  if (pm) {
    try {
      const pu = new URL(pm[1], target);
      if (pu.hostname === target.hostname) {
        const pr = await fetch(pu, { headers: UA, signal: AbortSignal.timeout(8000) });
        if (pr.ok) productText = toText(await pr.text()).slice(0, 2500);
        const prod = await checkProduct(pu); stock = prod.stock; facts = prod.facts;
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

- You only see flattened text: paragraph breaks, bullets, headings, fonts, colours, spacing, images, layout and how a page looks or reads on mobile are lost. NEVER make claims about the homepage's formatting, layout, design, visual appearance or readability. The only exception is the product description, and only through the "Product facts" line, which comes from the store's own data: say the description is one block of text only if oneBlock is true; mention missing bullet points only if bulletItems is 0 and oneBlock is true; image and variant counts are allowed. If Product facts say not available, make no formatting claims at all.
- NEVER mention announcement bars, top banners, tickers or placeholder or default theme text (for example "Welcome to our store", "Lorem ipsum", "Your text here"). Themes keep this text in the page code even when visitors never see it, so you cannot tell what is really shown.
- "emailSignupFormDetected: true" means an email field exists in the homepage code. Then NEVER say the store has no signup form, newsletter form or email capture. You may only suggest improving what they offer in return for the email. If it is false, you still cannot be sure (popups and embedded forms load later), so NEVER state that the store has no signup or email capture. Write the observation as what you could not find, for example issue "Could not find a way to join the email list on the homepage" with evidence "No signup form appears in the page code, though a popup may load later." In every draft, turn it into a question such as "I could not find a way to join your email list on the homepage. Did I miss one?" and then make the one offer (for example sketching a short welcome email).
- Words such as "Sold out", "Sale", "Unavailable" or "Variant sold out" often sit in hidden template text on a page even when the item is in stock. NEVER say a product is sold out, out of stock or unavailable unless the "Stock check" line says SOLD OUT. If it says IN STOCK, or "not checked", do not mention stock at all.

- Quotes: for every observation about something the page says or shows, put 3 to 12 consecutive words copied EXACTLY from the homepage text or the product page text into "quote". For an observation about something missing or not found, or one based on Product facts, set "quote" to an empty string. Never invent, translate or reword a quote.
- angle: the single main angle of your pitch, exactly one of: email-capture, welcome-flow, product-copy, trust, store-design, stock, other.

Relevance rules:
- Only raise things Toheeb could actually help with given his services: email capture and flows, copywriting, product page clarity, store design, trust and conversion. Ignore the store's business model, pricing, or how its own product works.

Drafting rules:
- Email subject: 2 to 6 words, specific to this store, written the way a person would type it (for example "your welcome email" or "question about the Ocean Blue page"). No colons, no marketing verbs.
- Email body: 45 to 75 words in two or three short paragraphs. Start with the one specific thing you noticed (add a compliment only if it is genuinely specific, never a generic "I admired..."). Then one plain sentence on why it matters to them, then ONE easy ask. No lists, no bold, no links. Close with "Kind regards," and "Toheeb". Write each email fresh; do not reuse the same opening or sentence shapes for every store. Do not add an unsubscribe line (the app adds it).
- DM: 45 to 70 words. Greet properly, name ONE specific thing you saw on this store, then ask one easy question or offer one quick helpful idea.
- WhatsApp: 60 to 90 words. The store does not know this number, so greet properly, then introduce yourself in one line ("This is Toheeb from ATM. I help online stores with email marketing and website design."). Name ONE specific thing you saw, make ONE ask, then add a courteous line saying they can simply tell you if they would rather not be messaged. Close with "Kind regards, Toheeb", then on a new line "Portfolio: toheebakanni.name.ng". No other links.
- All three must point to something concrete from this store. Never use vague filler such as "I help with that stuff", "saw your site", or "let me know".
- If something might just be hidden from you (popups, reviews, email forms), ask a question about it instead of saying it is missing.
- Simple English, no emojis, no hype words, no slang.
- Style example for a DM (match this quality; it is from a different store, so never reuse its details): "Hello, I liked the bespoke game sets on The Craft House. The product pages list sizes and materials but never say who each set is for. Are you planning to refresh them soon? Happy to sketch a clearer version of one."

Pitch logic (follow this for every draft):
1. Pick the single best observation: something concrete the store could fix or gain that Toheeb's services solve.
2. After the greeting, open with one genuine compliment on something specific (a product, collection or line of copy), then the observation. Never open with a generic compliment.
3. Connect the observation to a benefit in plain words (more first orders, fewer abandoned carts, less confusion), not a feature.
4. Make exactly ONE ask: either a question OR an offer of one small piece of work for them (for example "I can sketch a 3-email welcome flow"); never use the word "free". Never both.
5. Match the offer to the observation: no signup form found (only ever phrased as a question, never as a fact) means offer to sketch a welcome email; sold-out items (only when the Stock check says SOLD OUT) mean restock or waitlist emails; confusing or thin copy on a page means a quick rewrite of that page; weak product copy means rewrite one product page.
6. A product page excerpt may be included. Comment on product descriptions only if that excerpt is there.
7. Before answering, check the draft: is every fact visible in the evidence, is there one ask, and would a stranger understand the point in 5 seconds? Fix it if not.

Return ONLY JSON in exactly this shape: {"storeName":string,"angle":string,"observations":[{"issue":string,"evidence":string,"quote":string}],"email":{"subject":string,"body":string},"dm":string,"whatsapp":string}`;

  const user = `Store URL: ${target.href}
Platform detected: ${platform}
Hints: ${JSON.stringify(sig)}
My services and offers: ${services || 'Email marketing strategy and WordPress web design'}
My writing style: ${voice || 'warm, professional, respectful'}
Homepage text (trimmed):
${text}
One product page (trimmed):
${productText || 'not available'}
Stock check for that product (from the store's own data): ${stock}
Product facts (from the store's own data): ${facts ? JSON.stringify(facts) : 'not available'}`;

  const order = (process.env.AI_PROVIDER || 'gemini').toLowerCase() === 'groq' ? ['groq', 'gemini'] : ['gemini', 'groq'];
  const keys = { gemini: process.env.GEMINI_API_KEY, groq: process.env.GROQ_API_KEY };
  async function generate(extra) {
    let err = '';
    for (const p of order) {
      if (!keys[p]) continue;
      const out = await (p === 'gemini' ? askGemini : askGroq)(system, user + extra, keys[p]);
      if (out.ok) {
        try { return { ok: true, provider: p, json: JSON.parse(out.text.slice(out.text.indexOf('{'), out.text.lastIndexOf('}') + 1)) }; }
        catch { err = err || 'The AI reply could not be read. Try again.'; }
      } else err = err || out.error;
    }
    return { ok: false, error: err || 'No AI key is set. Add GEMINI_API_KEY or GROQ_API_KEY in Vercel.' };
  }

  let gen = await generate('');
  if (!gen.ok) return res.status(502).json({ error: gen.error });
  const corpus = text + ' ' + productText;
  let v = verifyObs(gen.json.observations, corpus), redrafted = false;
  const removed = v.dropped;
  if (removed > 0 && v.kept.length) {
    // Some points could not be matched to the page. Rewrite the drafts using only the points that could.
    const again = await generate(`\n\nIMPORTANT: ${removed} earlier point(s) were removed because their quotes were not found on the page. Write ALL drafts using ONLY these verified points and mention nothing else about the store:\n${JSON.stringify(v.kept.map((k) => ({ issue: k.issue, evidence: k.evidence })))}`);
    if (again.ok) {
      const v2 = verifyObs(again.json.observations, corpus);
      if (v2.kept.length) { gen = again; v = v2; redrafted = true; }
    }
  }
  const observations = v.kept.length ? v.kept : (gen.json.observations || []).map((o) => ({ issue: o.issue, evidence: o.evidence || '', check: 'unchecked' }));
  return res.status(200).json({ platform, signals: sig, found, provider: gen.provider, ...gen.json, observations, productFacts: facts, verification: { removed, redrafted } });
}
