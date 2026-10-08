import Foundation

/// What the app remembers about one workout it sent. No route, no heart rate, no workout times.
public struct LedgerEntry: Codable, Equatable, Sendable {
    /// The workouts device name the last copy was sent under.
    public var device: String
    /// What a server has acknowledged for this workout, under any device name. A copy with less is never sent.
    public var floor: WorkoutContent?
    /// The last copy sent under `device`, acknowledged or rejected: a later copy goes out only when it has more.
    public var sent: WorkoutContent
    /// The server skipped the copy.
    public var rejected: Bool
    public var sentAt: Date
    /// What the server answered, for Status: the rows it stored, or its reason for skipping the copy.
    public var storedHeartRate: Int?
    public var storedRoute: Int?
    public var reason: String?

    public init(device: String, floor: WorkoutContent?, sent: WorkoutContent, rejected: Bool, sentAt: Date,
                storedHeartRate: Int? = nil, storedRoute: Int? = nil, reason: String? = nil) {
        self.device = device
        self.floor = floor
        self.sent = sent
        self.rejected = rejected
        self.sentAt = sentAt
        self.storedHeartRate = storedHeartRate
        self.storedRoute = storedRoute
        self.reason = reason
    }
}

/// The ledger's file: workout ID → entry.
public struct WorkoutLedger: Sendable {
    let url: URL

    public init(url: URL) { self.url = url }

    /// Empty when there is no file yet. Throws when the file is there but cannot be read (before the phone's
    /// first unlock) or is not a ledger: "not readable" must never be taken for "nothing sent yet", or every
    /// floor would be lost.
    public func load() throws -> [String: LedgerEntry] {
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        return try JSONDecoder().decode([String: LedgerEntry].self, from: Data(contentsOf: url))
    }

    public func save(_ entries: [String: LedgerEntry]) throws {
        try JSONEncoder().encode(entries).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// Which workouts go out. Pure: no clock, no file, no Health.
public enum WorkoutRule {
    /// A workout that changes later than this after its end goes out again only on "Send now".
    public static let window = 48.0 * 3600

    public enum Decision: Equatable, Sendable {
        case send
        /// Health shows less than a server has acknowledged: the copy would erase what is stored.
        case held
        case nothing
    }

    /// Whether the workout has to be read at all. One that was sent under this device name and ended more
    /// than 48 hours ago is looked at again only on "Send now".
    public static func worthReading(end: Date, entry: LedgerEntry?, device: String, now: Date, manual: Bool) -> Bool {
        guard let entry, entry.device == device else { return true }
        return manual || now.timeIntervalSince(end) < window
    }

    /// For a workout that is worth reading: what to do with the copy Health has now. "Send now" (`manual`)
    /// also sends a copy the server rejected, unchanged: the way to try it again after a fix on the server.
    public static func decide(content: WorkoutContent, entry: LedgerEntry?, device: String, manual: Bool) -> Decision {
        if let floor = entry?.floor, content.lacks(floor) { return .held }
        guard let entry, entry.device == device else { return .send }
        if entry.rejected && manual { return .send }
        return content.exceeds(entry.sent) ? .send : .nothing
    }
}
