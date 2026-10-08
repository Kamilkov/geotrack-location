import Foundation

/// The base zone as the server names it in every positions answer: a circle the phone sleeps in. Inside it
/// the recorder keeps the GPS off and lets iOS watch the edge; the first fix after the edge is marked as
/// OwnTracks' region trigger, so the server starts the trip there, from Home.
public struct HomeZone: Codable, Equatable, Sendable {
    public var lat: Double
    public var lon: Double
    public var radiusM: Double

    public init(lat: Double, lon: Double, radiusM: Double) {
        self.lat = lat
        self.lon = lon
        self.radiusM = radiusM
    }

    public var centre: Fix { Fix(time: .distantPast, lat: lat, lon: lon) }

    public func contains(_ fix: Fix) -> Bool { KeepRule.metres(centre, fix) <= radiusM }

    private static let key = "homeZone"

    /// The zone the last answer named, or nil when none did (or none was ever received).
    public static func stored(in defaults: UserDefaults = .standard) -> HomeZone? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(HomeZone.self, from: $0) }
    }

    public func store(in defaults: UserDefaults = .standard) { HomeZone.store(self, in: defaults) }

    /// nil forgets the zone: a server that names none means there is nowhere to sleep.
    public static func store(_ zone: HomeZone?, in defaults: UserDefaults = .standard) {
        if let zone, let data = try? JSONEncoder().encode(zone) { defaults.set(data, forKey: key) } else { defaults.removeObject(forKey: key) }
    }
}

/// When the recorder sleeps: the phone has had no network at all (airplane mode with every radio off) for
/// `offlineGrace` while its last fix lay inside Home. Offline elsewhere, a dead zone on a hike, is no reason.
public enum HomeSleep {
    public static let offlineGrace: TimeInterval = 60

    public static func shouldSleep(offlineSince: Date?, now: Date, insideHome: Bool) -> Bool {
        guard insideHome, let offlineSince else { return false }
        return now.timeIntervalSince(offlineSince) >= offlineGrace
    }
}
