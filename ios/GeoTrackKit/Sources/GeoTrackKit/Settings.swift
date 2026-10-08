import Foundation

/// What Setup asks for. The app keeps it in the Keychain, never in code or in the repo.
public struct Settings: Codable, Hashable, Sendable {
    public var server = ""
    public var token = ""
    public var device = "trial-iphone"
    /// The device name workouts are sent under; apart from `device`, so that the two trials end independently.
    public var workoutsDevice = "trial-iphone"
    /// Workouts that start before this are not sent.
    public var workoutsSince = Settings.geoTrackBegan

    /// 2026-09-22T00:00:00Z, the first day GeoTrack has positions.
    public static let geoTrackBegan = Date(timeIntervalSince1970: 1_790_035_200)

    public init() {}

    /// A field that is missing takes its default: settings saved by an earlier version of the app must not
    /// be taken for unreadable and replaced by the defaults.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        server = try c.decodeIfPresent(String.self, forKey: .server) ?? server
        token = try c.decodeIfPresent(String.self, forKey: .token) ?? token
        device = try c.decodeIfPresent(String.self, forKey: .device) ?? device
        workoutsDevice = try c.decodeIfPresent(String.self, forKey: .workoutsDevice) ?? workoutsDevice
        workoutsSince = try c.decodeIfPresent(Date.self, forKey: .workoutsSince) ?? workoutsSince
    }

    public var serverConfig: ServerConfig? { ServerConfig(server: server, token: token, device: device) }
    public var workoutsConfig: ServerConfig? { ServerConfig(server: server, token: token, device: workoutsDevice) }
}
