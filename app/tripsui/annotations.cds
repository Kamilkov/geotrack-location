using TripService as service from '../../srv/trip-service';

annotate service.Trips with @(
  UI.HeaderInfo: {
    TypeName: 'Trip', TypeNamePlural: 'Trips',
    Title: { Value: kindText }, Description: { Value: startedAt }
  },
  UI.SelectionFields: [ startedAt, kindText ],
  UI.LineItem: [
    { Value: startedAt }, { Value: kindText }, { Value: startZone.name, Label: 'From' }, { Value: endZone.name, Label: 'To' },
    { Value: lengthM }, { Value: durationMin }, { Value: weatherText }, { Value: temperatureC },
    { Value: precipitationMm }, { Value: windKmh }
  ],
  UI.PresentationVariant: {
    SortOrder: [ { Property: startedAt, Descending: true } ],
    Visualizations: [ '@UI.LineItem' ]
  },
  UI.HeaderFacets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Route' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#Length' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#Duration' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Weather' }
  ],
  UI.DataPoint #Length:   { Value: lengthM,     Title: 'Length' },
  UI.DataPoint #Duration: { Value: durationMin, Title: 'Duration' },
  UI.FieldGroup #Route: {
    Label: 'Route',
    Data: [ { Value: startZone.name, Label: 'From' }, { Value: endZone.name, Label: 'To' }, { Value: startedAt }, { Value: endedAt },
            { Value: lengthSourceText } ]
  },
  UI.FieldGroup #Weather: {
    Label: 'Weather',
    Data: [ { Value: weatherText }, { Value: temperatureC }, { Value: apparentTemperatureC }, { Value: precipitationMm }, { Value: windKmh } ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Workouts', Label: 'Workout', Target: 'workouts/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', ID: 'Weather',  Label: 'Weather', Target: 'weather/@UI.LineItem' }
  ],
  Capabilities.FilterRestrictions.FilterExpressionRestrictions: [ { Property: startedAt, AllowedExpressions: 'SingleRange' } ],
  Capabilities.SearchRestrictions.Searchable: false
) {
  ID                   @UI.Hidden;
  startedAt            @Common.Label: 'Start';
  endedAt              @Common.Label: 'End';
  kind                 @Common.Label: 'Kind';
  kindText             @Common.Label: 'Kind';
  lengthM              @Common.Label: 'Length'        @Measures.Unit: unitM;
  lengthSource         @UI.Hidden;
  lengthSourceText     @Common.Label: 'Length from';
  durationMin          @Common.Label: 'Duration'      @Measures.Unit: unitMin;
  weatherText          @Common.Label: 'Weather';
  temperatureC         @Common.Label: 'Temperature'   @Measures.Unit: unitC;
  apparentTemperatureC @Common.Label: 'Feels like'    @Measures.Unit: unitC;
  precipitationMm      @Common.Label: 'Precipitation' @Measures.Unit: unitMm;
  windKmh              @Common.Label: 'Wind'          @Measures.Unit: unitKmh;
  routeWkt             @UI.Hidden;
  startZone_ID         @UI.Hidden;
  endZone_ID           @UI.Hidden;
  unitM                @Common.IsUnit @UI.Hidden;
  unitMin              @Common.IsUnit @UI.Hidden;
  unitC                @Common.IsUnit @UI.Hidden;
  unitMm               @Common.IsUnit @UI.Hidden;
  unitKmh              @Common.IsUnit @UI.Hidden;
};

annotate service.Zones with {
  ID   @UI.Hidden;
  name @Common.Label: 'Zone';
};

annotate service.TripWeather with @(
  UI.LineItem: [
    { Value: hour }, { Value: weatherCode }, { Value: temperatureC }, { Value: apparentTemperatureC },
    { Value: precipitationMm }, { Value: windKmh }, { Value: windGustKmh }, { Value: cloudCoverPct }, { Value: humidityPct }
  ],
  UI.PresentationVariant: { SortOrder: [ { Property: hour } ], Visualizations: [ '@UI.LineItem' ] },
  Capabilities.SearchRestrictions.Searchable: false
) {
  trip_ID              @UI.Hidden;
  hour                 @Common.Label: 'Hour';
  weatherCode          @Common.Label: 'Condition' @Common.Text: { $value: weatherText, ![@UI.TextArrangement]: #TextOnly };
  weatherText          @Common.Label: 'Condition';
  temperatureC         @Common.Label: 'Temperature'   @Measures.Unit: unitC;
  apparentTemperatureC @Common.Label: 'Feels like'    @Measures.Unit: unitC;
  precipitationMm      @Common.Label: 'Precipitation' @Measures.Unit: unitMm;
  windKmh              @Common.Label: 'Wind'          @Measures.Unit: unitKmh;
  windGustKmh          @Common.Label: 'Gusts'         @Measures.Unit: unitKmh;
  cloudCoverPct        @Common.Label: 'Cloud cover'   @Measures.Unit: unitPct;
  humidityPct          @Common.Label: 'Humidity'      @Measures.Unit: unitPct;
  unitC                @Common.IsUnit @UI.Hidden;
  unitMm               @Common.IsUnit @UI.Hidden;
  unitKmh              @Common.IsUnit @UI.Hidden;
  unitPct              @Common.IsUnit @UI.Hidden;
};

annotate service.TripWorkouts with @(
  UI.LineItem: [
    { Value: name }, { Value: startedAt }, { Value: durationMin }, { Value: distanceM }, { Value: elevationUpM },
    { Value: activeEnergyKcal }, { Value: steps }, { Value: hrMin }, { Value: hrAvg }, { Value: hrMax }, { Value: temperatureC }
  ],
  Capabilities.SearchRestrictions.Searchable: false
) {
  trip_ID          @UI.Hidden;
  workout_ID       @UI.Hidden;
  name             @Common.Label: 'Workout';
  startedAt        @Common.Label: 'Start';
  durationMin      @Common.Label: 'Duration'     @Measures.Unit: unitMin;
  distanceM        @Common.Label: 'Distance'     @Measures.Unit: unitM;
  elevationUpM     @Common.Label: 'Elevation up' @Measures.Unit: unitM;
  activeEnergyKcal @Common.Label: 'Energy'       @Measures.Unit: unitKcal;
  steps            @Common.Label: 'Steps';
  hrMin            @Common.Label: 'HR min'       @Measures.Unit: unitBpm;
  hrAvg            @Common.Label: 'HR avg'       @Measures.Unit: unitBpm;
  hrMax            @Common.Label: 'HR max'       @Measures.Unit: unitBpm;
  temperatureC     @Common.Label: 'Temperature'  @Measures.Unit: unitC;
  overlapMin       @Common.Label: 'Overlap'      @Measures.Unit: unitMin;
  unitM            @Common.IsUnit @UI.Hidden;
  unitMin          @Common.IsUnit @UI.Hidden;
  unitC            @Common.IsUnit @UI.Hidden;
  unitBpm          @Common.IsUnit @UI.Hidden;
  unitKcal         @Common.IsUnit @UI.Hidden;
};

annotate service.TripMinutes with {
  hrAvg     @Common.Label: 'HR avg'   @Measures.Unit: unitBpm;
  hrMax     @Common.Label: 'HR max'   @Measures.Unit: unitBpm;
  altitudeM @Common.Label: 'Altitude' @Measures.Unit: unitM;
  speedKmh  @Common.Label: 'Speed'    @Measures.Unit: unitKmh;
  unitM     @Common.IsUnit @UI.Hidden;
  unitBpm   @Common.IsUnit @UI.Hidden;
  unitKmh   @Common.IsUnit @UI.Hidden;
};

annotate service.TripPhotos with {
  lat     @Common.Label: 'Latitude'  @Measures.Unit: unitDeg;
  lon     @Common.Label: 'Longitude' @Measures.Unit: unitDeg;
  unitDeg @Common.IsUnit @UI.Hidden;
};
