using { geotrack } from '../db/schema';

// Local-only MCP surface (slice 5b): served by `npm run ui` on the Mac, never by the VPS container
// (agent/ is not a default model root and is excluded from the Docker image). No coordinates leave
// through it: the views list every field the model can see.

context geoagent {
  /** Linked workouts per trip, for the Trips view's workoutCount */
  entity TripWorkoutCounts as select from geotrack.WorkoutTrips {
    key trip_ID,
        count(*) as workouts : Integer
  } group by trip_ID;
}

/**
 * The owner's own movement history from his iPhone (OwnTracks) and Apple Watch, stored in SAP HANA
 * Cloud: trips, zone stays, workouts and weather. Read-only, no coordinates.
 */
@mcp: 'geotrack'
@mcp.instructions: 'Real data: one person''s (the owner''s) own trips, zone stays, Apple Watch workouts and weather. Distances are metres (answer in km above 1000 m), durations minutes unless a field says seconds, temperatures °C, rain mm, wind km/h, heart rate bpm. totals, zoneStats, tripsNear and tripDetail take local dates (YYYY-MM-DD, inclusive) and return local times with UTC offset; query returns UTC times. Use totals for sums per day/week/month/year, zoneStats for places and visits (zones are named, e.g. Home, Supermarket), tripsNear(lat, lon, radiusM) for trips near a place whose coordinates you know, tripDetail(ID) for one trip with its hourly weather, workouts and zone stays, and query on Trips, Workouts or Zones for lists and filters. Say clearly when nothing matches; never invent figures.'
@readonly
@cds.query.limit: { default: 20, max: 100 }
service GeoAgentService {
  /**
   * One trip (walk, drive or unknown) between two stops; endedAt null while open. Times UTC.
   * lengthM metres, measured from lengthSource: phone (OwnTracks positions, one every 50 m, reads
   * short on winding paths), watch (Apple Watch GPS, one point per second) or mixed.
   * durationMin minutes; startZone/endZone zone names or null; weather over the
   * trip's hours: weatherText worst condition, temperatureC and apparentTemperatureC mean °C,
   * precipitationMm total mm, windKmh max km/h; workoutCount linked Apple Watch workouts.
   */
  entity Trips as select from geotrack.Trips as t
    left join geotrack.Zones as sz on sz.ID = t.startZone_ID
    left join geotrack.Zones as ez on ez.ID = t.endZone_ID
    left join geoagent.TripWorkoutCounts as wc on wc.trip_ID = t.ID
  {
    key t.ID,
        t.startedAt,
        t.endedAt,
        t.kind,
        t.lengthM,
        t.lengthSource,
        t.durationMin,
        sz.name as startZone : String(60),
        ez.name as endZone   : String(60),
        t.weatherText,
        t.temperatureC,
        t.apparentTemperatureC,
        t.precipitationMm,
        t.windKmh,
        coalesce(wc.workouts, 0) as workoutCount : Integer
  } where t.device not like 'smoke%';

  /**
   * One Apple Watch workout, e.g. "Hiking". Times UTC. durationMin minutes, distanceM metres,
   * activeEnergyKcal kcal, elevationUpM metres climbed, steps, hrMin/hrAvg/hrMax bpm,
   * temperatureC °C and humidityPct % as the Watch recorded them.
   */
  entity Workouts as select from geotrack.Workouts {
    key ID,
        name,
        startedAt,
        endedAt,
        cast(round(durationS / 60.0, 0) as Integer) as durationMin : Integer,
        distanceM,
        activeEnergyKcal,
        elevationUpM,
        steps,
        hrMin,
        hrAvg,
        hrMax,
        temperatureC,
        humidityPct
  } where device not like 'smoke%' and device not like 'trial%';

  /** A named zone. isBase: Home-like; isPrivate: positions inside are coarsened; createsVisit: stays become site visits */
  entity Zones as select from geotrack.Zones { key ID, name, isBase, isPrivate, createsVisit };

  type PeriodTotals {
    period      : String(10);
    kind        : String(8);
    trips       : Integer;
    distanceM   : Integer;
    durationMin : Integer;
  }

  type Stay {
    arrivedAt   : String(25);
    leftAt      : String(25);
    durationMin : Integer;
    status      : String(12);
  }

  type ZoneStats {
    zone          : String(60);
    createsVisit  : Boolean;
    visits        : Integer;
    passthroughs  : Integer;
    stays         : Integer;
    totalMin      : Integer;
    firstArrival  : String(25);
    lastArrival   : String(25);
    lastDeparture : String(25);
    latest        : many Stay;
  }

  type NearbyTrip {
    ID        : UUID;
    startedAt : String(25);
    endedAt   : String(25);
    kind      : String(8);
    lengthM   : Integer;
    closestM  : Decimal(9, 1);
    closestAt : String(25);
  }

  type HourWeather {
    hour                 : String(25);
    weatherText          : String(40);
    temperatureC         : Decimal(4, 1);
    apparentTemperatureC : Decimal(4, 1);
    precipitationMm      : Decimal(5, 2);
    windKmh              : Decimal(5, 1);
    windGustKmh          : Decimal(5, 1);
    cloudCoverPct        : Integer;
    humidityPct          : Integer;
  }

  type TripWorkout {
    name             : String(60);
    startedAt        : String(25);
    endedAt          : String(25);
    durationMin      : Integer;
    distanceM        : Integer;
    activeEnergyKcal : Decimal(7, 1);
    elevationUpM     : Decimal(7, 1);
    steps            : Integer;
    hrMin            : Integer;
    hrAvg            : Integer;
    hrMax            : Integer;
    temperatureC     : Decimal(4, 1);
    humidityPct      : Integer;
    overlapMin       : Integer;
  }

  type TripZoneStay {
    zone      : String(60);
    arrivedAt : String(25);
    leftAt    : String(25);
    status    : String(12);
  }

  type TripDetail {
    ID                   : UUID;
    startedAt            : String(25);
    endedAt              : String(25);
    kind                 : String(8);
    lengthM              : Integer;
    lengthSource         : String(8);
    durationMin          : Integer;
    startZone            : String(60);
    endZone              : String(60);
    weatherText          : String(40);
    temperatureC         : Decimal(4, 1);
    apparentTemperatureC : Decimal(4, 1);
    precipitationMm      : Decimal(6, 2);
    windKmh              : Decimal(5, 1);
    weather              : many HourWeather;
    workouts             : many TripWorkout;
    zoneStays            : many TripZoneStay;
  }

  /**
   * Trips, distance and time per period and kind, for closed trips whose local start date lies in
   * from..to. Rows { period, kind, trips, distanceM (metres), durationMin (minutes) }, sorted by
   * period, then kind. period is 'YYYY-MM-DD' (day), 'YYYY-Www' (ISO week, Monday start),
   * 'YYYY-MM' (month), 'YYYY' (year) or 'all'. With kind 'all' every period has one row per kind
   * present (walk, drive, unknown) plus an 'all' row with their sum; with walk or drive only that
   * kind. Empty list when nothing matches
   */
  function totals(
    /** Inclusive local start date YYYY-MM-DD; give together with to, or omit both for all trips */
    from : String,
    /** Inclusive local end date YYYY-MM-DD */
    to : String,
    /** 'day', 'week', 'month' (default), 'year' or 'all' */
    groupBy : String,
    /** 'walk', 'drive' or 'all' (default) */
    kind : String
  ) returns array of PeriodTotals;

  /**
   * One zone's stays whose local arrival date lies in from..to. visits: stays that became site
   * visits; passthroughs: drive-bys never confirmed on foot; stays: plain stays (e.g. Home);
   * totalMin: minutes spent, passthroughs excluded; firstArrival, lastArrival, lastDeparture: local
   * times, passthroughs excluded, null when none; latest: up to 20 most recent stays of every
   * status, newest first, each { arrivedAt, leftAt (null while still there), durationMin (up to now
   * while still there), status visit|passthrough|stay }. Rejects an unknown zone and lists the
   * known ones
   */
  function zoneStats(
    /** Zone name, case-insensitive, e.g. 'Supermarket' */
    zone : String @mandatory,
    /** Inclusive local start date YYYY-MM-DD; give together with to, or omit both for all time */
    from : String,
    /** Inclusive local end date YYYY-MM-DD */
    to : String
  ) returns ZoneStats;

  /**
   * Closed trips that came within radiusM metres of the point, closest first, at most 50. closestM
   * is the distance in metres from the point to the trip's closest recorded position, closestAt the
   * local time of that position; startedAt/endedAt local; lengthM metres; ID for tripDetail. Empty
   * list when none qualifies
   */
  function tripsNear(
    /** Latitude in WGS84 degrees, -90..90 */
    lat : Double @mandatory,
    /** Longitude in WGS84 degrees, -180..180 */
    lon : Double @mandatory,
    /** Radius in metres, 1..50000, default 500 */
    radiusM : Integer,
    /** Inclusive local start date YYYY-MM-DD; give together with to, or omit both */
    from : String,
    /** Inclusive local end date YYYY-MM-DD */
    to : String,
    /** 'walk', 'drive' or 'all' (default) */
    kind : String
  ) returns array of NearbyTrip;

  /**
   * One trip with the Trips fields (times local), its hourly weather (hour local, weatherText,
   * temperatureC and apparentTemperatureC °C, precipitationMm mm, windKmh and windGustKmh km/h,
   * cloudCoverPct and humidityPct %), its overlapping Apple Watch workouts (the Workouts fields
   * plus overlapMin, the minutes shared with the trip) and the zone stays that began during it
   * ({ zone, arrivedAt, leftAt, status visit|passthrough|stay }, the arrival at the destination
   * included). Open trips allowed. Rejects unknown IDs with 'Trip not found'
   */
  function tripDetail(
    /** Trip ID from query on Trips or from tripsNear */
    ID : UUID @mandatory
  ) returns TripDetail;
}
