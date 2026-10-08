'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deletePhoto } = require('../srv/lib/photo-delete');

const ID = '0b6c0d7e-1f2a-5b3c-8d9e-0a1b2c3d4e5f';
/** Records each statement; the DELETE reports `changes` rows, as @cap-js/hana does for plain SQL. */
function fakeDb(changes = 1) {
  const calls = [];
  return { calls, run: async (sql, params) => { calls.push({ sql, params }); return { changes }; } };
}
/** CAP's req as far as the handler uses it: reject() throws. */
const req = (data) => ({ data, reject: (code, message) => { throw Object.assign(new Error(message), { code }); } });

test('deletes the photo row by its ID', async () => {
  const db = fakeDb(1);
  await deletePhoto(req({ ID }), { db, readOnly: false });
  assert.deepEqual(db.calls, [{ sql: 'DELETE FROM GEOTRACK_PHOTOS WHERE ID = ?', params: [ID] }]);
});

test('a missing or malformed ID gets 400 before any SQL: an empty cross-site form POST carries none', async () => {
  for (const data of [{}, { ID: null }, { ID: '' }, { ID: 42 }, { ID: 'x' }, { ID: `${ID}' OR '1'='1` }, { ID: ` ${ID}` }]) {
    const db = fakeDb();
    await assert.rejects(deletePhoto(req(data), { db, readOnly: false }), { code: 400 }, JSON.stringify(data));
    assert.equal(db.calls.length, 0, JSON.stringify(data));
  }
});

test('an ID that matches no photo gets 404', async () => {
  await assert.rejects(deletePhoto(req({ ID }), { db: fakeDb(0), readOnly: false }), { code: 404 });
});

test("read-only mode (the Mac's npm run ui) gets 403 before any SQL", async () => {
  const db = fakeDb();
  await assert.rejects(deletePhoto(req({ ID }), { db, readOnly: true }), { code: 403 });
  assert.equal(db.calls.length, 0);
});
