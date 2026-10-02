/**
 * Uber trip emails -> the bank payment that settled them
 *
 * Lives in the same Apps Script project as axis-alerts.gs (it uses that file's SETTINGS and helpers)
 * and runs at the end of every syncAxisAlerts(), so a trip's bank alert has already been saved
 * by the time it is looked for.
 *
 * Each "trip with Uber" email from noreply@uber.com says what was paid and when. The rider usually
 * pays the driver by UPI, so the bank sees a payment to a person, not to Uber. This finds that
 * payment and files it under Uber, category Rides, with the person's name in the note.
 *
 *   rides/{gmail id}   { provider, total, paid, method, date, time, paidAt, status, txId }
 *   txmeta/{tx id}     { vendor: 'Uber', category: 'Rides', note: 'Paid to ...', ride: ride id }
 *
 * status: 'pending' (looking, retried every run for a day), 'matched', 'direct' (paid to Uber
 * itself, nothing to change) or 'unmatched' (nothing fitted; left alone for you to sort out by hand).
 * A payment is only ever claimed when exactly one fits, and a payment you have already
 * categorised or renamed is never touched.
 */
const UBER = {
  sender: 'noreply@uber.com',
  firstRunDays: 14,            // how far back the first run looks
  waitHours: 24,               // how long a trip keeps looking for its payment
  earlyMin: 20,                // a payment may be seen this long before the time on the email...
  lateMin: 45,                 // ...or this long after it
  tipMax: 40,                  // paid more than the fare by up to this (or a quarter of it) still counts
  tipPct: 0.25,
  closeExtra: 5,               // ...and one this close to the fare wins over a looser fit
  slack: 1.5,                  // paid slightly less than the fare (rounding) still counts
};

/** Reads new trip emails, then tries to match every trip that is still looking. */
function syncUberTrips() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty('lastUberDate') || 0);
  const query = `from:${UBER.sender} subject:"trip with Uber" ` +
    (since ? `after:${Math.floor(since / 1000)}` : `newer_than:${UBER.firstRunDays}d`);
  const ids = listMessageIds(query).reverse();

  const fresh = {};
  let checkpoint = since;
  for (let i = 0; i < ids.length; i += 1) {
    const message = getMessage(ids[i]);
    if (!message) break;   // rate limited: the next run carries on
    checkpoint = Math.max(checkpoint, Number(message.internalDate));
    const ride = parseUberTrip(messageText(message), Number(message.internalDate));
    if (ride) fresh[ids[i]] = ride;
    Utilities.sleep(SETTINGS.pauseMs);
  }
  if (Object.keys(fresh).length) firebasePatch(`users/${SETTINGS.uid}/rides`, fresh);
  if (checkpoint > since) props.setProperty('lastUberDate', String(checkpoint));

  matchUberTrips();
}

/** Matches every trip that is still pending. */
function matchUberTrips() {
  const base = `users/${SETTINGS.uid}`;
  const rides = firebaseGet(`${base}/rides`) || {};
  const pending = Object.entries(rides).filter(([, r]) => r.status === 'pending');
  if (!pending.length) return;

  const txs = firebaseGet(`${base}/transactions`, '?orderBy=%22%24key%22&limitToLast=300') || {};
  const meta = firebaseGet(`${base}/txmeta`) || {};
  const taken = new Set(Object.values(rides).map((r) => r.txId).filter(Boolean));
  const now = Date.now();

  pending.sort((a, b) => a[1].paidAt - b[1].paidAt).forEach(([id, ride]) => {
    const result = matchRide(ride, txs, meta, taken);
    if (result.txId) {
      taken.add(result.txId);
      if (result.status === 'matched') {
        const tx = txs[result.txId];
        firebasePatch(`${base}/txmeta/${result.txId}`, {
          vendor: 'Uber', category: 'Rides', note: `Paid to ${nameCase(tx.description)}`, ride: id,
        });
      }
      firebasePatch(`${base}/rides/${id}`, { status: result.status, txId: result.txId });
    } else if (now - ride.paidAt > UBER.waitHours * 3600 * 1000) {
      firebasePatch(`${base}/rides/${id}`, { status: 'unmatched' });   // left alone, for a manual fix
    }
  });
}

/**
 * Pure matching, no Google services, so it can be tested on its own.
 * Returns { status: 'direct' | 'matched', txId } when exactly one payment fits, otherwise {}.
 */
function matchRide(ride, txs, meta, taken) {
  const fits = (tx) => {
    // the saved channel can say "Credit card" because of the alert's footer, so go by the details, as the page does
    if (tx.type !== 'debit' || !/\bUPI\//i.test(tx.excerpt || '') || taken.has(tx.id)) return false;
    const gap = (tx.createdAt - ride.paidAt) / 60000;
    return gap >= -UBER.earlyMin && gap <= UBER.lateMin;
  };
  const candidates = Object.entries(txs).map(([id, tx]) => ({ ...tx, id })).filter(fits);

  // paid to Uber itself: the same amount as the whole fare, nothing to change
  const direct = candidates.filter((tx) => /\buber\b/i.test(tx.description || '') && Math.abs(tx.amount - ride.total) <= 1);
  if (direct.length === 1) return { status: 'direct', txId: direct[0].id };
  if (direct.length > 1) return {};

  // already filed under Uber (by hand, or by an earlier run): counted as done, nothing to write
  const filed = candidates.filter((tx) => meta[tx.id] && meta[tx.id].vendor === 'Uber' && Math.abs(tx.amount - (ride.paid || ride.total)) <= Math.max(UBER.tipMax, UBER.tipPct * ride.total));
  if (filed.length === 1) return { status: 'direct', txId: filed[0].id };

  // paid to the driver: about the amount that was due, possibly rounded up or with a little extra
  const due = ride.paid || ride.total;
  const people = candidates.filter((tx) => {
    if (/\buber\b/i.test(tx.description || '') || /\bPOTLURI\b/i.test(tx.description || '')) return false;   // Uber itself is handled above; family payments are never rides
    const own = meta[tx.id];
    if (own && (own.vendor || own.category)) return false;   // already sorted by hand
    const extra = tx.amount - due;
    return extra >= -UBER.slack && extra <= Math.max(UBER.tipMax, UBER.tipPct * due);
  });
  if (people.length === 1) return { status: 'matched', txId: people[0].id };
  // several fit: one that is almost exactly the amount due beats ones that are only roughly it
  const close = people.filter((tx) => tx.amount - due <= UBER.closeExtra);
  return close.length === 1 ? { status: 'matched', txId: close[0].id } : {};
}

/* ------------------------------------------------------------------ parsing */

/** Reads one trip email's text. Returns null when it isn't a trip receipt. */
function parseUberTrip(text, internalDate) {
  const flat = text.replace(/\s+/g, ' ');
  const total = number(flat.match(/\bTotal\s*₹\s*([\d,]+(?:\.\d+)?)/i));
  if (total == null) return null;

  // "Payments  Cash ₹272.56 10/2/26 10:29 am" (a trip can be split over several payments)
  const section = (flat.match(/\bPayments\b(.*?)(?:Download the receipt|This receipt|Trip details|$)/i) || [])[1] || '';
  let paid = 0;
  let paidAt = null;
  const methods = [];
  const line = /([A-Za-z][A-Za-z &]*?)\s*₹\s*([\d,]+(?:\.\d+)?)(?:\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})\s*([ap]m))?/gi;
  let m;
  while ((m = line.exec(section))) {
    paid += Number(m[2].replace(/,/g, ''));
    methods.push(m[1].trim());
    if (m[3]) paidAt = indiaTime(Number(m[5]) < 100 ? 2000 + Number(m[5]) : Number(m[5]), Number(m[3]), Number(m[4]), Number(m[6]), Number(m[7]), m[8]);
  }
  const at = paidAt || internalDate;   // the email goes out at the moment of payment
  return {
    provider: 'uber',
    total,
    paid: paid || total,
    method: methods.join(' + ') || null,
    date: Utilities.formatDate(new Date(at), SETTINGS.timeZone, 'yyyy-MM-dd'),
    time: Utilities.formatDate(new Date(at), SETTINGS.timeZone, 'HH:mm'),
    paidAt: at,
    status: 'pending',
    createdAt: Date.now(),
  };
}

function number(match) {
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

// the email prints month/day/year in Indian time
function indiaTime(year, month, day, hour, minute, meridiem) {
  const h = (hour % 12) + (/p/i.test(meridiem) ? 12 : 0);
  return Date.UTC(year, month - 1, day, h, minute) - (5 * 60 + 30) * 60000;
}

function nameCase(value) {
  const text = String(value || '').trim();
  return text === text.toUpperCase()
    ? text.toLowerCase().replace(/(^|[\s.&'-])([a-z])/g, (_, a, b) => a + b.toUpperCase())
    : text;
}

/** Diagnostics: logs what the parser makes of the 5 most recent trip emails, saving nothing. */
function previewUber() {
  listMessageIds(`from:${UBER.sender} subject:"trip with Uber" newer_than:30d`).slice(0, 5).forEach((id) => {
    const message = Gmail.Users.Messages.get('me', id, { format: 'full' });
    console.log(`${header(message, 'Subject')}\nPARSED: ${JSON.stringify(parseUberTrip(messageText(message), Number(message.internalDate)))}`);
    Utilities.sleep(SETTINGS.pauseMs);
  });
}

/* ------------------------------------------------------------------ Firebase */

function firebaseGet(path, query) {
  const url = `${SETTINGS.databaseURL}/${path}.json?access_token=${encodeURIComponent(ScriptApp.getOAuthToken())}${query ? `&${query.replace(/^\?/, '')}` : ''}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() >= 300) throw new Error(`Firebase said ${res.getResponseCode()}: ${res.getContentText()}`);
  return JSON.parse(res.getContentText());
}

function firebasePatch(path, body) {
  firebase('patch', path, body);
}
