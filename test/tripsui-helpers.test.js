'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

// Evaluate the UI5 module with a stub loader; ControllerExtension.extend returns a plain function.
const src = readFileSync(path.join(__dirname, '../app/tripsui/webapp/ext/controller/ObjectPageExt.controller.js'), 'utf8');
let h, spec, connected = [], confirms = [], errors = [], toasts = [];
function VizTooltip() { this.connect = (uid) => connected.push(uid); }
const MessageBox = { Action: { CANCEL: 'CANCEL' }, confirm: (text, opts) => confirms.push({ text, opts }), error: (text) => errors.push(text) };
const MessageToast = { show: (text) => toasts.push(text) };
const Device = { resize: { attachHandler: () => {}, detachHandler: () => {} } };
const sap = { ui: { define: (_deps, factory) => {
  const ControllerExtension = { extend: (_name, s) => { spec = s; return function () {}; } };
  h = factory(ControllerExtension, function JSONModel() {}, function LightBox() {}, function LightBoxItem() {}, VizTooltip, MessageBox, MessageToast, Device).helpers;
} } };
new Function('sap', src)(sap);

const TEXTS = { start: 'Start', end: 'End', positionFromOwnTracks: 'position from OwnTracks' };

test('parseWkt: LINESTRING to [lon, lat] pairs; null for empty, short or malformed text', () => {
  assert.deepEqual(h.parseWkt('LINESTRING(1.5 42.5, 1.501 42.502,1.502 42.503)'), [[1.5, 42.5], [1.501, 42.502], [1.502, 42.503]]);
  assert.deepEqual(h.parseWkt(' linestring ( 1.5 42.5 , 1.6 42.6 ) '), [[1.5, 42.5], [1.6, 42.6]]);
  for (const bad of [null, undefined, '', 'POINT(1.5 42.5)', 'LINESTRING(1.5 42.5)', 'LINESTRING(1.5 x, 1.6 42.6)', 'LINESTRING(1.5, 1.6 42.6)', 'LINESTRING EMPTY']) {
    assert.equal(h.parseWkt(bad), null, String(bad));
  }
});

test('mapState: route, start/end spots, one spot per photo, bbox covers photos', () => {
  const photos = [
    { ID: 'p1', takenAt: '2026-09-22T16:47:15Z', lat: '42.5003', lon: '1.5002', positionSource: 'photo' },
    { ID: 'p2', takenAt: '2026-09-22T17:00:00Z', lat: 42.6, lon: 1.6, positionSource: 'owntracks' },
  ];
  const s = h.mapState('LINESTRING(1.5 42.5, 1.501 42.502)', photos, TEXTS);
  assert.equal(s.hasRoute, true);
  assert.equal(s.routes[0].position, '1.5;42.5;0;1.501;42.502;0');
  assert.deepEqual(s.spots.map((x) => x.photoID), [null, null, 'p1', 'p2']);
  assert.deepEqual(s.spots.slice(0, 2).map((x) => x.text), ['Start', 'End']);
  assert.equal(s.spots[2].position, '1.5002;42.5003;0');
  assert.match(s.spots[3].tooltip, /position from OwnTracks/);
  assert.doesNotMatch(s.spots[2].tooltip, /OwnTracks/);
  assert.equal(s.center, `${(1.5 + 1.6) / 2};${(42.5 + 42.6) / 2}`);
  assert.ok(s.zoom >= 3 && s.zoom <= 17);
});

test('mapState: no route → no map, whatever the photos', () => {
  assert.deepEqual(h.mapState(null, [{ ID: 'p', takenAt: '2026-09-22T16:47:15Z', lat: 1, lon: 1 }], TEXTS), { hasRoute: false, routes: [], spots: [] });
});

test('zoomFor clamps to 3..17 and shrinks with extent', () => {
  assert.equal(h.zoomFor(360), 3);
  assert.equal(h.zoomFor(0), 17);
  assert.ok(h.zoomFor(0.02) > h.zoomFor(2));
});

test('chartState: heart rate where present, profile only from route minutes, numbers from strings', () => {
  const minutes = [
    { minuteTS: '2026-09-22T16:00:00Z', hrAvg: '98.5', hrMax: 104, altitudeM: null, speedKmh: null },
    { minuteTS: '2026-09-22T16:01:00Z', hrAvg: null, hrMax: null, altitudeM: '1203.4', speedKmh: 4.5 },
    { minuteTS: '2026-09-22T16:02:00Z', hrAvg: 101, hrMax: 110, altitudeM: 1205, speedKmh: null },
  ];
  const s = h.chartState(minutes);
  assert.deepEqual(s.hr.map((r) => [r.t.toISOString(), r.hrAvg, r.hrMax]), [['2026-09-22T16:00:00.000Z', 98.5, 104], ['2026-09-22T16:02:00.000Z', 101, 110]]);
  assert.deepEqual(s.profile.map((r) => [r.altitudeM, r.speedKmh]), [[1203.4, 4.5], [1205, null]]);
  assert.equal(s.hasWatchRoute, true);
  const noRoute = h.chartState([{ minuteTS: '2026-09-22T16:00:00Z', hrAvg: 90, hrMax: 95, altitudeM: null, speedKmh: null }]);
  assert.equal(noRoute.hasWatchRoute, false);
  assert.deepEqual(h.chartState([]), { hr: [], profile: [], hasWatchRoute: false });
});

test('photoState: thumbnail URL under the service root', () => {
  const [p] = h.photoState([{ ID: 'a1b2', takenAt: '2026-09-22T16:47:15Z', fileName: 'IMG_0001.HEIC' }], '/trips/');
  assert.equal(p.src, '/trips/TripPhotos(a1b2)/thumbnail');
  assert.equal(p.fileName, 'IMG_0001.HEIC');
  assert.match(p.time, /\d\d.\d\d/);
});

test('tripIdFromContext: plain and ID= keys', () => {
  const ctx = (p) => ({ getPath: () => p });
  assert.equal(h.tripIdFromContext(ctx('/Trips(0b6c0d7e-1f2a-4b3c-8d9e-0a1b2c3d4e5f)')), '0b6c0d7e-1f2a-4b3c-8d9e-0a1b2c3d4e5f');
  assert.equal(h.tripIdFromContext(ctx("/Trips(ID=0b6c0d7e-1f2a-4b3c-8d9e-0a1b2c3d4e5f)")), '0b6c0d7e-1f2a-4b3c-8d9e-0a1b2c3d4e5f');
});

test('onChartRendered: both charts ask for it; a chart gets one tooltip, connected by its id, however often it renders', () => {
  const fragment = readFileSync(path.join(__dirname, '../app/tripsui/webapp/ext/fragment/Chart.fragment.xml'), 'utf8');
  assert.equal((fragment.match(/renderComplete="\.extension\.tripsui\.ext\.controller\.ObjectPageExt\.onChartRendered"/g) || []).length, 2);
  const chart = (id) => {
    const data = {}, dependents = [];
    return { getId: () => id, data: (k, v) => (v === undefined ? data[k] : (data[k] = v)), addDependent: (d) => dependents.push(d), dependents };
  };
  const a = chart('chart-a'), b = chart('chart-b');
  connected = [];
  spec.onChartRendered({ getSource: () => a });
  spec.onChartRendered({ getSource: () => a });
  spec.onChartRendered({ getSource: () => b });
  assert.deepEqual(connected, ['chart-a', 'chart-b']);
  assert.equal(a.dependents.length, 1);
  assert.ok(a.dependents[0] instanceof VizTooltip);
});

test('withoutPhoto: the photo and its map spot go; start, end and the other photos stay', () => {
  const data = { photos: [{ ID: 'p1' }, { ID: 'p2' }], spots: [{ photoID: null, text: 'Start' }, { photoID: null, text: 'End' }, { photoID: 'p1' }, { photoID: 'p2' }] };
  assert.deepEqual(h.withoutPhoto(data, 'p1'), { photos: [{ ID: 'p2' }], spots: [{ photoID: null, text: 'Start' }, { photoID: null, text: 'End' }, { photoID: 'p2' }] });
});

test('checked: 204 (an action without a result) gives null; an error rejects with the server message', async () => {
  assert.equal(await h.checked({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) }), null);
  assert.deepEqual(await h.checked({ ok: true, status: 200, json: async () => ({ a: 1 }) }), { a: 1 });
  await assert.rejects(h.checked({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: { message: 'Read-only mode' } }) }), /^Error: Read-only mode$/);
});

/** onDeletePhoto's surroundings: the trip model with two photos, the texts, and a fetch that answers `answer`. */
function deleteWorld(answer) {
  const state = { photos: [{ ID: 'p1', time: '14:32' }, { ID: 'p2', time: '15:00' }], spots: [{ photoID: null }, { photoID: 'p1' }, { photoID: 'p2' }], deleting: false };
  const trip = { getData: () => state, getProperty: (p) => state[p.slice(1)], setProperty: (p, v) => { state[p.slice(1)] = v; } };
  const texts = { deletePhotoAction: 'Delete', deletePhotoQuestion: 'Delete the photo taken at {0}?', photoDeleted: 'Photo deleted' };
  const ctrl = Object.create(spec);
  ctrl.base = {
    getView: () => ({ getModel: (name) => (name === 'trip' ? trip : { getServiceUrl: () => '/trips/' }) }),
    getAppComponent: () => ({ getModel: () => ({ getResourceBundle: () => ({ getText: (k, a) => (texts[k] ?? k).replace('{0}', a?.[0]) }) }) }),
  };
  const press = { getSource: () => ({ getBindingContext: () => ({ getObject: () => state.photos[0] }) }) };
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => { calls.push({ url, init }); return answer; };
  confirms = []; errors = []; toasts = [];
  return { ctrl, press, state, calls, restore: () => { global.fetch = realFetch; } };
}
const settle = () => new Promise((r) => setImmediate(r));

test('onDeletePhoto: asks first; Cancel sends nothing; Delete posts the ID as JSON and the photo and its spot leave the view', async () => {
  const fragment = readFileSync(path.join(__dirname, '../app/tripsui/webapp/ext/fragment/Photos.fragment.xml'), 'utf8');
  assert.match(fragment, /press="\.extension\.tripsui\.ext\.controller\.ObjectPageExt\.onDeletePhoto"/);
  const w = deleteWorld({ ok: true, status: 204 });
  try {
    w.ctrl.onDeletePhoto(w.press);
    assert.equal(confirms.length, 1);
    assert.equal(confirms[0].text, 'Delete the photo taken at 14:32?');
    confirms[0].opts.onClose('CANCEL');
    await settle();
    assert.equal(w.calls.length, 0);
    confirms[0].opts.onClose('Delete');
    await settle();
    assert.deepEqual(w.calls, [{ url: '/trips/deletePhoto', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"ID":"p1"}' } }]);
    assert.deepEqual(w.state.photos.map((p) => p.ID), ['p2']);
    assert.deepEqual(w.state.spots.map((s) => s.photoID), [null, 'p2']);
    assert.deepEqual([toasts, errors, w.state.deleting], [['Photo deleted'], [], false]);
  } finally { w.restore(); }
});

test('onDeletePhoto: a refused delete shows the server message and keeps the photo', async () => {
  const w = deleteWorld({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({ error: { message: 'Read-only mode: photos cannot be deleted here' } }) });
  try {
    w.ctrl.onDeletePhoto(w.press);
    confirms[0].opts.onClose('Delete');
    await settle();
    assert.deepEqual(errors, ['Read-only mode: photos cannot be deleted here']);
    assert.deepEqual(w.state.photos.map((p) => p.ID), ['p1', 'p2']);
    assert.deepEqual([toasts, w.state.deleting], [[], false]);
  } finally { w.restore(); }
});

test('onDeletePhoto: while a delete runs, another press opens nothing (a second tap before the busy indicator shows)', async () => {
  let answer;
  const w = deleteWorld(new Promise((r) => { answer = r; }));
  try {
    w.ctrl.onDeletePhoto(w.press);
    confirms[0].opts.onClose('Delete');
    assert.equal(w.state.deleting, true);
    w.ctrl.onDeletePhoto(w.press);
    assert.equal(confirms.length, 1);
    answer({ ok: true, status: 204 });
    await settle();
    assert.deepEqual([w.calls.length, w.state.photos.map((p) => p.ID), w.state.deleting], [1, ['p2'], false]);
  } finally { w.restore(); }
});

test('mapHeight: small 420 px, normal 60% of the window, large nearly all of it, never below 420 px', () => {
  assert.equal(h.mapHeight('small', 900), '420px');
  assert.equal(h.mapHeight('small', 1400), '420px');
  assert.equal(h.mapHeight('normal', 900), '540px');
  assert.equal(h.mapHeight('normal', 600), '420px');
  assert.equal(h.mapHeight('large', 900), '764px');
  assert.equal(h.mapHeight('large', 500), '420px');
});

test('storedSize: the size this browser had last; normal when unknown or when storage is off', () => {
  const realWindow = global.window;
  try {
    for (const [value, size] of [['large', 'large'], ['small', 'small'], ['bogus', 'normal'], [null, 'normal']]) {
      global.window = { localStorage: { getItem: () => value } };
      assert.equal(h.storedSize(), size, String(value));
    }
    global.window = { localStorage: { getItem: () => { throw new Error('private mode'); } } };
    assert.equal(h.storedSize(), 'normal');
  } finally { global.window = realWindow; }
});

test('onMapSmaller/onMapLarger: one size at a time, stopping at the ends, remembered; a window resize sizes it again', () => {
  const fragment = readFileSync(path.join(__dirname, '../app/tripsui/webapp/ext/fragment/Map.fragment.xml'), 'utf8');
  assert.match(fragment, /<vbm:GeoMap [^>]*height="\{mapSize>\/height\}"/);
  assert.match(fragment, /enabled="\{= \$\{mapSize>\/size\} !== 'small' \}"[^>]*press="\.extension\.tripsui\.ext\.controller\.ObjectPageExt\.onMapSmaller"/);
  assert.match(fragment, /enabled="\{= \$\{mapSize>\/size\} !== 'large' \}"[^>]*press="\.extension\.tripsui\.ext\.controller\.ObjectPageExt\.onMapLarger"/);
  const stored = {};
  const realWindow = global.window;
  global.window = { innerHeight: 900, localStorage: { setItem: (k, v) => { stored[k] = v; }, getItem: (k) => stored[k] ?? null } };
  try {
    const size = { size: 'normal', height: '540px' };
    const ctrl = Object.create(spec);
    ctrl._mapSize = { getProperty: (p) => size[p.slice(1)], setProperty: (p, v) => { size[p.slice(1)] = v; } };
    ctrl.onMapLarger();
    assert.deepEqual([size, stored], [{ size: 'large', height: '764px' }, { 'geotrack.mapSize': 'large' }]);
    ctrl.onMapLarger();
    assert.deepEqual(size, { size: 'large', height: '764px' }, 'nothing above large');
    global.window.innerHeight = 700;
    ctrl._onWindowResize();
    assert.equal(size.height, '564px');
    ctrl.onMapSmaller();
    assert.deepEqual(size, { size: 'normal', height: '420px' });
    ctrl.onMapSmaller();
    assert.deepEqual([size, stored], [{ size: 'small', height: '420px' }, { 'geotrack.mapSize': 'small' }]);
    ctrl.onMapSmaller();
    assert.equal(size.size, 'small', 'nothing below small');
  } finally { global.window = realWindow; }
});
