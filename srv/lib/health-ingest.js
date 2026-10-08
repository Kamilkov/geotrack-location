'use strict';
const cds = require('@sap/cds');
const crypto = require('node:crypto');
// ponytail: the Express @sap/cds brings (no own dependency, per the spec); declare it in package.json if npm ever nests it.
const express = require('express');
const { parseWorkout, coarsenRoute } = require('./health');
const { prepareZones } = require('./geo');
const runner = require('./segment-runner');

const log = cds.log('health');
const ZONES = 'SELECT ID, KIND, RADIUSM, ISPRIVATE, ISBASE, CENTRELAT, CENTRELON, GEOM.ST_AsWKT() AS WKT FROM GEOTRACK_ZONES WHERE GEOM IS NOT NULL';
const SET_POINTS = 'UPDATE GEOTRACK_WORKOUTROUTE SET POINT = NEW ST_POINT(TO_DOUBLE(LON), TO_DOUBLE(LAT), 4326) WHERE WORKOUT_ID = ?';
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
/** A device name as a request may give it; /positions uses the same rule. */
const DEVICE = /^[a-z0-9-]{1,40}$/;
const MAX_ID = 64; // Workouts.ID

/** Bearer token check before the body is read: 503 when no token is configured, 401 when it does not match. */
const auth = (token) => (req, res, next) => {
  if (!token) return res.status(503).json({ error: 'endpoint disabled: HEALTH_TOKEN not set' });
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  // SHA-256 first: timingSafeEqual needs equal lengths, and the digest leaks nothing about the token's length.
  if (!m || !crypto.timingSafeEqual(digest(m[1]), digest(token))) {
    log.warn(`POST ${req.path} rejected: 401`, m ? 'token mismatch' : 'no Bearer header'); // never the header value
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
};

/** One workout, one transaction: upsert the row, replace its heart-rate and route rows (a resend replaces). */
function store(db, workout, heartRate, route) {
  const id = workout.ID;
  return db.tx(async (tx) => {
    await tx.run(UPSERT.into('geotrack.Workouts').entries(workout));
    await tx.run(DELETE.from('geotrack.WorkoutHeartRate').where({ workout_ID: id }));
    await tx.run(DELETE.from('geotrack.WorkoutRoute').where({ workout_ID: id }));
    if (heartRate.length) await tx.run(INSERT.into('geotrack.WorkoutHeartRate').entries(heartRate.map((h) => ({ workout_ID: id, ...h }))));
    if (route.length) {
      await tx.run(INSERT.into('geotrack.WorkoutRoute').entries(route.map((p) => ({ workout_ID: id, ...p }))));
      await tx.run(SET_POINTS, [id]);
    }
  });
}

/** Rebuild length and line of the closed trips a stored workout overlaps (srv/lib/trip-route.js). */
const refreshOverlapping = (device, workout) => runner.refreshRoutes(device, workout.startedAt, workout.endedAt);

async function handle(req, res, db, configured, refresh) {
  const workouts = req.body?.data?.workouts;
  if (!Array.isArray(workouts)) return res.status(400).json({ error: 'body needs data.workouts[]' });
  // Health Auto Export names no device; the owner's app does. A trial device's workouts are stored apart,
  // under their own ID, and touch no trip.
  const named = req.body.device;
  if (named != null && (typeof named !== 'string' || !DEVICE.test(named))) return res.status(400).json({ error: 'device must be 1 to 40 of a-z, 0-9 and -' });
  const device = named ?? configured;
  const trial = runner.isTrial(device);
  let rows;
  try { rows = await db.run(ZONES); } catch (e) {
    log.error('zones unavailable:', e.code ?? e.name);
    return res.status(503).json({ error: 'database unavailable' });
  }
  const zones = prepareZones(rows); // a private zone without a centre throws → 500: nothing is stored uncoarsened
  const out = { workouts: [], skipped: [] };
  for (const [index, w] of workouts.entries()) {
    let p;
    try { p = parseWorkout(w); } catch (e) {
      log.warn('workout', index, 'skipped:', e.message); // parse reasons are fixed texts, no values
      out.skipped.push({ index, reason: e.message });
      continue;
    }
    const sentId = p.workout.ID;
    const storedId = trial ? `${device}:${sentId}` : sentId;
    if (storedId.length > MAX_ID) {
      log.warn('workout', index, 'skipped: id too long with the device prefix');
      out.skipped.push({ index, id: sentId, reason: `id longer than ${MAX_ID} characters with the device prefix` });
      continue;
    }
    const c = coarsenRoute(p.route, zones);
    const workout = {
      ...p.workout, ID: storedId, device, hrSamples: p.heartRate.length, routePoints: c.route.length, routePointsCoarsened: c.coarsened,
      startsInPrivateZone: c.startsInPrivateZone, endsInPrivateZone: c.endsInPrivateZone, receivedAt: new Date().toISOString(),
    };
    try { await store(db, workout, p.heartRate, c.route); } catch (e) {
      // HANA down → 503, the app's next sync resends everything. HANA up → this workout's data is the problem:
      // skip it so it cannot block every later sync. Logged by code only: HANA messages can quote values.
      if (!(await db.run('SELECT 1 FROM DUMMY').then(() => true, () => false))) {
        log.error('database unavailable while storing workout', workout.ID, e.code ?? '');
        return res.status(503).json({ error: 'database unavailable', stored: out.workouts.length });
      }
      log.error('workout', workout.ID, 'not stored:', e.code ?? e.name);
      out.skipped.push({ index, id: sentId, reason: `not stored: ${e.message}` });
      continue;
    }
    // With or without a route: a resend that lost its route puts the trip back on the phone line. A failure
    // here never fails the sync: the workout is stored, the trip keeps its values, the next resend retries.
    if (!trial) {
      try { await refresh(device, workout); } catch (e) { log.error('workout', workout.ID, 'trip routes not refreshed:', e.code ?? e.name); }
    }
    for (const warning of p.warnings) log.warn('workout', workout.ID, warning);
    const privateEnds = [c.startsInPrivateZone && 'starts', c.endsInPrivateZone && 'ends'].filter(Boolean).join(' and ');
    if (privateEnds) log.warn('workout', workout.ID, workout.name, privateEnds, 'inside a private zone');
    log.info('workout', workout.ID, workout.name, 'hr', workout.hrSamples, 'route', workout.routePoints, 'coarsened', c.coarsened);
    out.workouts.push({ id: sentId, name: workout.name, hrSamples: workout.hrSamples, routePoints: workout.routePoints,
      coarsened: c.coarsened, startsInPrivateZone: c.startsInPrivateZone, endsInPrivateZone: c.endsInPrivateZone });
  }
  // The device it was stored under: the app sends nothing until a server names the device it asked for.
  res.json({ device, ...out });
}

/** Body-parser errors (bad JSON 400, too large 413) as JSON; never echoes the body. Four parameters: Express spots error handlers by arity. */
const onError = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) log.error(`POST ${req.path} failed:`, err.message); // HANA errors never get here (caught in the handlers)
  else log.warn(`POST ${req.path} rejected:`, status, err.type ?? '');
  res.status(status).json({ error: err.type ?? 'internal error' });
};

/** Register POST /health/workouts: auth before parsing, then a 20 MB JSON body. */
function mount(app, { token = process.env.HEALTH_TOKEN, device = process.env.HEALTH_DEVICE || 'iphone', db, refresh = refreshOverlapping } = {}) {
  if (!token) log.warn('HEALTH_TOKEN not set: POST /health/workouts answers 503');
  // cds.db connects after bootstrap, so it is looked up per request unless a db was injected (tests).
  // ponytail: 20 MB keeps a body's parse (~5× its size in heap) plus the driver's copy inside the container's 512 MB mem_limit;
  // raise mem_limit before raising this. A workout with a route costs ~1.5 MB per hour, a sync carries yesterday plus today.
  app.post('/health/workouts', auth(token), express.json({ limit: '20mb' }), (req, res) => handle(req, res, db ?? cds.db, device, refresh), onError);
}

module.exports = { mount, auth, onError, ZONES, DEVICE };
