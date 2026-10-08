'use strict';
const { haversineM } = require('./geo');
const { utcDate } = require('./time');

// Processing choices, not per-user settings, so they live here and not in Settings.
const COVER_MS = 30000; // a phone point this close in time to a Watch point is dropped
const MAP_STEP_M = 5;   // the map line keeps a point only this far from the last kept one

const WATCH = `SELECT R.TS, R.LAT, R.LON FROM GEOTRACK_WORKOUTROUTE R JOIN GEOTRACK_WORKOUTS W ON W.ID = R.WORKOUT_ID
  WHERE W.DEVICE = ? AND R.TS >= ? AND R.TS <= ? AND (R.HORIZONTALACCURACYM IS NULL OR R.HORIZONTALACCURACYM <= ?) ORDER BY R.TS`;
// The trip's own positions. The one at the trip's end is named on its own: when the next trip starts
// at that position, its row is retagged to the next trip after this one closed.
const OWN = 'TRIP_ID = ? OR (DEVICE = ? AND TS = ?)';
const PHONE_POINTS = `SELECT TS, LAT, LON FROM GEOTRACK_POSITIONS WHERE ${OWN} ORDER BY TS`;
// The expressions persistTrip used before this module existed: a phone-only trip keeps its values.
const PHONE_LINE = `SELECT
  (SELECT ROUND(SUM(D)) FROM (SELECT POINT.ST_Distance(LAG(POINT) OVER (ORDER BY TS), 'meter') D FROM GEOTRACK_POSITIONS WHERE ${OWN})) L,
  (SELECT 'LINESTRING(' || STRING_AGG(LON || ' ' || LAT, ', ' ORDER BY TS) || ')' FROM GEOTRACK_POSITIONS WHERE ${OWN}) W
  FROM DUMMY`;

// wkt keeps the coordinate text as stored, so the line is written without reformatting numbers.
const point = (r) => ({ t: utcDate(r.TS).getTime(), lat: Number(r.LAT), lon: Number(r.LON), wkt: `${r.LON} ${r.LAT}` });

/** Length of a line of { lat, lon } in metres, unrounded. */
const lengthM = (points) => points.reduce((sum, p, i) => (i ? sum + haversineM(points[i - 1], p) : 0), 0);

/**
 * One line from both sources. A phone point with a Watch point within coverMs of it is dropped; the rest
 * is ordered by time. Both lists are sorted by t (ms). source: phone | watch | mixed.
 */
function stitch(phone, watch, coverMs = COVER_MS) {
  if (!watch.length) return { points: phone, source: 'phone' };
  let i = 0;
  const kept = phone.filter((p) => {
    while (i + 1 < watch.length && watch[i + 1].t <= p.t) i++; // the last Watch point at or before p
    const before = Math.abs(p.t - watch[i].t), after = i + 1 < watch.length ? watch[i + 1].t - p.t : Infinity;
    return Math.min(before, after) > coverMs;
  });
  return { points: [...kept, ...watch].sort((a, b) => a.t - b.t), source: kept.length ? 'mixed' : 'watch' };
}

/** The line for the map: the first point, every point at least minStepM from the last kept one, and the line's end. */
function thin(points, minStepM = MAP_STEP_M) {
  if (!points.length) return [];
  const out = [points[0]];
  for (const p of points) if (haversineM(out[out.length - 1], p) >= minStepM) out.push(p);
  const end = points[points.length - 1], kept = out[out.length - 1];
  if (end.lat !== kept.lat || end.lon !== kept.lon) out.push(end);
  return out;
}

/**
 * What a closed trip's length and line should be, or null when there is nothing to write: the trip is
 * open or gone, or it is a phone trip outside its close, whose stored values are already these.
 */
async function computeTripRoute(tx, tripId, settings, { atClose = false } = {}) {
  const [trip] = await tx.run('SELECT DEVICE, STARTEDAT, ENDEDAT, POINTCOUNT, LENGTHSOURCE FROM GEOTRACK_TRIPS WHERE ID = ?', [tripId]);
  if (!trip?.ENDEDAT) return null;
  const from = utcDate(trip.STARTEDAT).toISOString(), to = utcDate(trip.ENDEDAT).toISOString();
  const own = [tripId, trip.DEVICE, to];
  const watch = (await tx.run(WATCH, [trip.DEVICE, from, to, settings.maxAccuracyM])).map(point);
  if (!watch.length) {
    if (!atClose && (trip.LENGTHSOURCE ?? 'phone') === 'phone') return null;
    const [line] = await tx.run(PHONE_LINE, [...own, ...own]);
    return { lengthSource: 'phone', lengthM: line.L == null ? null : Number(line.L), routeWkt: line.W == null ? null : String(line.W), points: trip.POINTCOUNT ?? 0 };
  }
  const line = stitch((await tx.run(PHONE_POINTS, own)).map(point), watch);
  const drawn = thin(line.points);
  return { lengthSource: line.source, lengthM: Math.round(lengthM(line.points)), routeWkt: `LINESTRING(${drawn.map((p) => p.wkt).join(', ')})`, points: drawn.length };
}

/** Compute and store LENGTHM, ROUTEWKT, ROUTE and LENGTHSOURCE of one trip. Returns what it wrote, or null. */
async function refreshTripRoute(tx, tripId, settings, opts) {
  const r = await computeTripRoute(tx, tripId, settings, opts);
  if (!r) return null;
  await tx.run('UPDATE GEOTRACK_TRIPS SET LENGTHM = ?, ROUTEWKT = ?, LENGTHSOURCE = ?, ROUTE = NULL WHERE ID = ?', [r.lengthM, r.routeWkt, r.lengthSource, tripId]);
  if (r.points >= 2) await tx.run('UPDATE GEOTRACK_TRIPS SET ROUTE = ST_GeomFromText(ROUTEWKT, 4326) WHERE ID = ?', [tripId]);
  return r;
}

module.exports = { stitch, thin, lengthM, computeTripRoute, refreshTripRoute, COVER_MS, MAP_STEP_M };
