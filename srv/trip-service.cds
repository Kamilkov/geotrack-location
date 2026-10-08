using { geotrack } from '../db/schema';

/** Trips for the Fiori app (slice 5a): read-only but for deletePhoto. On the VPS behind Caddy, on the Mac by `npm run ui`. */
@path: '/trips'

service TripService {
  @readonly entity Trips as projection on geotrack.Trips {
    ID, startedAt, endedAt, kind,
    case kind when 'walk' then 'Walk' when 'drive' then 'Drive' else 'Unknown' end as kindText : String(10),
    lengthM, durationMin, weatherText, temperatureC, apparentTemperatureC, precipitationMm, windKmh,
    lengthSource,
    case when lengthM is null then null when lengthSource = 'watch' then 'Watch'
         when lengthSource = 'mixed' then 'Watch and phone' else 'Phone' end as lengthSourceText : String(20),
    routeWkt,
    startZone_ID, endZone_ID,
    startZone : Association to Zones on startZone.ID = startZone_ID,
    endZone   : Association to Zones on endZone.ID = endZone_ID,
    weather,
    workouts  : Association to many TripWorkouts on workouts.trip_ID = ID,
    minutes   : Association to many TripMinutes on minutes.trip_ID = ID,
    photos    : Association to many TripPhotos on photos.trip_ID = ID,
    'm'    as unitM    : String(4),
    'min'  as unitMin  : String(4),
    '°C'   as unitC    : String(4),
    'mm'   as unitMm   : String(4),
    'km/h' as unitKmh  : String(4)
  };

  @readonly entity Zones as projection on geotrack.Zones { ID, name };

  @readonly entity TripWeather as projection on geotrack.TripWeather {
    trip_ID, hour, temperatureC, apparentTemperatureC, precipitationMm, windKmh, windGustKmh,
    cloudCoverPct, humidityPct, weatherCode,
    virtual null as weatherText : String(40),
    '°C'   as unitC    : String(4),
    'mm'   as unitMm   : String(4),
    'km/h' as unitKmh  : String(4),
    '%'    as unitPct  : String(4)
  };

  @readonly entity TripWorkouts as select from geotrack.WorkoutTrips as wt
    inner join geotrack.Workouts as w on w.ID = wt.workout_ID {
    key wt.trip_ID, key wt.workout_ID,
    w.name, w.startedAt,
    cast(round(w.durationS / 60.0, 0) as Integer) as durationMin : Integer,
    w.distanceM, w.activeEnergyKcal, w.elevationUpM, w.steps, w.hrMin, w.hrAvg, w.hrMax, w.temperatureC,
    cast(round(wt.overlapS / 60.0, 0) as Integer) as overlapMin : Integer,
    'm'    as unitM    : String(4),
    'min'  as unitMin  : String(4),
    '°C'   as unitC    : String(4),
    'bpm'  as unitBpm  : String(4),
    'kcal' as unitKcal : String(4)
  };

  @readonly @cds.query.limit: { default: 2000, max: 5000 } // ponytail: ~33 h of minutes; downsample server-side if a longer workout ever shows up
  entity TripMinutes as select from geotrack.WorkoutMinutes as m
    inner join geotrack.WorkoutTrips as wt on wt.workout_ID = m.workout_ID {
    key wt.trip_ID, key m.workout_ID, key m.minuteTS,
    m.hrAvg, m.hrMax, m.altitudeM,
    cast(m.speedMs * 3.6 as Decimal(6,1)) as speedKmh : Decimal(6,1),
    'm'    as unitM    : String(4),
    'bpm'  as unitBpm  : String(4),
    'km/h' as unitKmh  : String(4)
  };

  // Joined directly to Trips (not via PhotoContext, which also left-joins Workouts and would
  // duplicate a photo's key ID when two workouts overlap it).
  @readonly entity TripPhotos as select from geotrack.Photos as p
    left outer join geotrack.Trips as t on t.device = p.device and t.startedAt <= p.takenAt and (t.endedAt is null or t.endedAt > p.takenAt) {
    key p.ID, t.ID as trip_ID, p.takenAt, p.fileName, p.lat, p.lon, p.positionSource, p.thumbnail,
    'deg' as unitDeg : String(4)
  } where t.ID is not null;

  /** The one write: deletes a stored photo (row and thumbnail); the original stays on the phone. */
  action deletePhoto(ID : UUID not null);
}
