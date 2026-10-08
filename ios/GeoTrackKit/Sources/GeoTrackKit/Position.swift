import Foundation

/// What the sensors said at one fix, in iOS's units. No CoreLocation types, so it is testable on a Mac.
public struct Sample: Equatable, Sendable {
    public var time: Date
    public var lat: Double
    public var lon: Double
    /// Metres; negative means iOS marks the fix invalid.
    public var horizontalAccuracy: Double
    public var altitude: Double?
    public var verticalAccuracy: Double?
    /// Metres per second; negative means iOS does not know it (as for course, the accuracies and the battery level).
    public var speed: Double?
    public var speedAccuracy: Double?
    /// Degrees, 0 = north.
    public var course: Double?
    public var courseAccuracy: Double?
    /// 0...1.
    public var batteryLevel: Double?
    /// OwnTracks' bs: 0 unknown, 1 unplugged, 2 charging, 3 full.
    public var batteryState: Int?
    /// "w", "m" or "o".
    public var connection: String?
    public var pressureKPa: Double?
    public var activities: [String]
    /// "low", "medium" or "high".
    public var motionConfidence: String?

    public init(time: Date, lat: Double, lon: Double, horizontalAccuracy: Double, altitude: Double? = nil,
                verticalAccuracy: Double? = nil, speed: Double? = nil, speedAccuracy: Double? = nil, course: Double? = nil,
                courseAccuracy: Double? = nil, batteryLevel: Double? = nil, batteryState: Int? = nil, connection: String? = nil,
                pressureKPa: Double? = nil, activities: [String] = [], motionConfidence: String? = nil) {
        self.time = time; self.lat = lat; self.lon = lon; self.horizontalAccuracy = horizontalAccuracy
        self.altitude = altitude; self.verticalAccuracy = verticalAccuracy; self.speed = speed; self.speedAccuracy = speedAccuracy
        self.course = course; self.courseAccuracy = courseAccuracy; self.batteryLevel = batteryLevel; self.batteryState = batteryState
        self.connection = connection; self.pressureKPa = pressureKPa; self.activities = activities; self.motionConfidence = motionConfidence
    }

    public var fix: Fix { Fix(time: time, lat: lat, lon: lon) }
}

/// One position as the server takes it: OwnTracks' JSON shape plus vac, sacc, cacc and mconf.
/// A value the phone does not have is left out (nil is not encoded).
public struct Position: Codable, Equatable, Sendable {
    public var type = "location"
    public var tst: Int
    public var lat: Double
    public var lon: Double
    public var acc: Int?
    public var alt: Int?
    public var vac: Int?
    public var vel: Int?
    public var cog: Int?
    public var batt: Int?
    public var bs: Int?
    public var conn: String?
    public var p: Double?
    public var t: String?
    public var motionactivities: [String]?
    public var mconf: String?
    public var sacc: Double?
    public var cacc: Double?

    enum CodingKeys: String, CodingKey {
        case type = "_type"
        case tst, lat, lon, acc, alt, vac, vel, cog, batt, bs, conn, p, t, motionactivities, mconf, sacc, cacc
    }

    /// `wokeFromHome`: the first fix after Home sleep, marked as OwnTracks' region trigger "c" (it outranks "t").
    public init(sample s: Sample, keptForTime: Bool, wokeFromHome: Bool = false) {
        func rounded(_ v: Double, to places: Double) -> Double { let f = pow(10, places); return (v * f).rounded() / f }
        func int(_ v: Double?) -> Int? { v.map { Int($0.rounded()) } }
        /// iOS reports "not available" as a negative number. Such a value is left out, as is one that is not finite.
        func known(_ v: Double?) -> Double? { v.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } }
        let vertical = known(s.verticalAccuracy)
        tst = Int(s.time.timeIntervalSince1970)
        lat = rounded(s.lat, to: 6)
        lon = rounded(s.lon, to: 6)
        acc = int(known(s.horizontalAccuracy))
        // An altitude may be negative (below sea level); it is unknown only when iOS marks its accuracy as not available.
        alt = s.verticalAccuracy != nil && vertical == nil ? nil : int(s.altitude.flatMap { $0.isFinite ? $0 : nil })
        vac = int(vertical)
        vel = int(known(s.speed).map { $0 * 3.6 })
        cog = int(known(s.course))
        batt = int(known(s.batteryLevel).map { $0 * 100 })
        bs = s.batteryState
        conn = s.connection
        p = known(s.pressureKPa).map { rounded($0, to: 3) }
        t = wokeFromHome ? "c" : keptForTime ? "t" : nil
        motionactivities = s.activities.isEmpty ? nil : s.activities
        mconf = s.motionConfidence
        sacc = known(s.speedAccuracy).map { rounded($0, to: 1) }
        cacc = known(s.courseAccuracy).map { rounded($0, to: 1) }
    }
}
