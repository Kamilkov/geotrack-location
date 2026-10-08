'use strict';
const { wmoText } = require('./wmo');
const cds = require('@sap/cds');
const { utcDate } = require('./time');
const log = cds.log('weather');

// Open-Meteo hourly variables, in the order the row fields below expect them.
const HOURLY = ['temperature_2m', 'apparent_temperature', 'precipitation', 'relative_humidity_2m', 'cloud_cover',
  'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'surface_pressure', 'weather_code'];
const FORECAST_URL = process.env.OPEN_METEO_URL || 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = process.env.OPEN_METEO_ARCHIVE_URL || 'https://archive-api.open-meteo.com/v1/archive';
const ARCHIVE_AFTER_DAYS = 90;   // the forecast endpoint serves ~92 past days; the archive lags ~5 days
const HOUR_MS = 3600000;
const BACKOFF_BASE_MS = 5 * 60000;
const BACKOFF_MAX_MS = 6 * HOUR_MS;

const floorHour = (d) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
const round2 = (n) => Math.round(n * 100) / 100;                  // ~1 km: all a third party ever sees
const hourKey = (d) => d.toISOString().slice(0, 13) + ':00';     // Open-Meteo's hourly.time format (UTC)
const dateKey = (d) => d.toISOString().slice(0, 10);

/** Every UTC hour the trip spans, each with the (rounded) position nearest that hour's midpoint. */
function hoursOf(trip, positions) {
  if (!positions.length) throw new Error('trip has no positions');
  const out = [];
  for (let h = floorHour(trip.startedAt); h <= floorHour(trip.endedAt); h = new Date(h.getTime() + HOUR_MS)) {
    const mid = h.getTime() + HOUR_MS / 2;
    let best = positions[0];
    for (const p of positions) if (Math.abs(p.ts - mid) < Math.abs(best.ts - mid)) best = p;
    out.push({ hour: h, lat: round2(best.lat), lon: round2(best.lon) });
  }
  return out;
}

/** One request for the whole trip: distinct locations, hour i reads location locationIndex[i]. */
function buildRequest(hours, startedAt, now = new Date()) {
  const locs = [], locationIndex = [];
  for (const h of hours) {
    let i = locs.findIndex((l) => l.lat === h.lat && l.lon === h.lon);
    if (i < 0) { i = locs.length; locs.push({ lat: h.lat, lon: h.lon }); }
    locationIndex.push(i);
  }
  const archive = now - startedAt > ARCHIVE_AFTER_DAYS * 86400000;
  // Built by hand: URLSearchParams would encode the commas Open-Meteo's list parameters use.
  const params = {
    latitude: locs.map((l) => l.lat).join(','), longitude: locs.map((l) => l.lon).join(','),
    hourly: HOURLY.join(','), start_date: dateKey(hours[0].hour), end_date: dateKey(hours[hours.length - 1].hour), timezone: 'UTC',
  };
  const query = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
  return { url: `${archive ? ARCHIVE_URL : FORECAST_URL}?${query}`, locationIndex, source: archive ? 'archive' : 'forecast' };
}

/** Rows in TripWeather shape. Throws 'incomplete hours' if any hour is missing or has no temperature. */
function parseResponse(json, hours, locationIndex, source) {
  const locs = Array.isArray(json) ? json : [json];   // one location → plain object
  return hours.map((h, i) => {
    const loc = locs[locationIndex[i]];
    const k = loc?.hourly?.time?.indexOf(hourKey(h.hour)) ?? -1;
    if (k < 0 || loc.hourly.temperature_2m[k] == null) throw new Error(`incomplete hours: ${hourKey(h.hour)} not available`);
    const v = (name) => loc.hourly[name][k];
    return {
      hour: h.hour, lat: h.lat, lon: h.lon, elevationM: Math.round(loc.elevation), source,
      temperatureC: v('temperature_2m'), apparentTemperatureC: v('apparent_temperature'), precipitationMm: v('precipitation'),
      humidityPct: v('relative_humidity_2m'), cloudCoverPct: v('cloud_cover'), windKmh: v('wind_speed_10m'),
      windGustKmh: v('wind_gusts_10m'), windDirectionDeg: v('wind_direction_10m'), pressureHpa: v('surface_pressure'),
      weatherCode: v('weather_code'),
    };
  });
}

/**
 * Trip-level summary: WMO codes grow with severity, so max = the worst hour (M3a: not truly
 * "worst" — 80 beats 65 — deferred to slice 5). Only `temperature_2m` is null-checked by
 * `parseResponse`; any other variable can be null for a partial hour, so every mean/max/sum
 * here ignores nulls rather than counting them as 0 — a variable with no non-null values
 * yields null (weatherCode null → weatherText null, not "clear sky").
 */
function summarise(rows) {
  const r1 = (n) => Math.round(n * 10) / 10, r2 = (n) => Math.round(n * 100) / 100;
  const nums = (f) => rows.map((r) => r[f]).filter((v) => v != null);
  const mean = (f) => { const v = nums(f); return v.length ? r1(v.reduce((s, n) => s + n, 0) / v.length) : null; };
  const max = (f) => { const v = nums(f); return v.length ? Math.max(...v) : null; };
  const sum = (f) => { const v = nums(f); return v.length ? r2(v.reduce((s, n) => s + n, 0)) : null; };
  const weatherCode = max('weatherCode');
  return {
    weatherCode, weatherText: weatherCode == null ? null : wmoText(weatherCode),
    temperatureC: mean('temperatureC'), apparentTemperatureC: mean('apparentTemperatureC'),
    precipitationMm: sum('precipitationMm'), windKmh: max('windKmh'),
  };
}

/** Backoff: 5 min × 2^(attempts−1), capped at 6 h; never gives up. */
function isDue(trip, now = new Date()) {
  if (trip.weatherFetchedAt) return false;
  if (!trip.weatherAttemptedAt) return true;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, (trip.weatherAttempts ?? 0) - 1), BACKOFF_MAX_MS);
  return now - trip.weatherAttemptedAt >= wait;
}

const TW_COLS = ['TRIP_ID', 'HOUR', 'LAT', 'LON', 'ELEVATIONM', 'SOURCE', 'TEMPERATUREC', 'APPARENTTEMPERATUREC', 'PRECIPITATIONMM',
  'HUMIDITYPCT', 'CLOUDCOVERPCT', 'WINDKMH', 'WINDGUSTKMH', 'WINDDIRECTIONDEG', 'PRESSUREHPA', 'WEATHERCODE'];
const TW_INSERT = `INSERT INTO GEOTRACK_TRIPWEATHER (${TW_COLS.join(', ')}) VALUES (${TW_COLS.map(() => '?').join(', ')})`;

const summaryText = (s, n) => `${s.temperatureC} °C, ${s.weatherText}, ${s.precipitationMm} mm, wind ${s.windKmh} km/h (${n} h)`;

/**
 * Fetch and store the weather for one closed trip. Never throws: a failure is recorded on the
 * trip row (attempts, attemptedAt, error) and returned as { ok: false, error }.
 */
async function fetchTrip(tripID, { fetch = globalThis.fetch, db = cds.db, now = () => new Date() } = {}) {
  try {
    const [t] = await db.run('SELECT ID, STARTEDAT, ENDEDAT FROM GEOTRACK_TRIPS WHERE ID = ?', [tripID]);
    if (!t) throw new Error('trip not found');
    if (!t.ENDEDAT) throw new Error('trip is open');
    const endedAtIso = utcDate(t.ENDEDAT).toISOString();
    const positions = (await db.run('SELECT TS, LAT, LON FROM GEOTRACK_POSITIONS WHERE TRIP_ID = ? ORDER BY TS', [tripID]))
      .map((p) => ({ ts: utcDate(p.TS), lat: Number(p.LAT), lon: Number(p.LON) }));
    const startedAt = utcDate(t.STARTEDAT);
    const hours = hoursOf({ startedAt, endedAt: utcDate(t.ENDEDAT) }, positions);
    const { url, locationIndex, source } = buildRequest(hours, startedAt, now());
    const res = await fetch(url, { headers: { 'User-Agent': 'geotrack' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
    const rows = parseResponse(await res.json(), hours, locationIndex, source);
    const s = summarise(rows);
    const nowIso = now().toISOString();
    await db.tx(async (tx) => {
      // A resegment can re-close this same deterministic ID with a different ENDEDAT (or delete
      // it) while the HTTP round trip above was in flight. Guard the write on the ENDEDAT read at
      // the start: if it no longer matches, the trip moved on and this fetch is stale — reject it
      // (rolling back before the DELETE/INSERTs run) rather than writing old hours over a trip that
      // enrichMissing would otherwise never retry (WEATHERFETCHEDAT would already be set).
      const n = await tx.run(`UPDATE GEOTRACK_TRIPS SET WEATHERCODE = ?, WEATHERTEXT = ?, TEMPERATUREC = ?, APPARENTTEMPERATUREC = ?, PRECIPITATIONMM = ?, WINDKMH = ?,
          WEATHERFETCHEDAT = ?, WEATHERATTEMPTEDAT = ?, WEATHERATTEMPTS = 0, WEATHERERROR = NULL WHERE ID = ? AND ENDEDAT = ?`,
        [s.weatherCode, s.weatherText, s.temperatureC, s.apparentTemperatureC, s.precipitationMm, s.windKmh, nowIso, nowIso, tripID, endedAtIso]);
      if ((n?.changes ?? n) === 0) throw new Error('trip changed during the fetch');
      await tx.run('DELETE FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ?', [tripID]);
      for (const r of rows) {
        await tx.run(TW_INSERT, [tripID, r.hour.toISOString(), r.lat, r.lon, r.elevationM, r.source, r.temperatureC, r.apparentTemperatureC,
          r.precipitationMm, r.humidityPct, r.cloudCoverPct, r.windKmh, r.windGustKmh, r.windDirectionDeg, r.pressureHpa, r.weatherCode]);
      }
    });
    const text = summaryText(s, rows.length);
    log.info('trip', tripID, source, text);
    return { ok: true, rows, summary: s, text };
  } catch (e) {
    const error = String(e.message ?? e).slice(0, 500);
    log.warn('trip', tripID, 'weather fetch failed:', error);
    try {
      // db.tx always opens its own root transaction, committing as soon as this UPDATE is
      // done. A bare db.run here would join whatever transaction is already open on
      // cds.context — for a sweep-started pass that is cds.spawn's one long-lived transaction
      // for the whole tick, so the row lock would stay held (and the write stay uncommitted)
      // across every remaining trip's Open-Meteo I/O in this pass, not just this one.
      // COALESCE: trip rows written before this slice may carry NULL instead of the default 0.
      await db.tx((tx) => tx.run('UPDATE GEOTRACK_TRIPS SET WEATHERATTEMPTS = COALESCE(WEATHERATTEMPTS, 0) + 1, WEATHERATTEMPTEDAT = ?, WEATHERERROR = ? WHERE ID = ?',
        [now().toISOString(), error, tripID]));
    } catch (e2) { log.error('trip', tripID, 'could not record the weather failure:', e2.message); }
    return { ok: false, error };
  }
}

// One pass at a time: the runner trigger and the 5-minute sweep may fire together.
let inflight = null;
function enrichMissing(opts = {}) {
  if (inflight) return inflight;
  inflight = enrichMissingRaw(opts).finally(() => { inflight = null; });
  return inflight;
}

/** Fetch every closed, not yet enriched trip that is due per the backoff (oldest first, at most `limit`). */
async function enrichMissingRaw({ limit = 20, fetch, db = cds.db, now = () => new Date() } = {}) {
  // smoke fixtures are handled by their own script, never by a live process
  const rows = await db.run(`SELECT ID, WEATHERATTEMPTS, WEATHERATTEMPTEDAT FROM GEOTRACK_TRIPS
    WHERE ENDEDAT IS NOT NULL AND WEATHERFETCHEDAT IS NULL AND DEVICE NOT LIKE 'smoke%' ORDER BY STARTEDAT`);
  const due = rows
    .filter((r) => isDue({ weatherFetchedAt: null, weatherAttempts: r.WEATHERATTEMPTS, weatherAttemptedAt: utcDate(r.WEATHERATTEMPTEDAT) }, now()))
    .slice(0, limit);
  let ok = 0;
  for (const r of due) if ((await fetchTrip(r.ID, { fetch, db, now })).ok) ok++;
  if (due.length) log.info(ok, 'of', due.length, 'due trips enriched');
  return { attempted: due.length, ok };
}

module.exports = { HOURLY, FORECAST_URL, ARCHIVE_URL, hoursOf, buildRequest, parseResponse, summarise, isDue, hourKey, fetchTrip, enrichMissing };
