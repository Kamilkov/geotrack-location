'use strict';
const cds = require('@sap/cds');
const { parseRange, parseGroupBy, parseKind, parseNear } = require('./lib/args');
const { localDate, localIso, inRange, sqlBounds, bucketTotals } = require('./lib/periods');
const { pairStays, summarizeStays } = require('./lib/stays');
const { sql } = require('./lib/sql');
const { wmoText } = require('../srv/lib/wmo');
const { utcDate } = require('../srv/lib/time');
const { maskServerError } = require('../srv/lib/trip-read');

const log = cds.log('agent');

// The Mac's timezone: function tools read and write local dates and times.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const num = (v) => (v === null || v === undefined ? null : Number(v)); // HANA returns DECIMAL as strings

/** Every ZoneEvents stay of one zone, all devices except the smoke fixtures, oldest first. */
async function staysOf(req, zoneId, now) {
  const events = await sql(req,
    `SELECT DEVICE, KIND, "AT", VISITSTATUS FROM GEOTRACK_ZONEEVENTS WHERE ZONE_ID = ? AND DEVICE NOT LIKE 'smoke%'`, [zoneId]);
  const byDevice = Map.groupBy(events, (e) => e.DEVICE);
  return [...byDevice.values()]
    .flatMap((evs) => pairStays(evs.map((e) => ({ kind: e.KIND, at: e.AT, visitStatus: e.VISITSTATUS })), now))
    .sort((a, b) => a.arrivedAt - b.arrivedAt);
}

module.exports = class GeoAgentService extends cds.ApplicationService {
  init() {
    this.on('error', (err) => {
      const original = maskServerError(err);
      if (original) log.error(original);
    });

    this.on('totals', async (req) => {
      const range = parseRange(req.data);
      if (range.error) return req.reject(400, range.error);
      const groupBy = parseGroupBy(req.data.groupBy);
      if (groupBy.error) return req.reject(400, groupBy.error);
      const kind = parseKind(req.data.kind);
      if (kind.error) return req.reject(400, kind.error);
      // ponytail: the range's trips are read once and bucketed in JS; move the grouping into SQL at tens of thousands of trips
      const rows = await sql(req,
        `SELECT STARTEDAT, KIND, LENGTHM, DURATIONMIN FROM GEOTRACK_TRIPS
          WHERE ENDEDAT IS NOT NULL AND DEVICE NOT LIKE 'smoke%' AND STARTEDAT >= ? AND STARTEDAT < ?`, sqlBounds(range));
      const trips = rows.map((r) => ({ startedAt: r.STARTEDAT, kind: r.KIND, lengthM: r.LENGTHM, durationMin: r.DURATIONMIN }));
      return bucketTotals(trips, { range, groupBy, kind, tz: TZ });
    });

    this.on('zoneStats', async (req) => {
      const range = parseRange(req.data);
      if (range.error) return req.reject(400, range.error);
      const zones = await sql(req, 'SELECT ID, NAME, CREATESVISIT FROM GEOTRACK_ZONES');
      const wanted = String(req.data.zone ?? '').trim().toLowerCase();
      const zone = zones.find((z) => z.NAME.trim().toLowerCase() === wanted);
      if (!zone) {
        const names = zones.map((z) => z.NAME).sort((a, b) => a.localeCompare(b)).join(', ');
        return req.reject(404, `Zone not found. Known zones: ${names}`);
      }
      const stays = await staysOf(req, zone.ID, new Date());
      return { zone: zone.NAME, createsVisit: !!zone.CREATESVISIT, ...summarizeStays(stays, { range, tz: TZ }) };
    });

    this.on('tripsNear', async (req) => {
      const near = parseNear(req.data);
      if (near.error) return req.reject(400, near.error);
      const range = parseRange(req.data);
      if (range.error) return req.reject(400, range.error);
      const kind = parseKind(req.data.kind);
      if (kind.error) return req.reject(400, kind.error);
      // ponytail: scans every tagged position of the range per call; add a per-trip bounding box at millions of positions
      const rows = await sql(req,
        `SELECT ID, STARTEDAT, ENDEDAT, KIND, LENGTHM, TS, D FROM (
           SELECT T.ID, T.STARTEDAT, T.ENDEDAT, T.KIND, T.LENGTHM, P.TS,
                  P.POINT.ST_Distance(NEW ST_POINT(?, ?, 4326), 'meter') AS D,
                  ROW_NUMBER() OVER (PARTITION BY T.ID ORDER BY P.POINT.ST_Distance(NEW ST_POINT(?, ?, 4326), 'meter'), P.TS) AS RN
             FROM GEOTRACK_POSITIONS P JOIN GEOTRACK_TRIPS T ON T.ID = P.TRIP_ID
            WHERE T.ENDEDAT IS NOT NULL AND T.DEVICE NOT LIKE 'smoke%' AND T.STARTEDAT >= ? AND T.STARTEDAT < ?)
          WHERE RN = 1 AND D <= ? ORDER BY D`,
        [near.lon, near.lat, near.lon, near.lat, ...sqlBounds(range), near.radiusM]);
      return rows
        .filter((r) => inRange(localDate(r.STARTEDAT, TZ), range) && (kind === 'all' || r.KIND === kind))
        .slice(0, 50)
        .map((r) => ({
          ID: r.ID, startedAt: localIso(r.STARTEDAT, TZ), endedAt: localIso(r.ENDEDAT, TZ), kind: r.KIND,
          lengthM: num(r.LENGTHM), closestM: Math.round(Number(r.D) * 10) / 10, closestAt: localIso(r.TS, TZ),
        }));
    });

    this.on('tripDetail', async (req) => {
      const [t] = await sql(req,
        `SELECT V.*, T.DEVICE FROM GEOAGENTSERVICE_TRIPS V JOIN GEOTRACK_TRIPS T ON T.ID = V.ID WHERE V.ID = ?`, [req.data.ID]);
      if (!t) return req.reject(404, 'Trip not found');
      const weather = await sql(req,
        `SELECT "HOUR", WEATHERCODE, TEMPERATUREC, APPARENTTEMPERATUREC, PRECIPITATIONMM, WINDKMH, WINDGUSTKMH, CLOUDCOVERPCT, HUMIDITYPCT
           FROM GEOTRACK_TRIPWEATHER WHERE TRIP_ID = ? ORDER BY "HOUR"`, [t.ID]);
      const workouts = await sql(req,
        `SELECT W.*, WT.OVERLAPS FROM GEOTRACK_WORKOUTTRIPS WT JOIN GEOAGENTSERVICE_WORKOUTS W ON W.ID = WT.WORKOUT_ID
          WHERE WT.TRIP_ID = ? ORDER BY W.STARTEDAT`, [t.ID]);
      // Zone stays that began during the trip, the destination's arrival included; only zones entered
      // during the trip are considered, but their events are read with no upper bound so a stay that
      // outlasts the trip by more than a day still gets its real leftAt instead of "still there".
      const start = utcDate(t.STARTEDAT), end = t.ENDEDAT ? utcDate(t.ENDEDAT) : new Date();
      const events = await sql(req,
        `SELECT E.ZONE_ID, Z.NAME, E.KIND, E."AT", E.VISITSTATUS FROM GEOTRACK_ZONEEVENTS E JOIN GEOTRACK_ZONES Z ON Z.ID = E.ZONE_ID
          WHERE E.DEVICE = ? AND E."AT" >= ?
            AND E.ZONE_ID IN (SELECT ZONE_ID FROM GEOTRACK_ZONEEVENTS
                                WHERE DEVICE = ? AND KIND = 'enter' AND "AT" >= ? AND "AT" <= ?)`,
        [t.DEVICE, start.toISOString(), t.DEVICE, start.toISOString(), end.toISOString()]);
      const zoneStays = [...Map.groupBy(events, (e) => e.ZONE_ID).values()]
        .flatMap((evs) => pairStays(evs.map((e) => ({ kind: e.KIND, at: e.AT, visitStatus: e.VISITSTATUS })))
          .map((s) => ({ ...s, zone: evs[0].NAME })))
        .filter((s) => s.arrivedAt >= start && s.arrivedAt <= end)
        .sort((a, b) => a.arrivedAt - b.arrivedAt)
        .map((s) => ({ zone: s.zone, arrivedAt: localIso(s.arrivedAt, TZ), leftAt: localIso(s.leftAt, TZ), status: s.status }));
      return {
        ID: t.ID, startedAt: localIso(t.STARTEDAT, TZ), endedAt: localIso(t.ENDEDAT, TZ), kind: t.KIND,
        lengthM: num(t.LENGTHM), lengthSource: t.LENGTHSOURCE, durationMin: num(t.DURATIONMIN), startZone: t.STARTZONE, endZone: t.ENDZONE,
        weatherText: t.WEATHERTEXT, temperatureC: num(t.TEMPERATUREC), apparentTemperatureC: num(t.APPARENTTEMPERATUREC),
        precipitationMm: num(t.PRECIPITATIONMM), windKmh: num(t.WINDKMH),
        weather: weather.map((w) => ({
          hour: localIso(w.HOUR, TZ), weatherText: w.WEATHERCODE == null ? null : wmoText(w.WEATHERCODE),
          temperatureC: num(w.TEMPERATUREC), apparentTemperatureC: num(w.APPARENTTEMPERATUREC), precipitationMm: num(w.PRECIPITATIONMM),
          windKmh: num(w.WINDKMH), windGustKmh: num(w.WINDGUSTKMH), cloudCoverPct: num(w.CLOUDCOVERPCT), humidityPct: num(w.HUMIDITYPCT),
        })),
        workouts: workouts.map((w) => ({
          name: w.NAME, startedAt: localIso(w.STARTEDAT, TZ), endedAt: localIso(w.ENDEDAT, TZ), durationMin: num(w.DURATIONMIN),
          distanceM: num(w.DISTANCEM), activeEnergyKcal: num(w.ACTIVEENERGYKCAL), elevationUpM: num(w.ELEVATIONUPM), steps: num(w.STEPS),
          hrMin: num(w.HRMIN), hrAvg: num(w.HRAVG), hrMax: num(w.HRMAX), temperatureC: num(w.TEMPERATUREC), humidityPct: num(w.HUMIDITYPCT),
          overlapMin: Math.round(Number(w.OVERLAPS) / 60),
        })),
        zoneStays,
      };
    });

    return super.init();
  }
};
