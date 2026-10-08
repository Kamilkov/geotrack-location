import Foundation

public enum Mode: String, CaseIterable, Sendable {
    /// Records and uploads after every kept position.
    case auto
    /// Records; uploads only on "Send now".
    case manual
    /// Location and motion sensors off.
    case paused

    private static let key = "mode"

    public var records: Bool { self != .paused }

    public static func stored(in defaults: UserDefaults = .standard) -> Mode {
        defaults.string(forKey: key).flatMap(Mode.init(rawValue:)) ?? .auto
    }

    public func store(in defaults: UserDefaults = .standard) {
        defaults.set(rawValue, forKey: Mode.key)
    }
}
