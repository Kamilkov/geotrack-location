'use strict';
// Argument validation for the GeoAgentService functions. Each parser returns a value or { error }
// with the fixed message the client sees (spec: Errors).

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const blank = (v) => v === undefined || v === null || v === '';

/** A real calendar date 'YYYY-MM-DD', or null. */
function day(v) {
  if (typeof v !== 'string' || !DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
}

/** from/to as inclusive local dates: { from, to } (both null = unbounded) or { error }. */
function parseRange({ from, to }) {
  if (blank(from) && blank(to)) return { from: null, to: null };
  if (blank(from) || blank(to)) return { error: 'from and to go together' };
  if (!day(from)) return { error: 'from must be YYYY-MM-DD' };
  if (!day(to)) return { error: 'to must be YYYY-MM-DD' };
  if (from > to) return { error: 'from must not be after to' };
  return { from, to };
}

const GROUPS = ['day', 'week', 'month', 'year', 'all'];
function parseGroupBy(v) {
  if (blank(v)) return 'month';
  return GROUPS.includes(v) ? v : { error: 'groupBy must be day, week, month, year or all' };
}

const KINDS = ['walk', 'drive', 'all'];
function parseKind(v) {
  if (blank(v)) return 'all';
  return KINDS.includes(v) ? v : { error: 'kind must be walk, drive or all' };
}

/** lat/lon/radiusM for tripsNear: { lat, lon, radiusM } or { error }. */
function parseNear({ lat, lon, radiusM }) {
  const la = Number(lat), lo = Number(lon);
  if (blank(lat) || !Number.isFinite(la) || la < -90 || la > 90) return { error: 'lat must be between -90 and 90' };
  if (blank(lon) || !Number.isFinite(lo) || lo < -180 || lo > 180) return { error: 'lon must be between -180 and 180' };
  const r = blank(radiusM) ? 500 : Number(radiusM);
  if (!Number.isInteger(r) || r < 1 || r > 50000) return { error: 'radiusM must be 1..50000' };
  return { lat: la, lon: lo, radiusM: r };
}

module.exports = { parseRange, parseGroupBy, parseKind, parseNear };
