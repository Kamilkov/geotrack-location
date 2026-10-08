import Foundation

/// One workout as Health has it, in plain values. No HealthKit types, so it is testable on a Mac.
public struct Workout: Equatable, Sendable {
    public struct HeartRate: Equatable, Sendable {
        public var time: Date
        public var bpm: Double
        public var source: String?

        public init(time: Date, bpm: Double, source: String? = nil) {
            self.time = time
            self.bpm = bpm
            self.source = source
        }
    }

    /// One point of the route. A value iOS marks as not available is nil.
    public struct RoutePoint: Equatable, Sendable {
        public var time: Date
        public var lat: Double
        public var lon: Double
        public var horizontalAccuracy: Double
        public var altitude: Double?
        public var verticalAccuracy: Double?
        public var speed: Double?
        public var speedAccuracy: Double?
        public var course: Double?
        public var courseAccuracy: Double?

        /// From the values iOS gives, where a negative number means "not available". nil when iOS marks the
        /// fix itself invalid (negative horizontal accuracy). An altitude without a valid vertical accuracy
        /// is not known either.
        public init?(time: Date, lat: Double, lon: Double, horizontalAccuracy: Double, altitude: Double, verticalAccuracy: Double,
                     speed: Double, speedAccuracy: Double, course: Double, courseAccuracy: Double) {
            func known(_ v: Double) -> Double? { v.isFinite && v >= 0 ? v : nil }
            guard let horizontal = known(horizontalAccuracy), lat.isFinite, lon.isFinite else { return nil }
            self.time = time
            self.lat = lat
            self.lon = lon
            self.horizontalAccuracy = horizontal
            self.verticalAccuracy = known(verticalAccuracy)
            self.altitude = self.verticalAccuracy != nil && altitude.isFinite ? altitude : nil
            self.speed = known(speed)
            self.speedAccuracy = known(speedAccuracy)
            self.course = known(course)
            self.courseAccuracy = known(courseAccuracy)
        }
    }

    /// Health's own UUID of the workout, upper case.
    public var id: String
    /// HealthKit's number for the activity type (HKWorkoutActivityType).
    public var activityType: UInt
    public var start: Date
    public var end: Date
    /// Seconds.
    public var duration: Double
    public var isIndoor: Bool?
    public var distanceM: Double?
    public var activeEnergyKcal: Double?
    public var elevationUpM: Double?
    public var temperatureC: Double?
    public var humidityPct: Double?
    public var hrMin: Double?
    public var hrAvg: Double?
    public var hrMax: Double?
    public var steps: Double?
    /// From the start to the end.
    public var heartRate: [HeartRate]
    /// The 180 s after the end.
    public var recovery: [HeartRate]
    public var route: [RoutePoint]

    public init(id: String, activityType: UInt, start: Date, end: Date, duration: Double, isIndoor: Bool? = nil, distanceM: Double? = nil,
                activeEnergyKcal: Double? = nil, elevationUpM: Double? = nil, temperatureC: Double? = nil, humidityPct: Double? = nil,
                hrMin: Double? = nil, hrAvg: Double? = nil, hrMax: Double? = nil, steps: Double? = nil,
                heartRate: [HeartRate] = [], recovery: [HeartRate] = [], route: [RoutePoint] = []) {
        self.id = id; self.activityType = activityType; self.start = start; self.end = end; self.duration = duration
        self.isIndoor = isIndoor; self.distanceM = distanceM; self.activeEnergyKcal = activeEnergyKcal; self.elevationUpM = elevationUpM
        self.temperatureC = temperatureC; self.humidityPct = humidityPct; self.hrMin = hrMin; self.hrAvg = hrAvg; self.hrMax = hrMax
        self.steps = steps; self.heartRate = heartRate; self.recovery = recovery; self.route = route
    }

    /// How long after the end heart rate counts as recovery.
    public static let recoverySeconds = 180.0
}

/// What a copy of a workout holds: three counts and which summary values are there. Never a value itself.
public struct WorkoutContent: Codable, Equatable, Sendable {
    public var heartRate: Int
    public var recovery: Int
    public var route: Int
    public var summary: Set<String>

    public init(heartRate: Int, recovery: Int, route: Int, summary: Set<String>) {
        self.heartRate = heartRate
        self.recovery = recovery
        self.route = route
        self.summary = summary
    }

    /// True when this copy has less than `floor` in any respect: a lower count, or a summary value gone.
    public func lacks(_ floor: WorkoutContent) -> Bool {
        heartRate < floor.heartRate || recovery < floor.recovery || route < floor.route || !floor.summary.isSubset(of: summary)
    }

    /// True when this copy has more than `other` in any respect: a higher count, or a summary value `other` has not.
    public func exceeds(_ other: WorkoutContent) -> Bool {
        heartRate > other.heartRate || recovery > other.recovery || route > other.route || !summary.isSubset(of: other.summary)
    }
}

extension Workout {
    public var content: WorkoutContent {
        let values: [(String, Bool)] = [
            ("distance", distanceM != nil), ("energy", activeEnergyKcal != nil), ("elevation", elevationUpM != nil),
            ("temperature", temperatureC != nil), ("humidity", humidityPct != nil), ("indoor", isIndoor != nil),
            ("hrMin", hrMin != nil), ("hrAvg", hrAvg != nil), ("hrMax", hrMax != nil), ("steps", steps != nil),
        ]
        return WorkoutContent(heartRate: heartRate.count, recovery: recovery.count, route: route.count,
                              summary: Set(values.filter(\.1).map(\.0)))
    }
}
