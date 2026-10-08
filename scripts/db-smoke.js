'use strict';
const cds = require('@sap/cds');
const { parse } = require('../srv/lib/owntracks');
const { insertPosition } = require('../srv/lib/store');
const fixture = require('fs').readFileSync(__dirname + '/../test/fixtures/location.json');

(async () => {
  await cds.connect.to('db');
  const row = parse('owntracks/kamil/smoke', fixture, new Date());
  row.ts = new Date(); // fresh key each run
  console.log('first :', await insertPosition(row));
  console.log('second:', await insertPosition(row));
  const [r] = await cds.db.run(
    "SELECT DEVICE, POINT.ST_AsText() AS WKT, POINT.ST_SRID() AS SRID FROM GEOTRACK_POSITIONS WHERE DEVICE='smoke' ORDER BY TS DESC LIMIT 1");
  console.log(r);
  await cds.db.run("DELETE FROM GEOTRACK_POSITIONS WHERE DEVICE='smoke'");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
