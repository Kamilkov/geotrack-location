'use strict';
const cds = require('@sap/cds');

const state = { lastStoredAt: null };

const INSERT = `INSERT INTO GEOTRACK_POSITIONS
  (DEVICE, TS, RECEIVEDAT, STOREDAT, LAT, LON, POINT, ACCURACY, ALTITUDE, VELOCITY, COURSE,
   BATTERY, BATTERYSTATE, CONNECTION, SSID, PRESSURE, TRIGGER, RAW, ZONE_ID, ISCOARSENED, ACTIVITIES, VERTICALACCURACY)
  VALUES (?, ?, ?, ?, ?, ?, NEW ST_POINT(?, ?, 4326), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const FIND_ZONE = `SELECT TOP 1 ID, ISPRIVATE, ISBASE, CENTRELAT, CENTRELON
  FROM GEOTRACK_ZONES
  WHERE GEOM IS NOT NULL AND GEOM.ST_Intersects(NEW ST_POINT(?, ?, 4326)) = 1
  ORDER BY ISPRIVATE DESC, CASE WHEN KIND = 'polygon' THEN 0 ELSE RADIUSM END ASC`;

/** Smallest zone containing the point; private zones win. null when none. */
async function findZone(lat, lon) {
  const rows = await cds.db.run(FIND_ZONE, [lon, lat]);
  return rows[0] || null;
}

/** `db`: the connection to write through; the HTTPS route passes its own (tests inject one). */
async function insertPosition(row, db = cds.db) {
  const storedAt = new Date();
  const params = [
    row.device, row.ts.toISOString(), row.receivedAt.toISOString(), storedAt.toISOString(), row.lat, row.lon,
    row.lon, row.lat, // ST_POINT(x=lon, y=lat)
    row.accuracy, row.altitude, row.velocity, row.course,
    row.battery, row.batteryState, row.connection, row.ssid, row.pressure, row.trigger, row.raw,
    row.zone_ID ?? null, row.isCoarsened ? 1 : 0, row.activities ?? null, row.verticalAccuracy ?? null,
  ];
  try {
    await db.run(INSERT, params);
    state.lastStoredAt = storedAt;
    return 'inserted';
  } catch (e) {
    if (e.code === 301) return 'duplicate'; // HANA: unique constraint violated
    throw e;
  }
}

async function dbHealthy() {
  try {
    await cds.db.run('SELECT 1 FROM DUMMY');
    return true;
  } catch {
    return false;
  }
}

module.exports = { insertPosition, findZone, dbHealthy, state };
