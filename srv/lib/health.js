'use strict';
const { zoneOf } = require('./geo');

/** "2024-02-06 14:30:00 -0800" (Health Auto Export) or ISO with Z/offset → Date; anything without an offset → null. */
function parseTime(s) {
  const m = typeof s === 'string' && /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?) ?(Z|[+-]\d\d:?\d\d)$/.exec(s.trim());
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] === 'Z' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(-2)}`}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const qty = (o) => num(o?.qty);

// Factors to the stored unit. A unit not listed stores null and adds a warning: never a wrong number.
const TO_M = { m: 1, km: 1000, mi: 1609.344, ft: 0.3048, yd: 0.9144 };
const TO_KCAL = { kcal: 1, Cal: 1, kJ: 1 / 4.184 };
const TO_C = { degC: (v) => v, '°C': (v) => v, degF: (v) => ((v - 32) * 5) / 9, '°F': (v) => ((v - 32) * 5) / 9 };
function convert(field, o, table, warnings) {
  const v = qty(o);
  if (v == null) return null;
  const f = table[o.units];
  if (f == null) { warnings.push(`${field}: unit "${o.units}" not understood, not stored`); return null; }
  return typeof f === 'function' ? f(v) : v * f;
}

const HR_UNITS = new Set(['bpm', 'count/min']);
/** heartRateData / heartRateRecovery → rows; bad dates and repeated timestamps dropped (first wins). */
function heartRateOf(entries, phase, warnings) {
  const rows = new Map();
  let dropped = 0, units = null;
  for (const e of Array.isArray(entries) ? entries : []) {
    const ts = parseTime(e?.date), avg = num(e?.Avg ?? e?.qty);
    if (!ts || avg == null || rows.has(ts.getTime())) { dropped++; continue; }
    if (e.units != null && !HR_UNITS.has(e.units)) units = e.units;
    rows.set(ts.getTime(), {
      phase, ts: ts.toISOString(), bpmMin: round(num(e.Min ?? e.qty), 1), bpmAvg: round(avg, 1), bpmMax: round(num(e.Max ?? e.qty), 1),
      source: e.source == null ? null : String(e.source).slice(0, 60),
    });
  }
  if (dropped) warnings.push(`${phase} heart rate: ${dropped} samples dropped (bad or repeated date, no value)`);
  if (units) warnings.push(`${phase} heart rate: units "${units}", stored as sent`);
  return [...rows.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

/** route → rows sorted by time; CoreLocation's negative "invalid" markers become null (or drop the point). */
function routeOf(points, warnings) {
  const rows = new Map();
  let dropped = 0;
  for (const p of Array.isArray(points) ? points : []) {
    const ts = parseTime(p?.timestamp), lat = num(p?.latitude), lon = num(p?.longitude), hAcc = num(p?.horizontalAccuracy);
    if (!ts || lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (hAcc != null && hAcc < 0) || rows.has(ts.getTime())) { dropped++; continue; }
    const vAcc = num(p.verticalAccuracy), speed = num(p.speed), course = num(p.course);
    rows.set(ts.getTime(), {
      ts: ts.toISOString(), lat: round(lat, 6), lon: round(lon, 6),
      altitudeM: vAcc != null && vAcc < 0 ? null : round(num(p.altitude), 1),
      speedMs: speed != null && speed >= 0 ? round(speed, 2) : null,
      courseDeg: course != null && course >= 0 ? Math.round(course) % 360 : null,
      horizontalAccuracyM: round(hAcc, 1), verticalAccuracyM: vAcc != null && vAcc >= 0 ? round(vAcc, 1) : null,
    });
  }
  if (dropped) warnings.push(`route: ${dropped} points dropped (bad or repeated timestamp, bad coordinates)`);
  return [...rows.values()].sort((a, b) => (a.ts < b.ts ? -1 : 1));
}

// raw keeps the workout's summary fields only: no time series (arrays of {date|timestamp, …} — route, heart rate,
// steps, energy …) and no coordinate keys at any depth, whatever shape a future payload has.
const COORD = /^(lat|lon|latitude|longitude)$/i;
const isSeries = (v) => Array.isArray(v) && v.some((e) => e && typeof e === 'object' && ('date' in e || 'timestamp' in e));
/**
 * One Version 2 workout → { workout, heartRate, route, warnings }. Every Workouts element is set
 * (null when absent), so an UPSERT of a resend clears what the new version no longer has.
 * Throws when id, start or end is unusable; the caller skips that workout.
 */
function parseWorkout(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw new Error('not an object');
  const id = w.id == null ? '' : String(w.id);
  if (!id) throw new Error('missing id');
  if (id.length > 64) throw new Error('id longer than 64 characters');
  const startedAt = parseTime(w.start), endedAt = parseTime(w.end);
  if (!startedAt) throw new Error('missing or unreadable start');
  if (!endedAt) throw new Error('missing or unreadable end');
  const warnings = [];
  const steps = Array.isArray(w.stepCount) ? w.stepCount.reduce((s, e) => s + (num(e?.qty) ?? 0), 0) : null;
  const workout = {
    ID: id, name: w.name == null ? null : String(w.name).slice(0, 60),
    startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
    durationS: Math.round(num(w.duration) ?? (endedAt - startedAt) / 1000),
    distanceM: round(convert('distance', w.distance, TO_M, warnings)),
    activeEnergyKcal: round(convert('activeEnergyBurned', w.activeEnergyBurned, TO_KCAL, warnings), 1),
    elevationUpM: round(convert('elevationUp', w.elevationUp, TO_M, warnings), 1),
    steps: steps == null ? null : Math.round(steps),
    hrMin: round(qty(w.heartRate?.min)), hrAvg: round(qty(w.heartRate?.avg) ?? qty(w.avgHeartRate)), hrMax: round(qty(w.heartRate?.max) ?? qty(w.maxHeartRate)),
    temperatureC: round(convert('temperature', w.temperature, TO_C, warnings), 1),
    humidityPct: round(qty(w.humidity)),
    isIndoor: typeof w.isIndoor === 'boolean' ? w.isIndoor : null,
    raw: JSON.stringify(w, (k, v) => (k !== '' && (COORD.test(k) || isSeries(v)) ? undefined : v)),
  };
  const heartRate = [...heartRateOf(w.heartRateData, 'workout', warnings), ...heartRateOf(w.heartRateRecovery, 'recovery', warnings)];
  const route = routeOf(w.route, warnings);
  if (!route.length && w.isIndoor !== true) warnings.push('route: no points (outdoor workout without a route, or route data under an unknown key)');
  return { workout, heartRate, route, warnings };
}

/**
 * Zone-tag every route point. A point in a private zone becomes the zone centre with altitude,
 * speed and course cleared: its real position never leaves this function.
 */
function coarsenRoute(route, zones) {
  const out = route.map((p) => {
    const z = zoneOf(p.lat, p.lon, zones);
    if (!z?.isPrivate) return { ...p, zone_ID: z?.ID ?? null, isCoarsened: false };
    return { ...p, lat: z.centreLat, lon: z.centreLon, altitudeM: null, speedMs: null, courseDeg: null, zone_ID: z.ID, isCoarsened: true };
  });
  return {
    route: out, coarsened: out.filter((p) => p.isCoarsened).length,
    startsInPrivateZone: !!out[0]?.isCoarsened, endsInPrivateZone: !!out.at(-1)?.isCoarsened,
  };
}

module.exports = { parseTime, parseWorkout, coarsenRoute };
