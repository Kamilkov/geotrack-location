import Foundation

/// A kept position, as far as the keep rule needs it.
public struct Fix: Equatable, Sendable, Codable {
    public var time: Date
    public var lat: Double
    public var lon: Double

    public init(time: Date, lat: Double, lon: Double) {
        self.time = time
        self.lat = lat
        self.lon = lon
    }
}

/// Which of the fixes iOS delivers become positions: OwnTracks' Move-mode rhythm, 50 m or 300 s.
public enum KeepRule {
    public static let distanceM = 50.0
    public static let intervalS = 300.0

    public enum Decision: Equatable, Sendable {
        /// 50 m or more from the last kept position (or there is none yet).
        case keepForDistance
        /// 300 s or more since the last kept position.
        case keepForTime
        /// Valid, but neither limit is reached: not stored anywhere.
        case thin
        /// iOS marks it invalid, or it is not newer than the last kept position.
        case refuse
    }

    public static func decide(last: Fix?, candidate: Fix, horizontalAccuracy: Double) -> Decision {
        if horizontalAccuracy < 0 { return .refuse }
        guard let last else { return .keepForDistance }
        // The server's key is the whole second: two positions in one second would be one row.
        if Int(candidate.time.timeIntervalSince1970) <= Int(last.time.timeIntervalSince1970) { return .refuse }
        if metres(last, candidate) >= distanceM { return .keepForDistance }
        if candidate.time.timeIntervalSince(last.time) >= intervalS { return .keepForTime }
        return .thin
    }

    /// Great-circle distance in metres (the server's haversineM).
    public static func metres(_ a: Fix, _ b: Fix) -> Double {
        let r = 6371008.8, rad = Double.pi / 180
        let dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad
        let h = sin(dLat / 2) * sin(dLat / 2) + cos(a.lat * rad) * cos(b.lat * rad) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(sqrt(h))
    }
}
