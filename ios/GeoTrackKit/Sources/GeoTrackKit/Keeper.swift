import Foundation

/// Applies the keep rule and writes what is kept. The last kept position is saved apart from the queue,
/// so the rule still works after a restart with an empty queue.
public final class Keeper {
    private let queue: PositionQueue
    private let lastKeptURL: URL
    private let now: () -> Date
    public private(set) var last: Fix?

    public init(queue: PositionQueue, lastKeptURL: URL, now: @escaping () -> Date = { .now }) {
        self.queue = queue
        self.lastKeptURL = lastKeptURL
        self.now = now
        last = (try? Data(contentsOf: lastKeptURL)).flatMap { try? JSONDecoder().decode(Fix.self, from: $0) }
    }

    /// What went wrong when the last kept position could not be saved; nil after a save that worked.
    /// The position itself is kept all the same: it is in the queue.
    public private(set) var saveProblem: String?

    /// The position that was kept, or nil when the fix was thinned out or refused.
    /// `wokeFromHome`: the first fix after Home sleep is kept unless refused, and marked as the region trigger.
    /// Throws when the position's file could not be written; such a fix does not count as kept.
    public func offer(_ sample: Sample, wokeFromHome: Bool = false) throws -> Position? {
        // A last kept position later than the clock was kept while the clock ran ahead. Held against it, every
        // fix would be refused as "not newer" until that time comes.
        let trusted = last.flatMap { $0.time > now() ? nil : $0 }
        let decision = KeepRule.decide(last: trusted, candidate: sample.fix, horizontalAccuracy: sample.horizontalAccuracy)
        guard decision == .keepForDistance || decision == .keepForTime || (wokeFromHome && decision != .refuse) else { return nil }
        let position = Position(sample: sample, keptForTime: decision == .keepForTime, wokeFromHome: wokeFromHome)
        try queue.append(position)
        last = sample.fix
        do {
            try JSONEncoder().encode(sample.fix).write(to: lastKeptURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            saveProblem = nil
        } catch {
            saveProblem = error.localizedDescription
        }
        return position
    }
}
