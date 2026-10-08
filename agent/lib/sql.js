'use strict';
const cds = require('@sap/cds');

const log = cds.log('agent');

/** Native SQL for the GeoAgentService handlers: any database failure becomes a fixed 503, the cause goes to the log only. */
async function sql(req, statement, params = [], db = cds.db) {
  try {
    return await db.run(statement, params);
  } catch (e) {
    log.error('query failed:', e.message);
    return req.reject(503, 'Database unavailable (HANA may be stopped)');
  }
}

module.exports = { sql };
