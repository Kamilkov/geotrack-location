'use strict';
const cds = require('@sap/cds');
const { circleToWkt } = require('../srv/lib/geo');
const { findZone, insertPosition } = require('../srv/lib/store');
const { coarsen } = require('../srv/lib/coarsen');
const { randomUUID } = require('node:crypto');

const M2DEG_LAT = 1 / 111320;
const m2degLon = (m, lat) => m / (111320 * Math.cos((lat * Math.PI) / 180));
/** Small triangle WKT (apex north, base south); every vertex ~sizeM from the centre, which lies inside it. */
function triangleWkt(lat, lon, sizeM) {
  const dLat = sizeM * M2DEG_LAT;
  const dLon = m2degLon(sizeM, lat);
  const n = `${lon.toFixed(7)} ${(lat + dLat).toFixed(7)}`;
  const sw = `${(lon - dLon).toFixed(7)} ${(lat - dLat).toFixed(7)}`;
  const se = `${(lon + dLon).toFixed(7)} ${(lat - dLat).toFixed(7)}`;
  return `POLYGON((${n}, ${sw}, ${se}, ${n}))`;
}

(async () => {
  await cds.connect.to('db');
  const big = randomUUID(), small = randomUUID(), priv = randomUUID();
  const soloTri = randomUUID(), ovCircle = randomUUID(), ovTri = randomUUID();

  const mkCircle = (id, name, lat, lon, r, flags = {}) => cds.db.run(
    `INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, CENTRELAT, CENTRELON, RADIUSM, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
     VALUES (?, ?, 'circle', ?, ?, ?, ?, ST_GeomFromText(?, 4326), ?, ?, ?)`,
    [id, name, lat, lon, r, circleToWkt(lat, lon, r), circleToWkt(lat, lon, r), flags.base ? 1 : 0, flags.priv ? 1 : 0, 0]);
  const mkPolygon = (id, name, wkt, flags = {}) => cds.db.run(
    `INSERT INTO GEOTRACK_ZONES (ID, NAME, KIND, WKT, GEOM, ISBASE, ISPRIVATE, CREATESVISIT)
     VALUES (?, ?, 'polygon', ?, ST_GeomFromText(?, 4326), ?, ?, ?)`,
    [id, name, wkt, wkt, flags.base ? 1 : 0, flags.priv ? 1 : 0, 0]);

  try {
    await mkCircle(big, 'smoke-big', 42.5, 1.5, 500);
    await mkCircle(small, 'smoke-small', 42.5, 1.5, 100);
    await mkCircle(priv, 'smoke-private', 42.6, 1.6, 300, { base: true, priv: true });
    // Solo polygon, isolated from every circle above: proves plain polygon tagging works.
    await mkPolygon(soloTri, 'smoke-triangle', triangleWkt(42.7, 1.7, 100));
    // Circle is geometrically LARGER (400m radius) than the polygon (~60m to a vertex) and
    // fully contains it, yet the polygon must still win: KIND='polygon' ranks 0, ahead of
    // any circle's RADIUSM, regardless of actual size.
    await mkCircle(ovCircle, 'smoke-overlap-circle', 42.53, 1.53, 400);
    await mkPolygon(ovTri, 'smoke-overlap-polygon', triangleWkt(42.53, 1.53, 60));

    const base = { device: 'smoke', receivedAt: new Date(), accuracy: 5, altitude: 0, velocity: 0, course: 0, battery: 50, batteryState: 1, connection: 'w', ssid: null, pressure: null, trigger: 't' };
    const p = (lat, lon, s) => ({ ...base, ts: new Date(Date.now() + s * 1000), lat, lon, raw: JSON.stringify({ _type: 'location', lat, lon }) });
    const cases = [
      p(42.5001, 1.5001, 1), p(42.503, 1.5, 2), p(42.6005, 1.6005, 3), p(42.9, 1.9, 4),
      p(42.7, 1.7, 5), p(42.53, 1.53, 6),
    ];
    for (const row of cases) console.log(await insertPosition(coarsen(row, await findZone(row.lat, row.lon))));

    const rows = await cds.db.run(`SELECT LAT, LON, ISCOARSENED, ZONE_ID, RAW FROM GEOTRACK_POSITIONS WHERE DEVICE='smoke' ORDER BY TS`);
    console.log(rows.map((r) => ({
      lat: r.LAT, lon: r.LON, coarsened: r.ISCOARSENED,
      zone: r.ZONE_ID === small ? 'small' : r.ZONE_ID === big ? 'big' : r.ZONE_ID === priv ? 'private'
        : r.ZONE_ID === soloTri ? 'triangle' : r.ZONE_ID === ovTri ? 'overlap-polygon' : r.ZONE_ID === ovCircle ? 'overlap-circle'
        : r.ZONE_ID,
      rawHasLat: /"lat"/.test(r.RAW),
    })));
  } finally {
    await cds.db.run(`DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE='smoke'`);
    await cds.db.run(`DELETE FROM GEOTRACK_ZONES WHERE NAME LIKE 'smoke-%'`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
