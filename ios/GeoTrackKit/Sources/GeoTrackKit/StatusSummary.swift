import Foundation

/// What Status says first: whether the app records, and what keeps it from working as it should.
public struct StatusSummary: Equatable, Sendable {
    public enum Location: Sendable { case always, whenInUse, denied, notAsked }
    public enum BackgroundRefresh: Sendable { case on, off, restricted, lowPower }
    public enum Level: Sendable { case fine, attention, notRecording, paused }

    public struct Problem: Equatable, Identifiable, Sendable {
        public var title: String
        public var detail: String
        public var id: String { title }

        public init(title: String, detail: String) {
            self.title = title
            self.detail = detail
        }
    }

    public var level: Level
    public var headline: String
    public var problems: [Problem]

    public init(level: Level, headline: String, problems: [Problem]) {
        self.level = level
        self.headline = headline
        self.problems = problems
    }

    /// An upload that stopped because resending cannot help.
    public struct Stop: Equatable, Sendable {
        public enum Area: String, Sendable { case positions, workouts, photos }
        public var area: Area
        public var reason: String

        public init(_ area: Area, _ reason: String) {
            self.area = area
            self.reason = reason
        }
    }

    /// `settingsDamaged`: the Keychain held settings that could not be decoded, so the defaults are in use.
    /// `asleep`: while the recorder sleeps at Home, since when ("since 23:14"); the headline says so instead of "Recording".
    public init(mode: Mode, setupComplete: Bool, workoutsSetupComplete: Bool, location: Location, precise: Bool, backgroundRefresh: BackgroundRefresh,
                stops: [Stop], more: [Problem], waiting: Int, asleep: String? = nil, settingsDamaged: Bool = false) {
        var problems: [Problem] = []
        switch location {
        case .always: break
        case .whenInUse: problems.append(.init(title: "Location access is \"While Using\"", detail: "Set it to Always in Settings: only then iOS starts the app again after ending it."))
        case .denied: problems.append(.init(title: "Location access is denied", detail: "Allow it in Settings: nothing is recorded."))
        case .notAsked: problems.append(.init(title: "Location access is not granted yet", detail: "Answer iOS's question, or allow it in Settings: nothing is recorded."))
        }
        let hasAccess = location == .always || location == .whenInUse
        if hasAccess, !precise {
            problems.append(.init(title: "Precise Location is off", detail: "Switch it on in Settings: without it iOS gives places some kilometres off."))
        }
        switch backgroundRefresh {
        case .on: break
        case .off: problems.append(.init(title: "Background App Refresh is off", detail: "Switch it on in Settings, under General: without it iOS may not start the app again."))
        case .restricted: problems.append(.init(title: "Background App Refresh is off", detail: "It is restricted on this phone: iOS may not start the app again."))
        case .lowPower: problems.append(.init(title: "Background App Refresh is off", detail: "Low Power Mode switches it off: iOS may not start the app again."))
        }
        if settingsDamaged {
            problems.append(.init(title: "The saved settings could not be read", detail: "Enter the server, the token and the device names in Setup again and save: until then nothing is sent."))
        } else if !setupComplete {
            problems.append(.init(title: "Setup is incomplete", detail: "Enter the server, the token and the device names in Setup: nothing is sent."))
        } else if !workoutsSetupComplete {
            problems.append(.init(title: "Setup is incomplete for workouts", detail: "Enter the workouts device name in Setup: workouts are counted, not sent."))
        }
        // One reason is said once, with everything it stops: a refused token stops all three.
        var reasons: [String] = []
        for stop in stops where !reasons.contains(stop.reason) { reasons.append(stop.reason) }
        for reason in reasons {
            let areas = stops.filter { $0.reason == reason }.map(\.area.rawValue)
            let what = areas.count == 3 ? "Uploads" : areas.joined(separator: " and ").prefix(1).uppercased() + areas.joined(separator: " and ").dropFirst()
            problems.append(.init(title: "\(what) are stopped", detail: "\(reason.prefix(1).uppercased() + reason.dropFirst()). \"Send now\" tries again."))
        }
        problems += more

        // The headline says what the mode does and what waits; the level says whether something is wrong.
        let waits = waiting > 0 ? "\(waiting) waiting" : nil
        if mode == .paused {
            // Paused is what the owner chose: the problems are listed, the sign stays his choice.
            self.init(level: .paused, headline: ["Paused", waits].compactMap { $0 }.joined(separator: ", "), problems: problems)
        } else if !hasAccess {
            self.init(level: .notRecording, headline: "Not recording", problems: problems)
        } else {
            let doing = asleep.map { "Asleep at Home \($0)" } ?? "Recording"
            self.init(level: problems.isEmpty ? .fine : .attention, headline: "\(doing), \(waits ?? (mode == .auto ? "all sent" : "nothing waiting"))",
                      problems: problems)
        }
    }
}
