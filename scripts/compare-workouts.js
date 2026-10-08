'use strict';
// Read-only comparison of the workouts of two devices: what Health Auto Export stored for one, and what the
// owner's app stored for its trial twin (<trial device>:<id>). It writes nothing. Its output holds real times:
// keep it on your Mac.
// Run: npx cds bind --exec -- node scripts/compare-workouts.js --a iphone --b trial-iphone --from 2026-09-22T00:00:00Z
const { haversineM } = require('../srv/lib/geo');

const SECOND_MS = 1000;
const EPS = 1e-9; // 1.35 - 1.3 is a hair over 0.05 in floating point
const empty = (v) => v == null;
/** Both empty, or both there and at most `tolerance` apart. An empty value never matches a value. */
const near = (a, b, tolerance) => (empty(a) || empty(b) ? empty(a) && empty(b) : Math.abs(a - b) <= tolerance + EPS);
/** As `near`, with the tolerance the larger of `unit` and `percent` of the larger value. */
const nearPct = (a, b, unit, percent = 1) => (empty(a) || empty(b) ? empty(a) && empty(b) : Math.abs(a - b) <= Math.max(unit, (percent / 100) * Math.max(Math.abs(a), Math.abs(b))) + EPS);
const same = (a, b) => (empty(a) || empty(b) ? empty(a) && empty(b) : a === b);
/** Degrees on a circle: 359 and 0 are 1 apart. */
const nearDeg = (a, b, tolerance) => (empty(a) || empty(b) ? empty(a) && empty(b) : Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) <= tolerance + EPS);

const failed = (checks) => Object.keys(checks).filter((k) => !checks[k]);

/** The summary fields that differ. a: Health Auto Export's workout, b: the app's. */
function summaryDiff(a, b) {
  return failed({
    name: same(a.name, b.name), isIndoor: same(a.isIndoor, b.isIndoor),
    startedAt: near(a.startedAt?.getTime(), b.startedAt?.getTime(), SECOND_MS), endedAt: near(a.endedAt?.getTime(), b.endedAt?.getTime(), SECOND_MS),
    durationS: near(a.durationS, b.durationS, 1),
    distanceM: nearPct(a.distanceM, b.distanceM, 1), elevationUpM: nearPct(a.elevationUpM, b.elevationUpM, 1),
    activeEnergyKcal: nearPct(a.activeEnergyKcal, b.activeEnergyKcal, 1), steps: nearPct(a.steps, b.steps, 1),
    hrMin: near(a.hrMin, b.hrMin, 1), hrAvg: near(a.hrAvg, b.hrAvg, 1), hrMax: near(a.hrMax, b.hrMax, 1),
    temperatureC: near(a.temperatureC, b.temperatureC, 0.5), humidityPct: near(a.humidityPct, b.humidityPct, 1),
  });
}

/** The fields in which two heart rate rows differ: the phase and the source, minimum, average and maximum beyond 0.1. */
const rateDiff = (a, b) => failed({ phase: a.phase === b.phase, source: same(a.source, b.source),
  bpmMin: near(a.bpmMin, b.bpmMin, 0.1), bpmAvg: near(a.bpmAvg, b.bpmAvg, 0.1), bpmMax: near(a.bpmMax, b.bpmMax, 0.1) });
const sameRate = (a, b) => !rateDiff(a, b).length;

/** The fields in which two route points differ. A coarsened point matches only a coarsened point of the same zone. */
const pointDiff = (a, b) => failed({ isCoarsened: !!a.isCoarsened === !!b.isCoarsened, zone_ID: same(a.zone_ID, b.zone_ID), place: haversineM(a, b) <= 1,
  altitudeM: near(a.altitudeM, b.altitudeM, 1), speedMs: near(a.speedMs, b.speedMs, 0.05), courseDeg: nearDeg(a.courseDeg, b.courseDeg, 1),
  horizontalAccuracyM: near(a.horizontalAccuracyM, b.horizontalAccuracyM, 0.5), verticalAccuracyM: near(a.verticalAccuracyM, b.verticalAccuracyM, 0.5) });
const samePoint = (a, b) => !pointDiff(a, b).length;

/**
 * One to one and in order. Each row of `base` takes the earliest row of `mine` that is at most 1 s away, not yet
 * taken, and agrees with it. A row without such a partner is `different` when an untaken row lies within 1 s
 * (the nearest is named), else `missing`. `extra`: rows of `mine` that no row of `base` took.
 * Both lists ascending by ts (Date).
 */
function pairRows(base, mine, agree) {
  const taken = new Set();
  const out = { matched: 0, different: [], missing: [], extra: 0 };
  let from = 0;
  for (const row of base) {
    const t = row.ts.getTime();
    while (from < mine.length && mine[from].ts.getTime() < t - SECOND_MS) from++;
    let partner = -1, nearest = -1;
    for (let i = from; i < mine.length && mine[i].ts.getTime() <= t + SECOND_MS; i++) {
      if (taken.has(i)) continue;
      if (nearest < 0 || Math.abs(mine[i].ts - t) < Math.abs(mine[nearest].ts - t)) nearest = i;
      if (agree(row, mine[i])) { partner = i; break; }
    }
    if (partner >= 0) { taken.add(partner); out.matched++; }
    else if (nearest >= 0) out.different.push({ base: row, nearest: mine[nearest] });
    else out.missing.push(row);
  }
  out.extra = mine.length - taken.size;
  return out;
}

/** One workout against its twin. a, b: { workout, heartRate, route }. */
function compareWorkout(a, b) {
  const summary = summaryDiff(a.workout, b.workout);
  const heartRate = pairRows(a.heartRate, b.heartRate, sameRate);
  const route = pairRows(a.route, b.route, samePoint);
  const clean = (p) => !p.different.length && !p.missing.length;
  return { ok: !summary.length && clean(heartRate) && clean(route), summary, heartRate, route };
}

/** A UTC instant from the command line: a string that ends in Z or an offset. Anything else is an invalid Date. */
const instant = (v) => new Date(typeof v === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(v) ? v : NaN);

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const a = arg('a'), b = arg('b'), from = instant(arg('from'));
  if (!a || !b || isNaN(from)) {
    console.error('usage: compare-workouts.js --a <device> --b <trial device> --from <UTC instant, e.g. 2026-09-22T00:00:00Z>');
    process.exit(2);
  }
  const cds = require('@sap/cds');
  const { utcDate } = require('../srv/lib/time');
  await cds.connect.to('db');
  const q = (sql, p) => cds.db.run(sql, p);
  const n = (v) => (v == null ? null : Number(v));
  const b01 = (v) => (v == null ? null : v === true || v === 1);
  const workoutsOf = async (device) => (await q(`SELECT ID, NAME, STARTEDAT, ENDEDAT, DURATIONS, DISTANCEM, ACTIVEENERGYKCAL, ELEVATIONUPM, STEPS, HRMIN, HRAVG, HRMAX,
    TEMPERATUREC, HUMIDITYPCT, ISINDOOR FROM GEOTRACK_WORKOUTS WHERE DEVICE = ? AND STARTEDAT >= ? ORDER BY STARTEDAT`, [device, from.toISOString()])).map((r) => ({
    ID: r.ID, name: r.NAME, startedAt: utcDate(r.STARTEDAT), endedAt: utcDate(r.ENDEDAT), durationS: n(r.DURATIONS), distanceM: n(r.DISTANCEM),
    activeEnergyKcal: n(r.ACTIVEENERGYKCAL), elevationUpM: n(r.ELEVATIONUPM), steps: n(r.STEPS), hrMin: n(r.HRMIN), hrAvg: n(r.HRAVG), hrMax: n(r.HRMAX),
    temperatureC: n(r.TEMPERATUREC), humidityPct: n(r.HUMIDITYPCT), isIndoor: b01(r.ISINDOOR),
  }));
  const seriesOf = async (id) => ({
    heartRate: (await q('SELECT PHASE, TS, BPMMIN, BPMAVG, BPMMAX, SOURCE FROM GEOTRACK_WORKOUTHEARTRATE WHERE WORKOUT_ID = ? ORDER BY TS, PHASE', [id]))
      .map((r) => ({ phase: r.PHASE, ts: utcDate(r.TS), bpmMin: n(r.BPMMIN), bpmAvg: n(r.BPMAVG), bpmMax: n(r.BPMMAX), source: r.SOURCE })),
    route: (await q(`SELECT TS, LAT, LON, ALTITUDEM, SPEEDMS, COURSEDEG, HORIZONTALACCURACYM, VERTICALACCURACYM, ZONE_ID, ISCOARSENED
      FROM GEOTRACK_WORKOUTROUTE WHERE WORKOUT_ID = ? ORDER BY TS`, [id]))
      .map((r) => ({ ts: utcDate(r.TS), lat: n(r.LAT), lon: n(r.LON), altitudeM: n(r.ALTITUDEM), speedMs: n(r.SPEEDMS), courseDeg: n(r.COURSEDEG),
        horizontalAccuracyM: n(r.HORIZONTALACCURACYM), verticalAccuracyM: n(r.VERTICALACCURACYM), zone_ID: r.ZONE_ID, isCoarsened: b01(r.ISCOARSENED) })),
  });

  const [base, trial] = [await workoutsOf(a), await workoutsOf(b)];
  const twins = new Map(trial.map((w) => [w.ID, w]));
  const time = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
  const part = (label, p, total) => `${label} ${p.matched} of ${total} the same${p.different.length ? `, ${p.different.length} different` : ''}${p.missing.length ? `, ${p.missing.length} missing` : ''}${p.extra ? `, ${p.extra} only in the app's copy` : ''}`;
  console.log(`${a}: ${base.length} workouts since ${time(from)} UTC   ${b}: ${trial.length}`);
  let passed = 0, withTwin = 0;
  for (const w of base) {
    const twin = twins.get(`${b}:${w.ID}`);
    twins.delete(`${b}:${w.ID}`);
    if (!twin) { console.log(`${time(w.startedAt)} ${w.name}: NO TWIN on ${b}`); continue; }
    withTwin++;
    const mine = { workout: w, ...(await seriesOf(w.ID)) }, theirs = { workout: twin, ...(await seriesOf(twin.ID)) };
    const r = compareWorkout(mine, theirs);
    if (r.ok) passed++;
    console.log(`${time(w.startedAt)} ${w.name}: ${r.ok ? 'PASS' : 'DIFFERENT'}${r.summary.length ? `; summary differs in ${r.summary.join(', ')}` : ''}; ${part('heart rate', r.heartRate, mine.heartRate.length)}; ${part('route', r.route, mine.route.length)}`);
    for (const [label, p, diff] of [['heart rate', r.heartRate, rateDiff], ['route', r.route, pointDiff]]) {
      for (const d of p.different.slice(0, 3)) console.log(`    ${label} at ${d.base.ts.toISOString().slice(11, 19)} differs from the app's nearest row at ${d.nearest.ts.toISOString().slice(11, 19)} in ${diff(d.base, d.nearest).join(', ')}`);
      for (const m of p.missing.slice(0, 3)) console.log(`    ${label} at ${m.ts.toISOString().slice(11, 19)} is missing in the app's copy`);
    }
  }
  for (const w of twins.values()) console.log(`${time(w.startedAt)} ${w.name}: only on ${b} (no failure)`);
  if (base.length && !withTwin) console.log(`no twin found at all: the app's workout IDs differ from ${a}'s, or the app has sent nothing yet. Do not switch.`);
  console.log(`criterion 1 (every workout of ${a} has a twin, and nothing it has is missing or different there): ${base.length && passed === base.length ? 'met' : 'NOT MET'}${base.length ? `, ${passed} of ${base.length} pass` : ', no workouts'}`);
}

if (require.main === module) main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });

module.exports = { summaryDiff, rateDiff, pointDiff, sameRate, samePoint, pairRows, compareWorkout, instant };
