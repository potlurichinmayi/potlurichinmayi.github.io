/**
 * Rapido invoice emails -> the bank payment that settled them
 *
 * Needs uber-trips.gs in the same Apps Script project: it holds the matching and filing that
 * every ride provider shares. This file only says where Rapido's emails are and how to read one.
 * It runs at the end of every syncAxisAlerts(), after the Uber trips.
 *
 * Each "Rapido Invoice" email from No-Reply-invoices@rapido.bike says what the ride cost and
 * is sent at the drop. "You Paid Using Cash" only means the driver was paid directly, so it is
 * often a UPI payment to the driver's own account; the bank then sees a payment to a person.
 * That payment is filed under Rapido, category Commute, with the person's name in the note.
 * Rides that really were cash find nothing and settle as 'unmatched' after a day, left alone.
 */
const RAPIDO_PROVIDER = {
  key: 'rapido',
  vendor: 'Rapido',
  paidTo: /\b(rapido|roppen)\b/i,   // Roppen Transportation Services is the company behind Rapido
  query: 'from:No-Reply-invoices@rapido.bike subject:"Rapido Invoice"',
  lastProp: 'lastRapidoDate',
  parse: (text, internalDate) => parseRapidoTrip(text, internalDate),
};

function syncRapidoTrips() {
  syncRideEmails(RAPIDO_PROVIDER);
}

/** Diagnostics: logs what the parser makes of the 5 most recent Rapido invoices, saving nothing. */
function previewRapido() {
  previewRides(RAPIDO_PROVIDER);
}

/**
 * Reads one invoice's text. Returns null when it isn't a ride invoice.
 *   "Payment Summary Ride ID RD179... Time of Ride Oct 26th 2026, 9:36 AM Total ₹ 236.00 ...
 *    You Paid Using Cash ₹ 236.00"
 * "Time of Ride" is when the ride began; the email goes out at the drop, which is when the
 * rider pays, so that is the time the bank payment is looked for around.
 */
function parseRapidoTrip(text, internalDate) {
  const flat = text.replace(/\s+/g, ' ');
  const total = number(flat.match(/\bTotal\s*₹\s*([\d,]+(?:\.\d+)?)/i));
  if (total == null) return null;

  const section = (flat.match(/\bYou Paid Using\b(.*?)(?:Tax Invoice|$)/i) || [])[1] || '';
  let paid = 0;
  const methods = [];
  const line = /([A-Za-z][A-Za-z &]*?)\s*₹\s*([\d,]+(?:\.\d+)?)/g;
  let m;
  while ((m = line.exec(section))) {
    paid += Number(m[2].replace(/,/g, ''));
    methods.push(m[1].trim());
  }
  const at = internalDate;
  return {
    provider: 'rapido',
    rideId: (flat.match(/\bRide ID\s*(RD\d+)/i) || [])[1] || null,
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
