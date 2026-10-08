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

    /// Wider than this is no home: a server's circle turns the GPS off inside it.
    static let maxRadiusM = 1000.0

    /// This zone when it is a place on Earth and a home's size; nil otherwise, and the phone never sleeps in it.
    var usable: HomeZone? {
        (-90...90).contains(lat) && (-180...180).contains(lon) && radiusM > 0 && radiusM <= HomeZone.maxRadiusM ? self : nil
    }

    /// The zone the last answer named, or nil when none did (or none was ever received).
    public static func stored(at url: URL) -> HomeZone? {
        (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(HomeZone.self, from: $0) }
    }

    /// In a file kept out of backups, as the queue is: the centre is home. nil forgets the zone: a server that
    /// names none means there is nowhere to sleep.
    public static func store(_ zone: HomeZone?, at url: URL) {
        guard let zone, let data = try? JSONEncoder().encode(zone) else { try? FileManager.default.removeItem(at: url); return }
        do {
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            var file = url
            try file.setResourceValues(values)
        } catch { try? FileManager.default.removeItem(at: url) } // not kept out of backups: not kept at all
    }

    /// Versions up to 1.0 (1) kept the zone in UserDefaults, which backups carry.
    public static func removeLegacy(from defaults: UserDefaults = .standard) { defaults.removeObject(forKey: "homeZone") }
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
