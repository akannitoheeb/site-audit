// POST /api/speed  { url }   Header: x-app-password
// Runs Google's free PageSpeed test (mobile) and returns the score, key timings and a screenshot of the page.
// Optional: add PAGESPEED_API_KEY in Vercel (free, from Google Cloud) to avoid the shared free limit.
export const config = { maxDuration: 60 };

const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (req.headers['x-app-password'] !== process.env.APP_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  let target;
  try {
    target = new URL(req.body?.url);
    if (!/^https?:$/.test(target.protocol) || BLOCKED.test(target.hostname)) throw 0;
  } catch { return res.status(400).json({ error: 'Enter a valid store URL.' }); }

  const key = process.env.PAGESPEED_API_KEY;
  const api = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(target.href)}&strategy=mobile&category=performance${key ? '&key=' + key : ''}`;
  try {
    const r = await fetch(api, { signal: AbortSignal.timeout(55000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = r.status === 429
        ? 'Google\'s speed test is busy or its free limit is used up. Try again later, or add PAGESPEED_API_KEY in Vercel.'
        : (d?.error?.message || 'The speed test failed');
      return res.status(502).json({ error: msg });
    }
    const lh = d.lighthouseResult || {}, a = lh.audits || {};
    const score = lh.categories?.performance?.score;
    if (typeof score !== 'number') return res.status(502).json({ error: 'The speed test returned no score for this store. Try again.' });
    return res.status(200).json({
      score: Math.round(score * 100),
      lcp: a['largest-contentful-paint']?.displayValue || '',
      fcp: a['first-contentful-paint']?.displayValue || '',
      tbt: a['total-blocking-time']?.displayValue || '',
      cls: a['cumulative-layout-shift']?.displayValue || '',
      screenshot: a['final-screenshot']?.details?.data || '',
      at: Date.now(),
    });
  } catch { return res.status(502).json({ error: 'The speed test took too long or could not run. Try again.' }); }
}
