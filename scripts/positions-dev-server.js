'use strict';
// A local stand-in for the iOS Simulator: the real POST /positions, POST /health/workouts and POST /photos routes
// over an in-memory store. No HANA, nothing is segmented, nothing survives the process. One private zone at
// 42.50/1.50 (r 100 m). A photo without GPS always finds a position to borrow, outside that zone.
// Run: node scripts/positions-dev-server.js [--hold-positions <seconds>] [--hold-workouts <seconds>] [--hold-photos <seconds>]   → http://localhost:4010, token "dev-token"
// On the VPS it is the App Store reviewer's demo server (deploy/docker-compose.snippet.yml): DEV_SERVER_TOKEN replaces
// "dev-token", HOST=0.0.0.0 lets Caddy reach it, PORT moves it, and MAX_STORED (default 10000) bounds the memory: beyond
// it the oldest positions are forgotten, so a resend of one of them is stored again.
const express = require('express');
const { mount } = require('../srv/lib/positions-ingest');
const health = require('../srv/lib/health-ingest');
const photos = require('../srv/lib/photos-ingest');
const { circleToWkt } = require('../srv/lib/geo');

const PORT = Number(process.env.PORT ?? 4010), HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.DEV_SERVER_TOKEN || 'dev-token', MAX_STORED = Number(process.env.MAX_STORED ?? 10000);
const zones = [{ ID: 'dev-home', KIND: 'circle', RADIUSM: 100, ISPRIVATE: true, ISBASE: true, CENTRELAT: '42.500000', CENTRELON: '1.500000', WKT: Buffer.from(circleToWkt(42.5, 1.5, 100)) }];
const stored = new Map();
const db = {
  run: async (sql, p) => {
    if (/FROM GEOTRACK_ZONES/.test(sql)) return zones;
    // A photo without GPS: the live device's nearest position, here always one outside the private zone at the photo's time.
    if (/TOP 1 TS, LAT, LON, ISCOARSENED FROM GEOTRACK_POSITIONS/.test(sql)) return [{ TS: p[3], LAT: '42.530000', LON: '1.540000', ISCOARSENED: false }];
    if (/^\s*INSERT INTO GEOTRACK_POSITIONS/.test(sql)) {
      const key = `${p[0]}|${p[1]}`;
      if (stored.has(key)) throw Object.assign(new Error('duplicate'), { code: 301 });
      stored.set(key, p);
      if (stored.size > MAX_STORED) stored.delete(stored.keys().next().value); // the oldest goes (a Map keeps insertion order)
      console.log(`stored ${p[0]} (${stored.size} in all)${p[20] ? " at the private zone's centre" : ''}${p[17] === 'c' ? ', the wake-up fix after Home sleep' : ''}`); // never a place or a time
      return { changes: 1 };
    }
    return [{ 1: 1 }];
  },
  // A workout's transaction: only the Workouts row is looked at, its series are counted on it.
  tx: (fn) => fn({
    run: async (q) => {
      const w = q.UPSERT?.entries[0];
      if (w) console.log(`stored workout ${w.ID} (${w.device}) ${w.name}: ${w.hrSamples} heart rate samples, ${w.routePoints} route points, ${w.routePointsCoarsened} at the private zone's centre`);
      return { changes: 1 };
    },
  }),
};

// --hold-photos <seconds>: a photo is handled at once, its answer waits that long. For trying a round that
// iOS interrupts: the server has the photo, the phone has no answer yet. --hold-workouts and --hold-positions
// do the same for every answer of their route.
const seconds = (name) => {
  const flag = process.argv.indexOf(name);
  if (flag < 0) return 0;
  const value = process.argv[flag + 1];
  return value?.trim() ? Number(value) : NaN; // "" is no number, and Number("") would say 0
};
const MAX_S = (2 ** 31 - 1) / 1000; // setTimeout's limit: beyond it, and for Infinity, the answer would not be held at all
const hold = seconds('--hold-photos'), holdWorkouts = seconds('--hold-workouts'), holdPositions = seconds('--hold-positions');
if ([hold, holdWorkouts, holdPositions].some((s) => !(s >= 0 && s <= MAX_S)) || !Number.isInteger(PORT) || PORT < 0 || !(MAX_STORED >= 1)) {
  console.error('usage: node scripts/positions-dev-server.js [--hold-positions <seconds>] [--hold-workouts <seconds>] [--hold-photos <seconds>]'
    + '\n       environment: DEV_SERVER_TOKEN, HOST (default 127.0.0.1), PORT (a whole number, default 4010), MAX_STORED (at least 1, default 10000)');
  process.exit(2);
}
/** Holds every answer of the route it is put before. */
const holding = (what, s) => (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (a) => {
    console.log(`${what}: an answer is held ${s} s`);
    setTimeout(() => json(a), s * 1000);
    return res;
  };
  next();
};

const app = express();
if (holdPositions) app.use('/positions', holding('positions', holdPositions));
mount(app, { token: TOKEN, db, schedule: () => false });
if (holdWorkouts) app.use('/health/workouts', holding('workouts', holdWorkouts));
health.mount(app, { token: TOKEN, device: 'smoke-sim', db, refresh: async () => {} });
// One line per photo, written when the route answers: what came and what the answer is. Never a place or a time.
app.use('/photos', (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (a) => {
    if (!a?.id) return json(a); // a refusal (401, 400, 5xx) handled nothing: it comes back at once
    const bytes = Buffer.from(req.body.thumbnail, 'base64').length;
    console.log(`photo ${a.id} ${req.body.fileName}: ${req.body.lat == null ? 'no GPS' : 'GPS came'}, thumbnail ${bytes} bytes, `
      + `${a.status}${a.reason ? ` (${a.reason})` : ''}${a.positionSource === 'owntracks' ? ' by a borrowed position' : ''}`);
    if (!hold) return json(a);
    setTimeout(() => json(a), hold * 1000);
    return res;
  };
  next();
});
photos.mount(app, { token: TOKEN, device: 'smoke-sim', db });
// The configured token is never printed: on the VPS the log is read by others than the one who set it.
const server = app.listen(PORT, HOST, () => console.log(`POST http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${server.address().port}/positions, /health/workouts and /photos with the token `
  + `${process.env.DEV_SERVER_TOKEN ? 'from DEV_SERVER_TOKEN' : TOKEN}${hold ? `; photos are held ${hold} s` : ''}${holdWorkouts ? `; workouts are held ${holdWorkouts} s` : ''}`));
