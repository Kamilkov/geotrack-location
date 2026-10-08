'use strict';
// Fill GEOTRACK_POSITIONS.ACTIVITIES from the stored OwnTracks JSON for rows written before the column existed.
// Idempotent (only rows with ACTIVITIES IS NULL). Coarsened rows keep motionactivities in RAW, so they fill too.
// Run: npx cds bind --exec -- node scripts/activities-backfill.js [--dry-run]
const cds = require('@sap/cds');
const { activitiesOf } = require('../srv/lib/owntracks');
const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  await cds.connect.to('db');
  const rows = await cds.db.run('SELECT DEVICE, TS, RAW FROM GEOTRACK_POSITIONS WHERE ACTIVITIES IS NULL');
  let found = 0, written = 0;
  for (const r of rows) {
    let a = null;
    try { a = activitiesOf(JSON.parse(String(r.RAW))); } catch { /* unparseable RAW: stays null */ }
    if (!a) continue;
    found++;
    if (DRY_RUN) continue;
    const n = await cds.db.run('UPDATE GEOTRACK_POSITIONS SET ACTIVITIES = ? WHERE DEVICE = ? AND TS = ? AND ACTIVITIES IS NULL', [a, r.DEVICE, r.TS]);
    written += n?.changes ?? n;
  }
  console.log(`rows without activities: ${rows.length}; with motion data in RAW: ${found}; ${DRY_RUN ? 'would write' : 'written'}: ${DRY_RUN ? found : written}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
