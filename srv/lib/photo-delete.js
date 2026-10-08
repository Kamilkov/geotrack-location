'use strict';
const cds = require('@sap/cds');

const log = cds.log('trips');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * TripService.deletePhoto, the trips app's one write: a stored photo's row and thumbnail go. The original
 * stays on the phone; picking it again in the app sends it back under the same ID.
 * The ID comes only from the JSON body. The browser sends Caddy's basic-auth password with cross-site
 * requests too: csrfGuard (srv/lib/mode.js) admits only JSON and multipart/mixed POSTs to /trips, and
 * without a valid ID nothing happens here either.
 */
async function deletePhoto(req, { db, readOnly }) {
  if (readOnly) return req.reject(403, 'Read-only mode: photos cannot be deleted here');
  const { ID } = req.data;
  if (typeof ID !== 'string' || !UUID.test(ID)) return req.reject(400, 'ID must be the UUID of a photo');
  const { changes } = await db.run('DELETE FROM GEOTRACK_PHOTOS WHERE ID = ?', [ID]);
  if (!changes) return req.reject(404, 'Photo not found');
  log.info('photo', ID, 'deleted');
}

module.exports = { deletePhoto };
