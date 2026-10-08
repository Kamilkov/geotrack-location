'use strict';
const { wmoText } = require('./wmo');

const HANA_DOWN = 'Could not reach HANA – is the trial instance running? Details in the server log.';

/** Fill the virtual weatherText of TripWeather rows (one row, an array, or null) from weatherCode. */
function fillWeatherText(rows) {
  for (const r of [].concat(rows ?? [])) if (r && r.weatherCode != null) r.weatherText = wmoText(r.weatherCode);
}

/** Trips rows may carry expanded weather rows. */
function fillTripWeather(rows) {
  for (const t of [].concat(rows ?? [])) if (t?.weather) fillWeatherText(t.weather);
}

/** Leave a server-side error (5xx or no status) nothing but a fixed hint and its status; return the original message for the log. */
function maskServerError(err) {
  // CAP's own errors carry the HTTP status in `code` (405 for a write to a read-only entity);
  // HANA's SqlError carries its SQL error number there (259 = invalid table name).
  const sql = err.name === 'SqlError' || err.sqlState !== undefined;
  const status = Number(err.status ?? err.statusCode ?? (sql ? 500 : err.code ?? 500));
  if (status < 500) return null;
  const original = err.message;
  // In production CAP sends a 5xx message only with $sanitize false, and then other properties too (OData the
  // code, REST every enumerable one; @cap-js/hana puts the SQL text on `query`): none may stay.
  for (const k of Object.keys(err)) delete err[k];
  const sent = status < 600 ? status : 500; // NaN when `code` is no number (hdb's EHDBOPENCONN)
  Object.assign(err, { message: HANA_DOWN, code: String(sent), status: sent, $sanitize: false });
  return original;
}

module.exports = { fillWeatherText, fillTripWeather, maskServerError, HANA_DOWN };
