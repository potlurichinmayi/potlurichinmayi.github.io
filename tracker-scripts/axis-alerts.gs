/**
 * Axis Bank alerts -> Potluri tracker
 *
 * Runs inside your own Google account. Every 15 minutes it reads new emails from
 * alerts@axis.bank.in (read-only), turns each one into a transaction and saves it
 * to the tracker's Firebase database under your account. The emails themselves
 * never leave Google; only the parsed amount, date, description and a short
 * excerpt are saved.
 *
 * Setup: choose `setup` in the toolbar, press Run and approve access once.
 */
const SETTINGS = {
  databaseURL: 'https://chinmayiip-default-rtdb.asia-southeast1.firebasedatabase.app',
  uid: 'PASTE_YOUR_ACCOUNT_ID',
  sender: 'alerts@axis.bank.in',
  backfillDays: 120,          // how far back the first run looks
  timeZone: 'Asia/Kolkata',
  pauseMs: 250,               // gap between emails, to stay under Gmail's per-minute limit
  maxRunMs: 4.5 * 60 * 1000,  // stop well before Apps Script's 6-minute cap; the next run carries on
};

/** Run once: schedules the 15-minute check and does the first sync. */
function setup() {
  if (!/^[A-Za-z0-9]{20,}$/.test(SETTINGS.uid)) {
    throw new Error('Set SETTINGS.uid to the account id shown in the tracker first.');
  }
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'syncAxisAlerts')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('syncAxisAlerts').timeBased().everyMinutes(15).create();
  syncAxisAlerts();
}

/**
 * Reads alerts newer than the last run and saves them as transactions.
 * Works oldest first and saves progress every 50 emails, so a run that stops early
 * (Gmail's rate limit, or the time cap on a big first backfill) loses nothing and the
 * next run, 15 minutes later, picks up where it left off.
 */
function syncAxisAlerts() {
  const started = Date.now();
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('lastInternalDate') || 0);
  const query = `from:${SETTINGS.sender} ` +
    (since ? `after:${Math.floor(since / 1000)}` : `newer_than:${SETTINGS.backfillDays}d`);
  const ids = listMessageIds(query).reverse();   // Gmail lists newest first

  let records = {};
  let checkpoint = since;
  let saved = 0;
  let caughtUp = true;

  const flush = () => {
    const count = Object.keys(records).length;
    if (count) firebase('patch', `users/${SETTINGS.uid}/transactions`, records);   // the Gmail id is the key, so re-runs never duplicate
    saved += count;
    records = {};
    if (checkpoint > since) props.setProperty('lastInternalDate', String(checkpoint));
  };

  for (let i = 0; i < ids.length; i += 1) {
    if (Date.now() - started > SETTINGS.maxRunMs) { caughtUp = false; break; }
    const message = getMessage(ids[i]);
    if (!message) { caughtUp = false; break; }   // still rate limited: stop and let the next run continue
    checkpoint = Math.max(checkpoint, Number(message.internalDate));
    const record = parseAlert(message);
    if (record) records[ids[i]] = record;
    if ((i + 1) % 50 === 0) flush();
    Utilities.sleep(SETTINGS.pauseMs);
  }
  flush();

  firebase('patch', `users/${SETTINGS.uid}/meta/finance`, { lastSync: Date.now(), lastFound: saved, caughtUp });
  console.log(`Saved ${saved} transaction(s)${caughtUp ? '.' : '; more to bring in on the next run.'}`);
}

/** Fetches one email, waiting and retrying if Gmail's per-minute limit is hit. Returns null if it still is. */
function getMessage(id) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return Gmail.Users.Messages.get('me', id, { format: 'full' });
    } catch (err) {
      if (!/quota|rate ?limit|too many/i.test(String(err))) throw err;
      console.warn(`Gmail rate limit reached; waiting before retry ${attempt}.`);
      Utilities.sleep(20000 * attempt);
    }
  }
  return null;
}

/** Forget what has been read, so the next run looks back `backfillDays` again. */
function resyncFromScratch() {
  PropertiesService.getScriptProperties().deleteProperty('lastInternalDate');
  syncAxisAlerts();
}

function listMessageIds(query) {
  const ids = [];
  let pageToken;
  do {
    const page = Gmail.Users.Messages.list('me', { q: query, maxResults: 100, pageToken });
    (page.messages || []).forEach((m) => ids.push(m.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/* ------------------------------------------------------------------ parsing */

function parseAlert(message) {
  const subject = header(message, 'Subject');
  const text = messageText(message);
  const all = `${subject}\n${text}`;
  if (/\bOTP\b|one[- ]time password/i.test(all)) return null;

  const amount = money(all.match(/(?:Amount\s+(?:Debited|Credited|Spent)\s*[:\-]?\s*)?(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i));
  if (amount == null) return null;   // not a transaction alert (statements, offers, ...)

  const type = detectType(all);
  const description = describe(text);
  const when = new Date(Number(message.internalDate));
  const record = {
    amount,
    type: type || 'unknown',
    description: description || null,
    account: (all.match(/(?:A\/c|Account|Acct|Card)(?:\s*(?:no\.?|number|ending(?:\s+with)?))?\s*[:\-]?\s*(?:XX|X+|\*+)\s*(\d{3,6})/i) || [])[1] || null,
    channel: detectChannel(all),
    balance: money(all.match(/(?:Avl\.?\s*Bal(?:ance)?|Available\s+(?:balance|limit))\s*(?:is)?\s*[:\-]?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i)),
    date: Utilities.formatDate(when, SETTINGS.timeZone, 'yyyy-MM-dd'),
    time: Utilities.formatDate(when, SETTINGS.timeZone, 'HH:mm'),
    subject: subject.slice(0, 160),
    excerpt: text.replace(/\s+/g, ' ').trim().slice(0, 400),
    needsReview: !type || !description,
    createdAt: when.getTime(),
    updatedAt: Date.now(),
  };
  Object.keys(record).forEach((key) => record[key] == null && delete record[key]);
  return record;
}

function money(match) {
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

function detectType(all) {
  if (/Amount\s+Debited/i.test(all)) return 'debit';
  if (/Amount\s+Credited/i.test(all)) return 'credit';
  const plain = all.replace(/credit\s+card/gi, 'card').replace(/debit\s+card/gi, 'card');
  const debit = plain.search(/\b(debited|spent|withdrawn|paid|purchase|debit)\b/i);
  const credit = plain.search(/\b(credited|received|refund(?:ed)?|reversal|reversed|credit)\b/i);
  if (debit < 0 && credit < 0) return null;
  if (debit < 0) return 'credit';
  if (credit < 0) return 'debit';
  return debit < credit ? 'debit' : 'credit';
}

function detectChannel(all) {
  if (/credit\s+card/i.test(all)) return 'Credit card';
  if (/debit\s+card/i.test(all)) return 'Debit card';
  if (/\bUPI\b/.test(all)) return 'UPI';
  if (/\bATM\b/.test(all)) return 'ATM';
  const transfer = all.match(/\b(NEFT|IMPS|RTGS)\b/);
  return transfer ? transfer[1] : 'Account';
}

const CODES = /^(UPI|P2M|P2A|IMPS|NEFT|RTGS|ATM|ATM-WDL|POS|ECOM|MB|IB|BIL|ONL|INB|TPT|ACH|NACH|\d+)$/i;

function describe(text) {
  const info = text.match(/(?:Transaction\s+Info|Info)\s*[:\-]\s*([^\n]+)/i);
  if (info) {
    const value = info[1].split(/\s{2,}|Not you|Avl\.?\s*Bal|Available/i)[0].trim();
    if (value.includes('/')) {
      const segments = value.split('/').map((s) => s.trim()).filter((s) => /[A-Za-z]{3,}/.test(s) && !CODES.test(s));
      // prefer a name over a reference number like AXISN123456
      const name = segments.find((s) => !/\d/.test(s)) || segments[0];
      if (name) return tidy(name);
    }
    return tidy(value);
  }
  const merchant = text.match(/Merchant(?:\s+Name)?\s*[:\-]\s*([^\n]+)/i);
  if (merchant) return tidy(merchant[1]);
  const at = text.match(/\bat\s+(.+?)\s+on\s+\d{1,2}[-\/ ]/i);
  if (at) return tidy(at[1]);
  const to = text.match(/\b(?:to|towards|from)\s+([A-Za-z][A-Za-z0-9 &.'-]{2,40}?)(?:\s+on\b|\s+via\b|[.,\n])/);
  return to ? tidy(to[1]) : '';
}

function tidy(value) {
  return value.replace(/\s+/g, ' ').replace(/[.,;:\-\s]+$/, '').trim().slice(0, 60);
}

/* ------------------------------------------------------------------ helpers */

function header(message, name) {
  const found = (message.payload.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : '';
}

function messageText(message) {
  const parts = [];
  (function walk(part) {
    if (!part) return;
    if (part.parts) part.parts.forEach(walk);
    else if (part.body && part.body.data && /^text\/(plain|html)/i.test(part.mimeType || '')) {
      parts.push({ type: part.mimeType.toLowerCase(), text: decode(part.body.data) });
    }
  })(message.payload);
  const plain = parts.find((p) => p.type.startsWith('text/plain'));
  const html = parts.find((p) => p.type.startsWith('text/html'));
  const text = plain ? plain.text
    : html ? html.text
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<\/td>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      : (message.snippet || '');
  return text
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#8377;|&#x20b9;|&#X20B9;/g, '₹')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

function decode(data) {
  const bytes = typeof data === 'string' ? Utilities.base64DecodeWebSafe(data) : data;
  return Utilities.newBlob(bytes).getDataAsString('UTF-8');
}

function firebase(method, path, body) {
  const url = `${SETTINGS.databaseURL}/${path}.json?access_token=${encodeURIComponent(ScriptApp.getOAuthToken())}`;
  const res = UrlFetchApp.fetch(url, {
    method,
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error(`Firebase said ${res.getResponseCode()}: ${res.getContentText()}`);
  }
}
