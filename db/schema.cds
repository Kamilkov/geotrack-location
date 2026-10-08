using { managed } from '@sap/cds/common';
namespace geotrack;

entity Positions {
  key device       : String(40);
  /** Position time from the phone clock (UTC) */
  key ts           : Timestamp;
  /** When the ingest received the message; refreshed on redelivery (UTC) */
      receivedAt   : Timestamp not null;
  /** When the row was written (UTC) */
      storedAt     : Timestamp not null;
  /** Latitude (deg, WGS84) */
  @title: 'Latitude (deg)' @Measures.Unit: 'deg'
      lat          : Decimal(9,6) not null;
  /** Longitude (deg, WGS84) */
  @title: 'Longitude (deg)' @Measures.Unit: 'deg'
      lon          : Decimal(9,6) not null;
  /** Position as ST_POINT, SRID 4326; set via native SQL on insert */
      point        : hana.ST_POINT(4326);
  /** GPS horizontal accuracy (m) */
  @title: 'Accuracy (m)' @Measures.Unit: 'm'
      accuracy     : Integer;
  /** Altitude above sea level (m) */
  @title: 'Altitude (m)' @Measures.Unit: 'm'
      altitude     : Integer;
  /** Speed (km/h) */
  @title: 'Velocity (km/h)' @Measures.Unit: 'km/h'
      velocity     : Integer;
  /** Course over ground (deg, 0 = north, clockwise) */
  @title: 'Course (deg)' @Measures.Unit: 'deg'
      course       : Integer;
  /** Battery level (%) */
  @title: 'Battery (%)' @Measures.Unit: '%'
      battery      : Integer;
  /** OwnTracks bs: 0 unknown, 1 unplugged, 2 charging, 3 full */
      batteryState : Integer;
  /** OwnTracks conn: w = WiFi, m = mobile, o = offline */
      connection   : String(1);
  /** WiFi SSID if connected */
      ssid         : String(64);
  /** Barometric pressure (kPa) */
  @title: 'Pressure (kPa)' @Measures.Unit: 'kPa'
      pressure     : Decimal(7,3);
  /** OwnTracks t: p ping, c circular region, b beacon, r report, u manual, t timer, v monitoring, m move */
      trigger      : String(1);
  /** Original OwnTracks JSON (lat/lon removed when coarsened) */
      raw          : LargeString;
}

entity Zones : managed {
  key ID           : UUID;
      name         : String(60) not null;
  /** circle | polygon */
      kind         : String(8) not null;
  /** Centre latitude (deg, WGS84); also the coarsening target for private zones */
  @title: 'Centre latitude (deg)' @Measures.Unit: 'deg'
      centreLat    : Decimal(9,6);
  /** Centre longitude (deg, WGS84) */
  @title: 'Centre longitude (deg)' @Measures.Unit: 'deg'
      centreLon    : Decimal(9,6);
  /** Circle radius (m) */
  @title: 'Radius (m)' @Measures.Unit: 'm'
      radiusM      : Integer;
  /** Polygon as WKT (lon lat order), input only */
      wkt          : LargeString;
  /** Zone geometry, SRID 4326; set via native SQL after create/update */
      geom         : hana.ST_GEOMETRY(4326);
  /** Home-like: forces trip boundaries */
      isBase       : Boolean default false;
  /** Positions inside are coarsened to the centre */
      isPrivate    : Boolean default false;
  /** Entering creates a SiteVisit on A4H */
      createsVisit : Boolean default false;
}

extend Positions with {
  zone_ID     : UUID;
  /** True when lat/lon were replaced by a private zone's centre */
  isCoarsened : Boolean default false;
  trip_ID     : UUID;
}

extend Positions with {
  /** Motion activities iOS reported with the fix, comma-separated, e.g. "stationary,automotive"; null when absent */
  activities : String(60);
}

extend Positions with {
  /** GPS vertical accuracy (m), OwnTracks' and the app's `vac`; outside zones a position worse than Settings.maxVerticalAccuracyOutsideM is ignored */
  @title: 'Vertical accuracy (m)' @Measures.Unit: 'm'
  verticalAccuracy : Integer;
}

entity ZoneEvents {
  key device      : String(40);
  key zone_ID     : UUID;
  /** enter | leave */
  key kind        : String(5);
  /** Event time (UTC) */
  key at          : Timestamp;
  /** Position that produced the event (UTC) */
      positionTS  : Timestamp;
  /** null | pending | created | closed | failed | superseded | passthrough */
      visitStatus : String(20);
  /** A4H VisitUUID */
      visitID     : UUID;
      attempts    : Integer default 0;
      lastError   : String(500);
}

entity Trips {
  key ID          : UUID;
      device      : String(40) not null;
  /** Trip start (UTC) */
      startedAt   : Timestamp not null;
  /** Trip end (UTC); null while open */
      endedAt     : Timestamp;
      startZone_ID : UUID;
      endZone_ID   : UUID;
      pointCount  : Integer;
  /** Route length (m) */
  @title: 'Length (m)' @Measures.Unit: 'm'
      lengthM     : Integer;
  /** What lengthM and the route were measured from: phone (OwnTracks positions) | watch (Apple Watch route) | mixed */
      lengthSource : String(8) default 'phone';
  /** Duration (min) */
  @title: 'Duration (min)' @Measures.Unit: 'min'
      durationMin : Integer;
  /** walk | drive | unknown */
      kind        : String(8);
  /** Route as LINESTRING, SRID 4326; set on close */
      route       : hana.ST_GEOMETRY(4326);
  /** Route as WKT text, for OData */
      routeWkt    : LargeString;
}

/** Hourly weather along a closed trip, from Open-Meteo (one row per UTC hour the trip spans) */
entity TripWeather {
  key trip_ID : UUID;
  /** Top of the UTC hour this row describes */
  key hour    : Timestamp;
  /** Latitude sent to Open-Meteo, rounded to 2 decimals (deg) */
  @title: 'Latitude (deg)' @Measures.Unit: 'deg'
      lat                  : Decimal(5,2);
  /** Longitude sent to Open-Meteo, rounded to 2 decimals (deg) */
  @title: 'Longitude (deg)' @Measures.Unit: 'deg'
      lon                  : Decimal(5,2);
  /** Elevation of the Open-Meteo grid cell (m) */
  @title: 'Elevation (m)' @Measures.Unit: 'm'
      elevationM           : Integer;
  /** forecast | archive */
      source               : String(8);
  /** Air temperature 2 m above ground (°C) */
  @title: 'Temperature (°C)' @Measures.Unit: '°C'
      temperatureC         : Decimal(4,1);
  /** Apparent temperature (°C) */
  @title: 'Feels like (°C)' @Measures.Unit: '°C'
      apparentTemperatureC : Decimal(4,1);
  /** Precipitation in the hour (mm) */
  @title: 'Precipitation (mm)' @Measures.Unit: 'mm'
      precipitationMm      : Decimal(5,2);
  /** Relative humidity 2 m above ground (%) */
  @title: 'Humidity (%)' @Measures.Unit: '%'
      humidityPct          : Integer;
  /** Cloud cover (%) */
  @title: 'Cloud cover (%)' @Measures.Unit: '%'
      cloudCoverPct        : Integer;
  /** Wind speed 10 m above ground (km/h) */
  @title: 'Wind (km/h)' @Measures.Unit: 'km/h'
      windKmh              : Decimal(5,1);
  /** Wind gusts 10 m above ground (km/h) */
  @title: 'Gusts (km/h)' @Measures.Unit: 'km/h'
      windGustKmh          : Decimal(5,1);
  /** Wind direction 10 m above ground, meteorological (deg) */
  @title: 'Wind direction (deg)' @Measures.Unit: 'deg'
      windDirectionDeg     : Integer;
  /** Surface pressure (hPa) */
  @title: 'Pressure (hPa)' @Measures.Unit: 'hPa'
      pressureHpa          : Decimal(6,1);
  /** WMO weather interpretation code */
      weatherCode          : Integer;
}

extend Trips with {
  /** Worst WMO weather code over the trip's hours */
      weatherCode          : Integer;
  /** Text for weatherCode, e.g. "clear sky", "light rain" */
      weatherText          : String(40);
  /** Mean air temperature over the trip's hours (°C) */
  @title: 'Temperature (°C)' @Measures.Unit: '°C'
      temperatureC         : Decimal(4,1);
  /** Mean apparent temperature over the trip's hours (°C) */
  @title: 'Feels like (°C)' @Measures.Unit: '°C'
      apparentTemperatureC : Decimal(4,1);
  /** Precipitation summed over the trip's hours (mm) */
  @title: 'Precipitation (mm)' @Measures.Unit: 'mm'
      precipitationMm      : Decimal(6,2);
  /** Max wind speed over the trip's hours (km/h) */
  @title: 'Wind (km/h)' @Measures.Unit: 'km/h'
      windKmh              : Decimal(5,1);
  /** When the weather rows were written (UTC); null = not enriched */
      weatherFetchedAt     : Timestamp;
  /** Failed fetch attempts since the last success or reset */
      weatherAttempts      : Integer default 0;
  /** Last fetch attempt (UTC), success or failure */
      weatherAttemptedAt   : Timestamp;
  /** Last fetch error text; null after success */
      weatherError         : String(500);
  /** Hourly weather rows */
      weather              : Composition of many TripWeather on weather.trip_ID = $self.ID;
}

entity Watermarks {
  key device            : String(40);
  /** Positions with ts <= this are segmented (UTC) */
      segmentedThroughTS : Timestamp;
      openTrip_ID       : UUID;
  /** Anchor: first position of the current stay; moves on movement > stillRadiusM (UTC) */
      anchorTS          : Timestamp;
  /** Anchor latitude (deg, WGS84) */
  @title: 'Anchor latitude (deg)' @Measures.Unit: 'deg'
      anchorLat         : Decimal(9,6);
  /** Anchor longitude (deg, WGS84) */
  @title: 'Anchor longitude (deg)' @Measures.Unit: 'deg'
      anchorLon         : Decimal(9,6);
      lastZone_ID       : UUID;
  /** Last position the segmenter accepted (UTC); leave events and trip starts use it */
      lastTS            : Timestamp;
  /** Segmenter motion and visit-stay state between runs, JSON; owned by srv/lib/segmenter.js */
      motionState       : LargeString;
}

entity Settings {
  key ID            : Integer;
  /** Stillness that closes a trip (min) */
  @title: 'Still minutes (min)' @Measures.Unit: 'min'
      stillMinutes  : Integer not null;
  /** Movement threshold (m) */
  @title: 'Still radius (m)' @Measures.Unit: 'm'
      stillRadiusM  : Integer not null;
      minTripPoints : Integer not null;
  /** Positions inside a zone, and Watch route points, less accurate than this are ignored (m) */
  @title: 'Max accuracy (m)' @Measures.Unit: 'm'
      maxAccuracyM  : Integer not null;
  /** How long a drive ↔ on-foot change must last to count (min) */
  @title: 'Mode minutes (min)' @Measures.Unit: 'min'
      modeMinutes   : Integer not null default 5;
  /** How long still time must last to end a trip (min) */
  @title: 'Stop minutes (min)' @Measures.Unit: 'min'
      stopMinutes   : Integer not null default 10;
  /** Path length an on-foot trip needs to be kept (m) */
  @title: 'Walk minimum (m)' @Measures.Unit: 'm'
      walkMinM      : Integer not null default 500;
  /** Longest silence between two positions that a trip may contain; 0 switches the rule off (min) */
  @title: 'Gap minutes (min)' @Measures.Unit: 'min'
      gapMinutes    : Integer not null default 15;
  /** Positions outside every zone less accurate than this are ignored; 0 means maxAccuracyM (m) */
  @title: 'Max accuracy outside zones (m)' @Measures.Unit: 'm'
      maxAccuracyOutsideM : Integer not null default 35;
  /** Positions outside every zone whose vertical accuracy is worse than this are ignored; 0 switches the rule off (m) */
  @title: 'Max vertical accuracy outside zones (m)' @Measures.Unit: 'm'
      maxVerticalAccuracyOutsideM : Integer not null default 100;
}

/** An Apple Watch workout as Health Auto Export sends it (REST API, export version 2) */
entity Workouts {
  /** The app's workout id */
  key ID                   : String(64);
      device               : String(40) not null;
  /** Workout type, e.g. "Outdoor Walk" */
      name                 : String(60);
  /** Workout start (UTC) */
      startedAt            : Timestamp not null;
  /** Workout end (UTC) */
      endedAt              : Timestamp not null;
  /** Duration (s) */
  @title: 'Duration (s)' @Measures.Unit: 's'
      durationS            : Integer;
  /** Distance (m) */
  @title: 'Distance (m)' @Measures.Unit: 'm'
      distanceM            : Integer;
  /** Active energy (kcal) */
  @title: 'Active energy (kcal)' @Measures.Unit: 'kcal'
      activeEnergyKcal     : Decimal(7,1);
  /** Elevation gained (m) */
  @title: 'Elevation up (m)' @Measures.Unit: 'm'
      elevationUpM         : Decimal(7,1);
      steps                : Integer;
  /** Lowest heart rate (bpm) */
  @title: 'Heart rate min (bpm)' @Measures.Unit: 'bpm'
      hrMin                : Integer;
  /** Mean heart rate (bpm) */
  @title: 'Heart rate avg (bpm)' @Measures.Unit: 'bpm'
      hrAvg                : Integer;
  /** Highest heart rate (bpm) */
  @title: 'Heart rate max (bpm)' @Measures.Unit: 'bpm'
      hrMax                : Integer;
  /** Temperature the Watch recorded (°C) */
  @title: 'Temperature (°C)' @Measures.Unit: '°C'
      temperatureC         : Decimal(4,1);
  /** Humidity the Watch recorded (%) */
  @title: 'Humidity (%)' @Measures.Unit: '%'
      humidityPct          : Integer;
      isIndoor             : Boolean;
  /** Rows in WorkoutHeartRate (both phases) */
      hrSamples            : Integer;
  /** Rows in WorkoutRoute */
      routePoints          : Integer;
  /** Route points replaced by a private zone's centre */
      routePointsCoarsened : Integer;
  /** First route point lies in a private zone */
      startsInPrivateZone  : Boolean;
  /** Last route point lies in a private zone */
      endsInPrivateZone    : Boolean;
  /** Last time the workout was stored (UTC) */
      receivedAt           : Timestamp;
  /** The workout JSON without route, heartRateData, heartRateRecovery, stepCount */
      raw                  : LargeString;
}

/** Heart-rate samples of a workout (phase workout) and of the recovery after it (phase recovery) */
entity WorkoutHeartRate {
  key workout_ID : String(64);
  /** workout | recovery */
  key phase      : String(8);
  /** Sample time (UTC) */
  key ts         : Timestamp;
  /** Lowest heart rate in the sample (bpm) */
  @title: 'Heart rate min (bpm)' @Measures.Unit: 'bpm'
      bpmMin     : Decimal(5,1);
  /** Mean heart rate in the sample (bpm) */
  @title: 'Heart rate avg (bpm)' @Measures.Unit: 'bpm'
      bpmAvg     : Decimal(5,1);
  /** Highest heart rate in the sample (bpm) */
  @title: 'Heart rate max (bpm)' @Measures.Unit: 'bpm'
      bpmMax     : Decimal(5,1);
  /** Recording device, e.g. "Apple Watch" */
      source     : String(60);
}

/** GPS route of a workout; points in a private zone are stored as the zone centre */
entity WorkoutRoute {
  key workout_ID          : String(64);
  /** Point time (UTC) */
  key ts                  : Timestamp;
  /** Latitude (deg, WGS84) */
  @title: 'Latitude (deg)' @Measures.Unit: 'deg'
      lat                 : Decimal(9,6) not null;
  /** Longitude (deg, WGS84) */
  @title: 'Longitude (deg)' @Measures.Unit: 'deg'
      lon                 : Decimal(9,6) not null;
  /** Point as ST_POINT, SRID 4326; set via native SQL after insert */
      point               : hana.ST_POINT(4326);
  /** Altitude above sea level (m); null when coarsened */
  @title: 'Altitude (m)' @Measures.Unit: 'm'
      altitudeM           : Decimal(7,1);
  /** Speed (m/s); null when coarsened or unknown */
  @title: 'Speed (m/s)' @Measures.Unit: 'm/s'
      speedMs             : Decimal(6,2);
  /** Course over ground (deg, 0 = north, clockwise); null when coarsened or unknown */
  @title: 'Course (deg)' @Measures.Unit: 'deg'
      courseDeg           : Integer;
  /** Horizontal accuracy (m) */
  @title: 'Horizontal accuracy (m)' @Measures.Unit: 'm'
      horizontalAccuracyM : Decimal(6,1);
  /** Vertical accuracy (m) */
  @title: 'Vertical accuracy (m)' @Measures.Unit: 'm'
      verticalAccuracyM   : Decimal(6,1);
      zone_ID             : UUID;
  /** True when lat/lon are a private zone's centre */
      isCoarsened         : Boolean default false;
}

/** Workouts linked to the trips of the same device they overlap in time; an open trip counts as ongoing */
define view WorkoutTrips as select from Workouts as w
  inner join Trips as t on t.device = w.device and t.startedAt < w.endedAt and (t.endedAt is null or t.endedAt > w.startedAt)
{
  key w.ID as workout_ID,
  key t.ID as trip_ID,
      w.name as workoutName,
      t.kind as tripKind,
      t.startedAt as tripStartedAt,
      t.endedAt as tripEndedAt,
  /** Time the workout and the trip overlap (s) */
  @title: 'Overlap (s)' @Measures.Unit: 's'
      seconds_between(greatest(w.startedAt, t.startedAt), least(w.endedAt, coalesce(t.endedAt, w.endedAt))) as overlapS : Integer
};

/** Workout heart rate per UTC minute (phase workout only) */
define view WorkoutMinuteHeartRate as select from WorkoutHeartRate {
  key workout_ID,
  key to_timestamp(to_varchar(ts, 'YYYY-MM-DD HH24:MI'), 'YYYY-MM-DD HH24:MI') as minuteTS : Timestamp,
      cast(avg(bpmAvg) as Decimal(5,1)) as hrAvg,
      max(bpmMax) as hrMax : Decimal(5,1),
      cast(count(*) as Integer) as hrSamples : Integer
} where phase = 'workout'
  group by workout_ID, to_timestamp(to_varchar(ts, 'YYYY-MM-DD HH24:MI'), 'YYYY-MM-DD HH24:MI');

/** Workout route per UTC minute; coarsened points excluded */
define view WorkoutMinuteRoute as select from WorkoutRoute {
  key workout_ID,
  key to_timestamp(to_varchar(ts, 'YYYY-MM-DD HH24:MI'), 'YYYY-MM-DD HH24:MI') as minuteTS : Timestamp,
      cast(avg(altitudeM) as Decimal(7,1)) as altitudeM,
      cast(avg(speedMs) as Decimal(6,2)) as speedMs,
      cast(count(*) as Integer) as routePoints : Integer
} where isCoarsened = false
  group by workout_ID, to_timestamp(to_varchar(ts, 'YYYY-MM-DD HH24:MI'), 'YYYY-MM-DD HH24:MI');

/** One row per workout and UTC minute: heart rate, altitude and speed side by side. Gradient: difference of neighbouring minutes. */
define view WorkoutMinutes as select from WorkoutMinuteHeartRate as h
  full outer join WorkoutMinuteRoute as r on r.workout_ID = h.workout_ID and r.minuteTS = h.minuteTS
{
  key coalesce(h.workout_ID, r.workout_ID) as workout_ID : String(64),
  /** Start of the UTC minute */
  key coalesce(h.minuteTS, r.minuteTS) as minuteTS : Timestamp,
  /** Mean heart rate in the minute (bpm) */
  @title: 'Heart rate avg (bpm)' @Measures.Unit: 'bpm'
      h.hrAvg,
  /** Highest heart rate in the minute (bpm) */
  @title: 'Heart rate max (bpm)' @Measures.Unit: 'bpm'
      h.hrMax,
      coalesce(h.hrSamples, 0) as hrSamples : Integer,
  /** Mean altitude in the minute (m) */
  @title: 'Altitude (m)' @Measures.Unit: 'm'
      r.altitudeM,
  /** Mean speed in the minute (m/s) */
  @title: 'Speed (m/s)' @Measures.Unit: 'm/s'
      r.speedMs,
      coalesce(r.routePoints, 0) as routePoints : Integer
};

/** An iPhone photo taken outside the private zones: metadata and a metadata-free thumbnail; the original stays on the owner's devices */
entity Photos {
  /** uuidv5 of camera model and time taken: a resend (HEIC or JPEG) replaces */
  key ID             : UUID;
      device         : String(40) not null;
  /** Time taken (UTC) */
      takenAt        : Timestamp not null;
  /** Original file name, e.g. IMG_1234.HEIC */
      fileName       : String(255);
  /** Camera model from EXIF, e.g. iPhone 16 Pro */
      cameraModel    : String(60);
  /** Latitude (deg, WGS84): the photo's GPS or the borrowed OwnTracks position */
  @title: 'Latitude (deg)' @Measures.Unit: 'deg'
      lat            : Decimal(9,6) not null;
  /** Longitude (deg, WGS84) */
  @title: 'Longitude (deg)' @Measures.Unit: 'deg'
      lon            : Decimal(9,6) not null;
  /** Position as ST_POINT, SRID 4326; set via native SQL */
      point          : hana.ST_POINT(4326);
  /** Altitude above sea level (m); null for a borrowed position */
  @title: 'Altitude (m)' @Measures.Unit: 'm'
      altitudeM      : Decimal(7,1);
  /** GPS horizontal positioning error (m); null for a borrowed position */
  @title: 'Accuracy (m)' @Measures.Unit: 'm'
      accuracyM      : Decimal(6,1);
  /** Camera direction (deg, 0 = north, clockwise); null for a borrowed position */
  @title: 'Direction (deg)' @Measures.Unit: 'deg'
      directionDeg   : Integer;
  /** photo | owntracks */
      positionSource : String(10);
  /** Public zone the photo lies in; private-zone photos are never stored */
      zone_ID        : UUID;
  /** Metadata-free JPEG, at most 800 px on the long edge */
  @Core.MediaType: 'image/jpeg'
      thumbnail      : LargeBinary;
  /** Thumbnail size (B) */
  @title: 'Thumbnail size (B)' @Measures.Unit: 'B'
      thumbnailBytes : Integer;
  /** Last time stored (UTC) */
      receivedAt     : Timestamp;
}

/** Each photo with the trip, workout, workout minute and weather hour it belongs to; empty links outside trips and workouts */
define view PhotoContext as select from Photos as p
  left outer join Trips as t on t.device = p.device and t.startedAt <= p.takenAt and (t.endedAt is null or t.endedAt > p.takenAt)
  left outer join Workouts as w on w.device = p.device and w.startedAt <= p.takenAt and w.endedAt > p.takenAt
{
  key p.ID as photo_ID,
      p.takenAt,
      t.ID as trip_ID,
      t.kind as tripKind,
      w.ID as workout_ID,
  /** Start of the UTC minute: joins WorkoutMinutes */
      to_timestamp(to_varchar(p.takenAt, 'YYYY-MM-DD HH24:MI'), 'YYYY-MM-DD HH24:MI') as minuteTS : Timestamp,
  /** Start of the UTC hour: joins TripWeather (with trip_ID) */
      to_timestamp(to_varchar(p.takenAt, 'YYYY-MM-DD HH24'), 'YYYY-MM-DD HH24') as weatherHour : Timestamp
};
