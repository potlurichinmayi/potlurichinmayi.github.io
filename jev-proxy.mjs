/* Jev proxy for studio2.html
 *
 * Why this exists: the Jev API has no CORS and needs a secret key, so a static
 * GitHub Pages file cannot call it directly. This forwards requests and keeps
 * the key on the server.
 *
 * Local:       node jev-proxy.mjs          → http://127.0.0.1:8787/studio2.html
 *              (reads JEV_API_KEY from .env, serves the site, proxies /api/jev)
 * Production:  deploy as a Cloudflare Worker, add the secret JEV_API_KEY,
 *              then paste the Worker URL into JEV_PROXY_URL in studio2.html.
 *
 * Nothing is stored here. Uploaded images pass through to Jev and are dropped.
 */
const UPSTREAM = 'https://api.typesafe.ai/v1/systemone';
const ALLOWED_ORIGINS = ['https://potlurichinmayi.github.io', 'http://127.0.0.1:8787', 'http://localhost:8787'];
const MAX_BODY = 3 * 1024 * 1024, MAX_QUESTIONS = 90, TYPES = new Set(['choice', 'score', 'noul']);

const cors = o => ({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', Vary: 'Origin' });
const json = (status, body, origin) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(origin ? cors(origin) : {}) } });

export async function handle(req, key) {
  const origin = req.headers.get('Origin') || '';
  if (!ALLOWED_ORIGINS.includes(origin)) return json(403, { error: 'origin not allowed' });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== 'POST') return json(405, { error: 'POST only' }, origin);
  if (!key) return json(500, { error: 'JEV_API_KEY is not set' }, origin);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return json(413, { error: 'request too large' }, origin);
  let b; try { b = JSON.parse(raw); } catch { return json(400, { error: 'invalid JSON' }, origin); }
  const q = b && b.questions, names = q && typeof q === 'object' ? Object.keys(q) : [];
  if (!names.length || names.length > MAX_QUESTIONS || names.some(n => !q[n] || !TYPES.has(q[n].type))) return json(400, { error: 'invalid questions' }, origin);
  if (b.assets && Object.keys(b.assets).length > 1) return json(400, { error: 'one image at most' }, origin);
  const out = { model: 'jev-latest', state: b.state ?? '', questions: q }, headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  if (b.assets) { out.assets = b.assets; headers['TypeSafe-Danger-Zone-Images'] = 'true'; }
  try {
    const r = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(out) });
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(origin) } });
  } catch { return json(502, { error: 'Jev is unreachable' }, origin); }
}

/* Cloudflare Worker entry */
export default { fetch: (req, env) => handle(req, env.JEV_API_KEY) };

/* Local dev server (only when run directly with node) */
if (typeof process !== 'undefined' && process.argv?.[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { createServer } = await import('node:http'), { readFile } = await import('node:fs/promises'), path = await import('node:path');
  const env = Object.fromEntries((await readFile('.env', 'utf8').catch(() => '')).split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
  createServer(async (rq, rs) => {
    const url = new URL(rq.url, 'http://127.0.0.1:8787');
    if (url.pathname === '/api/jev') {
      const chunks = []; for await (const c of rq) chunks.push(c);
      const res = await handle(new Request(url, { method: rq.method, headers: { ...rq.headers, origin: rq.headers.origin || 'http://127.0.0.1:8787' }, body: ['GET', 'HEAD', 'OPTIONS'].includes(rq.method) ? undefined : Buffer.concat(chunks) }), env.JEV_API_KEY);
      rs.writeHead(res.status, Object.fromEntries(res.headers)); return rs.end(await res.text());
    }
    const file = path.normalize(decodeURIComponent(url.pathname)).replace(/^\/+/, '') || 'studio2.html', type = MIME[path.extname(file)];
    if (!type || file.startsWith('..') || file.startsWith('.')) { rs.writeHead(404); return rs.end('not found'); }   // only site assets; never .env
    let data; try { data = await readFile(file); } catch { rs.writeHead(404); return rs.end('not found'); }
    rs.writeHead(200, { 'Content-Type': type }); rs.end(data);
  }).listen(8787, '127.0.0.1', () => console.log('1903 studio → http://127.0.0.1:8787/studio2.html' + (env.JEV_API_KEY ? '' : '  (no JEV_API_KEY in .env: local matcher only)')));
}
