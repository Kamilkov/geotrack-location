'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

// The privacy and regression net for the local app's service: what TripService exposes at all.
const ENTITIES = ['Trips', 'Zones', 'TripWeather', 'TripWorkouts', 'TripMinutes', 'TripPhotos'];
let edmx;
const load = async () => edmx ??= String(cds.compile.to.edmx(await cds.load(['srv']), { service: 'TripService' }));
const entityType = (name) => edmx.match(new RegExp(`<EntityType Name="${name}">[\\s\\S]*?</EntityType>`))?.[0] ?? '';
const props = (name) => [...entityType(name).matchAll(/<(?:Property|NavigationProperty) Name="(\w+)"/g)].map((m) => m[1]);

test('TripService exposes exactly the six read-only entities and one operation, deletePhoto(ID)', async () => {
  await load();
  assert.deepEqual([...edmx.matchAll(/<EntitySet Name="(\w+)"/g)].map((m) => m[1]).sort(), [...ENTITIES].sort());
  for (const e of ENTITIES) {
    const set = edmx.match(new RegExp(`<Annotations Target="TripService\\.EntityContainer/${e}">[\\s\\S]*?</Annotations>`))?.[0] ?? '';
    assert.match(set, /Property="Insertable" Bool="false"/, `${e} insertable`);
    assert.match(set, /Property="Updatable" Bool="false"/, `${e} updatable`);
    assert.match(set, /Property="Deletable" Bool="false"/, `${e} deletable`);
  }
  // The one write. Unbound, so the ID travels in the JSON body and never in the URL (srv/lib/photo-delete.js).
  assert.deepEqual([...edmx.matchAll(/<(Action|Function) Name="(\w+)"/g)].map((m) => `${m[1]} ${m[2]}`), ['Action deletePhoto']);
  assert.match(edmx, /<Action Name="deletePhoto" IsBound="false">\s*<Parameter Name="ID" Type="Edm.Guid" Nullable="false"\/>\s*<\/Action>/);
});

test('no raw, geometry, private-zone or bookkeeping columns leave the service', async () => {
  await load();
  const all = ENTITIES.flatMap(props);
  for (const hidden of ['raw', 'point', 'route', 'geom', 'wkt', 'centreLat', 'centreLon', 'radiusM', 'isPrivate', 'isBase',
    'weatherFetchedAt', 'weatherAttempts', 'weatherAttemptedAt', 'weatherError', 'device', 'isCoarsened']) {
    assert.ok(!all.includes(hidden), `${hidden} is exposed`);
  }
  assert.deepEqual(props('Zones'), ['ID', 'name']);
});

test('Trips navigates to zones, weather, workouts, minutes and photos; thumbnail is a JPEG stream', async () => {
  await load();
  for (const nav of ['startZone', 'endZone', 'weather', 'workouts', 'minutes', 'photos']) assert.ok(props('Trips').includes(nav), nav);
  assert.match(entityType('TripPhotos'), /<Property Name="thumbnail" Type="Edm.Stream"\/>/);
  assert.match(edmx, /Target="TripService.TripPhotos\/thumbnail">\s*<Annotation Term="Core.MediaType" String="image\/jpeg"\/>/);
  assert.match(entityType('TripMinutes'), /<Property Name="speedKmh" Type="Edm.Decimal" Precision="6" Scale="1"\/>/);
});

test('Trips says where its length comes from', async () => {
  await load();
  assert.ok(props('Trips').includes('lengthSource'), 'lengthSource');
  assert.ok(props('Trips').includes('lengthSourceText'), 'lengthSourceText');
});
