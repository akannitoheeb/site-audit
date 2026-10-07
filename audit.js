// POST /api/audit  { url, email, social, services }
// Header: x-app-password

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/;

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
    popupSignals: has('popup', 'privy', 'justuno', 'optinmonster'),
    imageCount: (html.match(/<img/gi) || []).length,
    scriptCount: (html.match(/<script/gi) || []).length,
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
    const r = await fetch(target, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; ATM-Audit/1.0)' }, signal: AbortSignal.timeout(12000) });
    html = await r.text();
  } catch {
    return res.status(502).json({ error: 'Could not load that store. Check the link or try again.' });
  }

  const platform = detect(html);
  const sig = signals(html);
  const text = toText(html);

  const system = `You write outreach for Toheeb Akanni, a freelance email marketing strategist and WordPress web designer (brand: ATM, Akanni Toheeb Marketing).
You audit an online store from the evidence given and draft personal outreach.
Rules:
- Only state issues supported by the signals or page text. Never guess or invent. If evidence is weak, say "could not confirm" rather than claiming a problem.
- Give 3 to 4 observations, each specific to this store.
- Email: under 130 words, plain, friendly, no hype, mention one or two real observations, offer one clear next step, sign off as Toheeb. Do not add an unsubscribe line (the app adds it).
- DM: under 60 words, casual, one observation, one question.
- Nigerian business context is fine, keep English simple.
Return ONLY JSON: {"storeName":string,"observations":[{"issue":string,"evidence":string}],"email":{"subject":string,"body":string},"dm":string}`;

  const user = `Store URL: ${target.href}
Platform detected: ${platform}
Signals: ${JSON.stringify(sig)}
Contact given: ${email || 'none'} / ${social || 'none'}
My services and offers: ${services || 'Email marketing strategy and WordPress web design'}
Homepage text (trimmed):
${text}`;

  const provider = (process.env.AI_PROVIDER || 'groq').toLowerCase();
  try {
    let raw = '';
    if (provider === 'gemini') {
      const model = process.env.AI_MODEL || 'gemini-2.5-flash';
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.5 },
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
          temperature: 0.5,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        }),
      });
      const d = await r.json();
      if (!r.ok) return res.status(502).json({ error: d?.error?.message || 'AI request failed' });
      raw = d.choices?.[0]?.message?.content || '';
    }
    const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    return res.status(200).json({ platform, signals: sig, ...json });
  } catch {
    return res.status(500).json({ error: 'The AI reply could not be read. Try again.' });
  }
}
