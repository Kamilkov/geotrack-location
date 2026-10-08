'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');

let edmx;
const load = async () => edmx ??= String(cds.compile.to.edmx(await cds.load(['srv', 'app/tripsui/annotations.cds']), { service: 'TripService' }));
const block = (target) => edmx.match(new RegExp(`<Annotations Target="TripService\\.${target}">[\\s\\S]*?</Annotations>`))?.[0] ?? '';

test('every quantity carries a unit path, and every unit column is a unit', async () => {
  await load();
  assert.doesNotMatch(edmx, /Term="Measures.Unit" String=/);
  const units = [...edmx.matchAll(/<Annotations Target="TripService\.(\w+)\/(\w+)">((?:(?!<\/Annotations>)[\s\S])*?)<Annotation Term="Measures.Unit" Path="(\w+)"\/>/g)]
    .map((m) => [m[1], m[4]]);
  assert.ok(units.length >= 28, `only ${units.length} unit paths`);
  for (const [entity, unit] of units) assert.match(block(`${entity}/${unit}`), /Term="Common.IsUnit"/, `${entity}.${unit} lacks @Common.IsUnit`);
});

test('list, object page and sub-table annotations exist', async () => {
  await load();
  for (const term of ['UI.HeaderInfo', 'UI.LineItem', 'UI.SelectionFields', 'UI.Facets', 'UI.HeaderFacets', 'UI.PresentationVariant']) {
    assert.match(block('Trips'), new RegExp(`Term="${term}"`), term);
  }
  assert.match(block('TripWeather'), /Term="UI.LineItem"/);
  assert.match(block('TripWorkouts'), /Term="UI.LineItem"/);
  // the facet IDs are the anchors of the custom sections in manifest.json
  assert.match(block('Trips'), /String="Workouts"/);
  assert.match(block('Trips'), /String="Weather"/);
});

test('the Trips selection fields match what the list column shows (kindText, not raw kind)', async () => {
  await load();
  const m = block('Trips').match(/<Annotation Term="UI\.SelectionFields">[\s\S]*?<\/Annotation>/);
  assert.ok(m, 'no UI.SelectionFields annotation on Trips');
  assert.match(m[0], /<PropertyPath>kindText<\/PropertyPath>/);
  assert.doesNotMatch(m[0], /<PropertyPath>kind<\/PropertyPath>/);
});

test('the weather condition shows as text only', async () => {
  await load();
  assert.match(block('TripWeather/weatherCode'), /Term="Common.Text" Path="weatherText">\s*<Annotation Term="UI.TextArrangement" EnumMember="UI.TextArrangementType\/TextOnly"\/>/);
});

test('the Route field group shows where the length comes from, as text', async () => {
  await load();
  const group = block('Trips').match(/<Annotation Term="UI\.FieldGroup" Qualifier="Route">[\s\S]*?<\/Annotation>/);
  assert.ok(group, 'no UI.FieldGroup#Route on Trips');
  assert.match(group[0], /Path="lengthSourceText"/);
  assert.match(block('Trips/lengthSourceText'), /Term="Common.Label" String="Length from"/);
  assert.match(block('Trips/lengthSource'), /Term="UI.Hidden"/);
});
