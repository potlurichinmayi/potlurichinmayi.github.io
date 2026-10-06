/**
 * Market quotes -> the Investments tab
 *
 * A tiny web app that fetches NSE share prices for the tracker. The browser cannot ask Yahoo Finance
 * directly (it blocks other sites), so the tracker asks this script, which runs in your own Google
 * account, and the script asks Yahoo. Nothing is stored; prices are cached for a minute or two so
 * the tracker's refreshes stay cheap.
 *
 * Setup (once):
 *   1. script.google.com -> New project. Paste this file over Code.gs.
 *   2. Project settings -> tick "Show appsscript.json" and paste tracker-scripts/market-appsscript.json.
 *   3. Change SECRET below to any long random text, then Save.
 *   4. Deploy -> New deployment -> type "Web app". Execute as: Me. Who has access: Anyone. Deploy and approve access.
 *   5. In the tracker, open Finance -> Investments -> Market data, and paste the web app URL and the same SECRET.
 *
 * Yahoo's chart service is unofficial, so it can change without notice. If prices stop loading,
 * this is the only file that needs to change.
 *
 * Requests (all GET):
 *   ?op=search&q=RELIANCE                         NSE shares matching the text
 *   ?op=intraday&s=RELIANCE,ITC                   today's 1-minute prices (or the last session's)
 *   ?op=daily&s=RELIANCE,ITC&from=2025-11-17      daily closes since a date (the index is asked for as ^NSEI)
 * Every request also carries &key=SECRET.
 */
const SECRET = 'CHANGE_ME_TO_A_LONG_RANDOM_TEXT';
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36' };

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.key !== SECRET) return out({ error: 'Wrong key' });
  try {
    if (p.op === 'search') return out(search(String(p.q || '')));
    const symbols = String(p.s || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 40);
    if (p.op === 'intraday') return out(batch(symbols, (s) => chart(s, 'interval=1m&range=1d', 60)));
    if (p.op === 'daily') {
      const from = Math.floor(Date.parse((p.from || '2020-01-01') + 'T00:00:00+05:30') / 1000);
      const to = Math.floor(Date.now() / 1000) + 86400;
      return out(batch(symbols, (s) => chart(s, `interval=1d&period1=${from}&period2=${to}`, 1800)));
    }
    return out({ error: 'Unknown op' });
  } catch (err) {
    return out({ error: String(err) });
  }
}

function out(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

/** Yahoo's name for a symbol: NSE shares end in .NS, the index starts with ^ */
const yahooSymbol = (s) => (s.startsWith('^') ? s : `${s}.NS`);

function search(q) {
  if (!q.trim()) return [];
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`;
  const res = UrlFetchApp.fetch(url, { headers: UA, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error(`Search failed (${res.getResponseCode()})`);
  return (JSON.parse(res.getContentText()).quotes || [])
    .filter((x) => x.exchange === 'NSI' && x.quoteType === 'EQUITY' && /\.NS$/.test(x.symbol))
    .map((x) => ({ symbol: x.symbol.replace(/\.NS$/, ''), name: x.longname || x.shortname || x.symbol }));
}

/** Fetches every symbol in parallel; a symbol that fails comes back as { error } so the rest still work */
function batch(symbols, build) {
  const result = {};
  symbols.forEach((s) => { result[s] = null; });
  const requests = [];
  const owners = [];
  symbols.forEach((s) => {
    const job = build(s);   // { url, ttl, key }
    const hit = CacheService.getScriptCache().get(job.key);
    if (hit) { result[s] = JSON.parse(hit); return; }
    requests.push({ url: job.url, headers: UA, muteHttpExceptions: true });
    owners.push({ s, job });
  });
  const responses = requests.length ? UrlFetchApp.fetchAll(requests) : [];
  responses.forEach((res, i) => {
    const { s, job } = owners[i];
    if (res.getResponseCode() !== 200) { result[s] = { error: `HTTP ${res.getResponseCode()}` }; return; }
    const parsed = parseChart(res.getContentText());
    result[s] = parsed;
    if (!parsed.error) { try { CacheService.getScriptCache().put(job.key, JSON.stringify(parsed), job.ttl); } catch (err) { /* too big to cache: fine */ } }
  });
  return result;
}

function chart(symbol, query, ttl) {
  return { url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?${query}&includePrePost=false`, ttl, key: `${symbol}:${query}`.slice(0, 240) };
}

/** Keeps only what the tracker uses: times, closes, the previous close, the latest price and the name */
function parseChart(text) {
  const data = JSON.parse(text);
  const r = data.chart && data.chart.result && data.chart.result[0];
  if (!r) return { error: (data.chart && data.chart.error && data.chart.error.description) || 'No data' };
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const t = [];
  const c = [];
  (r.timestamp || []).forEach((ts, i) => {
    const v = q.close && q.close[i];
    if (v != null) { t.push(ts); c.push(Math.round(v * 100) / 100); }
  });
  return {
    name: r.meta.longName || r.meta.shortName || r.meta.symbol,
    price: r.meta.regularMarketPrice,
    time: r.meta.regularMarketTime,
    prev: r.meta.chartPreviousClose,
    t, c,
  };
}
