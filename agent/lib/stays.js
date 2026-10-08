'use strict';
const { utcDate } = require('../../srv/lib/time');
const { localDate, localIso, inRange } = require('./periods');

const VISIT = new Set(['pending', 'created', 'closed', 'failed']);
const statusOf = (visitStatus) => (visitStatus === 'passthrough' ? 'passthrough' : VISIT.has(visitStatus) ? 'visit' : 'stay');

/**
 * One zone's ZoneEvents → stays, oldest first. events: [{ kind: 'enter'|'leave', at, visitStatus }]
 * of a single zone and device, any order. An enter pairs with the next leave; an enter followed by
 * another enter (a lost leave) closes nothing and is dropped; a leave without an open enter is
 * ignored; a trailing enter is a stay in progress (leftAt null, duration up to `now`). superseded
 * events are skipped. The enter's visitStatus decides the status.
 */
function pairStays(events, now = new Date()) {
  const sorted = events.filter((e) => e.visitStatus !== 'superseded')
    .map((e) => ({ ...e, at: utcDate(e.at) })).sort((a, b) => a.at - b.at);
  const stays = [];
  let open = null;
  for (const e of sorted) {
    if (e.kind === 'enter') open = e;
    else if (e.kind === 'leave' && open) {
      stays.push({ arrivedAt: open.at, leftAt: e.at, status: statusOf(open.visitStatus) });
      open = null;
    }
  }
  if (open) stays.push({ arrivedAt: open.at, leftAt: null, status: statusOf(open.visitStatus) });
  return stays.map((s) => ({ ...s, durationMin: Math.round(((s.leftAt ?? now) - s.arrivedAt) / 60000) }));
}

/**
 * Stays of one zone (oldest first) → the zoneStats summary. Only stays that arrived on a local date
 * in `range` count. totalMin, firstArrival, lastArrival and lastDeparture ignore passthroughs;
 * latest lists up to 20 stays of every status, newest first. Times are local ISO with offset.
 */
function summarizeStays(stays, { range, tz }) {
  const inR = stays.filter((s) => inRange(localDate(s.arrivedAt, tz), range));
  const real = inR.filter((s) => s.status !== 'passthrough');
  const count = (status) => inR.filter((s) => s.status === status).length;
  return {
    visits: count('visit'),
    passthroughs: count('passthrough'),
    stays: count('stay'),
    totalMin: real.reduce((n, s) => n + s.durationMin, 0),
    firstArrival: localIso(real[0]?.arrivedAt ?? null, tz),
    lastArrival: localIso(real.at(-1)?.arrivedAt ?? null, tz),
    lastDeparture: localIso(real.filter((s) => s.leftAt).at(-1)?.leftAt ?? null, tz),
    latest: inR.slice(-20).reverse().map((s) => ({
      arrivedAt: localIso(s.arrivedAt, tz), leftAt: localIso(s.leftAt, tz), durationMin: s.durationMin, status: s.status,
    })),
  };
}

module.exports = { pairStays, summarizeStays };
