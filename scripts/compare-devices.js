'use strict';
// Read-only comparison of two devices over the same days: the same pure segmenter, settings, zones and
// accuracy limits for both. It writes nothing. Its output holds real times: keep it on your Mac.
// Run: npx cds bind --exec -- node scripts/compare-devices.js --a iphone --b trial-iphone \
//        --from 2026-10-10T00:00:00Z --to 2026-10-17T00:00:00Z
const { segment } = require('../srv/lib/segmenter');
const { accuracyLimits, accepted } = require('../srv/lib/accuracy');
const { lengthM } = require('../srv/lib/trip-route');

const WARM_UP_MS = 24 * 3600000; // both devices start empty this long before --from
const LIMITS = { minutes: 5, percent: 10 };

/** The stored trips' fallback when the segmenter knows no travel mode: by the median speed (km/h) of the trip's positions. */
function speedKind(velocities) {
  const v = velocities.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return 'unknown';
  const median = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  return median <= 7 ? 'walk' : median >= 20 ? 'drive' : 'unknown';
}

/**
 * One device, segmented from an empty state. positions: ascending by ts, as the runner maps them, plus
 * `velocity`. Kind and length come from the phone's accepted positions only: no Watch route.
 * `underWay`: the start of a trip that is still open after the last position, else null.
 */
function segmented(positions, settings, device) {
  const limits = accuracyLimits(settings);
  const out = segment(positions, { device }, settings);
  const trips = out.trips.map((t) => {
    const own = positions.filter((p) => accepted(p, limits) && p.ts >= t.startedAt && p.ts <= t.endedAt);
    return { startedAt: t.startedAt, endedAt: t.endedAt, kind: t.kind ?? speedKind(own.map((p) => p.velocity)), lengthM: Math.round(lengthM(own)), points: own.length };
  });
  return { trips, underWay: out.state.openTrip?.startedAt ?? null };
}

/** The closed trips of one device. */
const tripsOf = (positions, settings, device) => segmented(positions, settings, device).trips;

/** Trips wholly inside from..to are counted; one an edge cuts is listed apart; the warm-up's trips are dropped. */
function inWindow(trips, from, to) {
  const counted = trips.filter((t) => t.startedAt >= from && t.endedAt <= to);
  const cut = trips.filter((t) => !counted.includes(t) && t.endedAt > from && t.startedAt < to);
  return { counted, cut };
}

/** Each trip with the trip of the other device it overlaps longest in time; the longest overlaps pair first. */
function pair(a, b) {
  const overlaps = [];
  a.forEach((x, i) => b.forEach((y, j) => {
    const ms = Math.min(x.endedAt, y.endedAt) - Math.max(x.startedAt, y.startedAt);
    if (ms > 0) overlaps.push({ i, j, ms });
  }));
  overlaps.sort((p, q) => q.ms - p.ms);
  const usedA = new Set(), usedB = new Set(), pairs = [];
  for (const o of overlaps) {
    if (usedA.has(o.i) || usedB.has(o.j)) continue;
    usedA.add(o.i); usedB.add(o.j);
    pairs.push({ a: a[o.i], b: b[o.j] });
  }
  pairs.sort((p, q) => p.a.startedAt - q.a.startedAt);
  return { pairs, onlyA: a.filter((_, i) => !usedA.has(i)), onlyB: b.filter((_, j) => !usedB.has(j)) };
}

/** What separates a pair, and whether it is within the limits. The length is compared against the longer of the two. */
function difference({ a, b }, limits = LIMITS) {
  const startMin = Math.abs(a.startedAt - b.startedAt) / 60000, endMin = Math.abs(a.endedAt - b.endedAt) / 60000;
  const longer = Math.max(a.lengthM, b.lengthM);
  const lengthPct = longer ? (Math.abs(a.lengthM - b.lengthM) / longer) * 100 : 0;
  const sameKind = a.kind === b.kind;
  return { startMin, endMin, lengthPct, sameKind, ok: sameKind && startMin <= limits.minutes && endMin <= limits.minutes && lengthPct <= limits.percent };
}

/**
 * Pauses of more than gapMinutes between accepted positions inside from..to. The window's end is a mark; so
 * is its start, unless an accepted position lies before it (the warm-up): then a silence that began before
 * the window is reported with its real start.
 */
function silences(positions, settings, from, to) {
  const limits = accuracyLimits(settings), gapMs = settings.gapMinutes * 60000;
  const ok = positions.filter((p) => accepted(p, limits) && p.ts <= to).map((p) => p.ts);
  const before = ok.filter((ts) => ts < from).pop();
  const marks = [before ?? from, ...ok.filter((ts) => ts >= from), to];
  const out = [];
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > gapMs) out.push({ from: marks[i - 1], to: marks[i] });
  return out;
}

/**
 * The silences of `mine` that `theirs` does not also have: with the other device's silences taken out of one,
 * a stretch longer than gapMs is left. An overlap alone excuses nothing.
 */
function unshared(mine, theirs, gapMs) {
  const others = [...theirs].sort((x, y) => x.from - y.from);
  return mine.filter((s) => {
    let from = s.from.getTime(); // where the part not yet covered begins
    for (const o of others) {
      if (o.to <= from || o.from >= s.to) continue;
      if (o.from - from > gapMs) return true;
      from = Math.max(from, o.to.getTime());
    }
    return s.to - from > gapMs;
  });
}

/** Whether the device has an accepted position inside from..to at all. */
function hasPositions(positions, settings, from, to) {
  const limits = accuracyLimits(settings);
  return positions.some((p) => accepted(p, limits) && p.ts >= from && p.ts <= to);
}

/** A UTC instant from the command line: a string that ends in Z or an offset. Anything else is an invalid Date. */
const instant = (v) => new Date(typeof v === 'string' && /(Z|[+-]\d\d:\d\d)$/.test(v) ? v : NaN);

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? null : argv[i + 1]; };
  const a = arg('a'), b = arg('b'), from = instant(arg('from')), to = instant(arg('to'));
  if (!a || !b || isNaN(from) || isNaN(to) || !(from < to)) {
    console.error('usage: compare-devices.js --a <device> --b <device> --from <UTC instant, e.g. 2026-10-10T00:00:00Z> --to <UTC instant>');
    process.exit(2);
  }
  const cds = require('@sap/cds');
  const { loadSettings, utcDate } = require('../srv/lib/segment-runner');
  await cds.connect.to('db');
  const settings = await loadSettings();
  const zones = new Map((await cds.db.run('SELECT ID, ISBASE, CREATESVISIT FROM GEOTRACK_ZONES')).map((z) => [z.ID, z]));
  const load = async (device) => (await cds.db.run(
    'SELECT TS, LAT, LON, ACCURACY, VERTICALACCURACY, ZONE_ID, ACTIVITIES, VELOCITY, TRIGGER FROM GEOTRACK_POSITIONS WHERE DEVICE = ? AND TS >= ? AND TS <= ? ORDER BY TS',
    [device, new Date(from - WARM_UP_MS).toISOString(), to.toISOString()])).map((r) => {
    const z = zones.get(r.ZONE_ID);
    return { ts: utcDate(r.TS), lat: Number(r.LAT), lon: Number(r.LON), accuracy: r.ACCURACY, verticalAccuracy: r.VERTICALACCURACY, zone_ID: r.ZONE_ID,
      zoneIsBase: !!z?.ISBASE, zoneCreatesVisit: !!z?.CREATESVISIT, activities: r.ACTIVITIES, velocity: r.VELOCITY, trigger: r.TRIGGER };
  });
  const [pa, pb] = [await load(a), await load(b)];
  const [ga, gb] = [segmented(pa, settings, a), segmented(pb, settings, b)];
  const [wa, wb] = [inWindow(ga.trips, from, to), inWindow(gb.trips, from, to)];
  const { pairs, onlyA, onlyB } = pair(wa.counted, wb.counted);

  const time = (d) => d.toISOString().slice(5, 16).replace('T', ' ');
  const show = (t) => `${time(t.startedAt)}–${time(t.endedAt).slice(6)} ${t.kind.padEnd(7)} ${String(t.lengthM).padStart(6)} m ${String(t.points).padStart(3)} pts`;
  console.log(`${a}: ${pa.length} positions, ${wa.counted.length} trips   ${b}: ${pb.length} positions, ${wb.counted.length} trips   (UTC)`);
  let tripsOk = !onlyA.length && !onlyB.length;
  for (const p of pairs) {
    const d = difference(p);
    tripsOk &&= d.ok;
    console.log(`${show(p.a)} | ${show(p.b)} | start ${d.startMin.toFixed(1)} min, end ${d.endMin.toFixed(1)} min, length ${d.lengthPct.toFixed(1)} % ${d.ok ? 'ok' : 'DIFFERENT'}`);
  }
  for (const t of onlyA) console.log(`${show(t)} | only on ${a}`);
  for (const t of onlyB) console.log(`${' '.repeat(show(t).length)} | ${show(t)} | only on ${b}`);
  for (const [device, w] of [[a, wa], [b, wb]]) for (const t of w.cut) console.log(`cut by the window's edge, not counted: ${device} ${show(t)}`);
  for (const [device, g] of [[a, ga], [b, gb]]) if (g.underWay) console.log(`under way at the window's end, not counted: ${device} since ${time(g.underWay)}; a partner on the other device that ended inside the window shows as "only on"`);

  const [sa, sb] = [silences(pa, settings, from, to), silences(pb, settings, from, to)];
  const mins = (s) => Math.round((s.to - s.from) / 60000);
  for (const [device, s] of [[a, sa], [b, sb]]) console.log(`${device}: ${s.length} silences over ${settings.gapMinutes} min${s.length ? `: ${s.map((x) => `${time(x.from)} (${mins(x)} min)`).join(', ')}` : ''}`);
  const alone = unshared(sb, sa, settings.gapMinutes * 60000);
  const empty = [[a, pa], [b, pb]].filter(([, p]) => !hasPositions(p, settings, from, to)).map(([device]) => device);
  if (empty.length) console.log(`no accepted position in the window: ${empty.join(', ')}; neither criterion can be met`);
  console.log(`criterion 1 (no silence on ${b} that ${a} does not also have): ${empty.length ? 'NOT MET' : alone.length ? `NOT MET, ${alone.length} only on ${b}` : 'met'}`);
  console.log(`criterion 2 (the same trips, within ${LIMITS.minutes} min and ${LIMITS.percent} %): ${!empty.length && tripsOk ? 'met' : 'NOT MET'}`);
}

if (require.main === module) main(process.argv.slice(2)).then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });

module.exports = { speedKind, tripsOf, segmented, inWindow, pair, difference, silences, unshared, hasPositions, instant };
