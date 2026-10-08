'use strict';
const { utcDate } = require('../../srv/lib/time');

const fmtCache = new Map();
function parts(d, tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset' });
    fmtCache.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
}
/** Local calendar date 'YYYY-MM-DD' of an instant in tz. */
function localDate(v, tz) {
  const p = parts(utcDate(v), tz);
  return `${p.year}-${p.month}-${p.day}`;
}
/** Local ISO timestamp with offset, e.g. '2026-09-25T18:17:49+02:00'; null stays null. */
function localIso(v, tz) {
  if (v == null) return null;
  const p = parts(utcDate(v), tz);
  const off = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${off}`;
}
/** ISO week 'YYYY-Www' of a 'YYYY-MM-DD' calendar date. */
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); // the Thursday of this ISO week decides its year
  const year = d.getUTCFullYear();
  const week = 1 + Math.floor((d - Date.UTC(year, 0, 1)) / 604800000);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
/** Period label of a local date: 'YYYY-MM-DD', 'YYYY-Www', 'YYYY-MM', 'YYYY' or 'all'. */
function periodOf(day, groupBy) {
  if (groupBy === 'day') return day;
  if (groupBy === 'week') return isoWeek(day);
  if (groupBy === 'month') return day.slice(0, 7);
  if (groupBy === 'year') return day.slice(0, 4);
  return 'all';
}

/** True when a local date lies in the inclusive range; an unbounded range contains every date. */
const inRange = (day, { from, to }) => from === null || (day >= from && day <= to);

/**
 * UTC bounds for SQL that surely contain every instant of the local range: a day earlier and two
 * days later than the dates themselves (no timezone is more than 14 h from UTC). Callers filter
 * the rows exactly with inRange(localDate(...)) afterwards.
 */
function sqlBounds({ from, to }) {
  if (from === null) return ['1970-01-01T00:00:00Z', '2100-01-01T00:00:00Z'];
  const shift = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString();
  return [shift(from, -1), shift(to, 2)];
}

const KIND_ORDER = ['walk', 'drive', 'unknown', 'all'];

/**
 * Trips → rows { period, kind, trips, distanceM, durationMin } sorted by period, then kind.
 * trips: [{ startedAt, kind, lengthM, durationMin }] (closed, non-smoke); the local start date
 * decides range and period. kind 'all' adds one summed 'all' row per period next to the per-kind
 * rows; 'walk' or 'drive' keeps only that kind.
 */
function bucketTotals(trips, { range, groupBy, kind, tz }) {
  const rows = new Map();
  const add = (period, k, t) => {
    const key = `${period}|${k}`;
    const r = rows.get(key) ?? rows.set(key, { period, kind: k, trips: 0, distanceM: 0, durationMin: 0 }).get(key);
    r.trips += 1;
    r.distanceM += Number(t.lengthM ?? 0);
    r.durationMin += Number(t.durationMin ?? 0);
  };
  for (const t of trips) {
    const day = localDate(t.startedAt, tz);
    const k = t.kind === 'walk' || t.kind === 'drive' ? t.kind : 'unknown';
    if (!inRange(day, range) || (kind !== 'all' && k !== kind)) continue;
    const period = periodOf(day, groupBy);
    add(period, k, t);
    if (kind === 'all') add(period, 'all', t);
  }
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

module.exports = { localDate, localIso, isoWeek, periodOf, inRange, sqlBounds, bucketTotals };
