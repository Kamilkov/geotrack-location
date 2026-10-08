import Foundation

/// A workout Health lists: enough to decide whether to read it, and the way to read it whole.
public struct WorkoutRef: Sendable {
    public var id: String
    public var end: Date
    /// Throws when one of its queries failed; such a workout is left out of the check.
    public var load: @Sendable () async throws -> Workout

    public init(id: String, end: Date, load: @escaping @Sendable () async throws -> Workout) {
        self.id = id
        self.end = end
        self.load = load
    }
}

/// Orders the checks: one at a time, one more remembered, every callback from Health answered.
/// A check is a scan (read Health, decide) and then the uploads. What is waiting is never stored: every scan
/// works it out again from Health and the ledger, so a check that is cut off loses nothing.
public actor WorkoutSync {
    public struct Job: Sendable {
        /// nil while Setup is incomplete: the check then only counts.
        public var config: ServerConfig?
        /// The workouts device name from Setup. The same name as `config.device` whenever `config` is set; kept apart because the scan needs it also while Setup is incomplete.
        public var device: String
        /// Workouts that start before this are not looked at.
        public var since: Date
        /// Auto, or "Send now".
        public var sends: Bool
        /// "Send now": lifts a stop, and looks at workouts of every age.
        public var manual: Bool

        public init(config: ServerConfig?, device: String, since: Date, sends: Bool, manual: Bool) {
            self.config = config
            self.device = device
            self.since = since
            self.sends = sends
            self.manual = manual
        }
    }

    public struct Status: Equatable, Sendable {
        public struct Sent: Equatable, Sendable {
            public var time: Date
            public var heartRate: Int
            public var route: Int
        }

        /// Workouts since the start date at the last scan; nil before the first scan that could read Health.
        public var found: Int?
        public var sent = 0
        public var waiting = 0
        public var rejected = 0
        public var held = 0
        /// The newest workout the server stored, as the ledger has it: it is there after a relaunch too.
        public var lastSent: Sent?
        /// Why the uploads stopped, or what failed last.
        public var problem: String?
        /// Why the uploads are stopped, while they are: resending cannot help.
        public var stop: String?
        /// The server's reason for the newest of the workouts counted in `rejected`.
        public var lastRejection: String?

        public init() {}
    }

    /// The workouts since a date, or nil when Health cannot be read now (the phone is locked).
    public typealias List = @Sendable (Date) async throws -> [WorkoutRef]?
    /// Runs the uploads; the app wraps them in a background task, and cancels the task they run in when iOS's
    /// time for it runs out.
    public typealias Background = @Sendable (@escaping @Sendable () async -> Void) async -> Void

    /// A callback's completion handler, called once.
    private final class Callback: @unchecked Sendable {
        private let lock = NSLock()
        private var action: (@Sendable () -> Void)?

        init(_ action: @escaping @Sendable () -> Void) { self.action = action }

        func call() {
            let action = lock.withLock { () -> (@Sendable () -> Void)? in
                defer { self.action = nil }
                return self.action
            }
            action?()
        }
    }

    private let ledger: WorkoutLedger
    private let list: List
    private let uploader: WorkoutUploader
    private let now: @Sendable () -> Date
    private let answerWithin: Duration
    private let background: Background
    private let onStatus: @Sendable (Status) -> Void

    /// What Status says when iOS ended the time a round had: the words the app uses for photos.
    static let interrupted = "Interrupted: iOS ended the time for sending"

    private var running = false
    private var wanted: Job?
    /// Callbacks that wait for the scan of the next check.
    private var callbacks: [Callback] = []
    /// Why resending cannot help, and the settings that earned it: a stop does not stand for other settings.
    private var stopped: (reason: String, config: ServerConfig)?
    /// iOS ended the time of the last round that sent, and something still waits: Status says so until a
    /// check that may send comes.
    private var interrupted = false
    /// The check that is running was cut off by iOS.
    private var cut = false
    private var status = Status()
    /// The settings a server confirmed it stores workouts under the device name of.
    private var confirmed: ServerConfig?

    public init(ledger: WorkoutLedger, list: @escaping List, uploader: WorkoutUploader = WorkoutUploader(),
                now: @escaping @Sendable () -> Date = { .now }, answerWithin: Duration = .seconds(15),
                background: @escaping Background = { await $0() }, onStatus: @escaping @Sendable (Status) -> Void = { _ in }) {
        self.ledger = ledger
        self.list = list
        self.uploader = uploader
        self.now = now
        self.answerWithin = answerWithin
        self.background = background
        self.onStatus = onStatus
    }

    /// Asks for a check. `completion` is a callback from Health: it is called when the scan this request asked
    /// for has ended, and after `answerWithin` at the latest, because iOS stops delivering after three callbacks
    /// that stay unanswered.
    /// Call it from a task that is not cancelled: the scans run in the caller's task. The uploads run where
    /// `background` puts them; cancelling that task ends the round before its next request.
    public func request(_ job: Job, completion: (@Sendable () -> Void)? = nil) async {
        if let completion {
            let callback = Callback(completion)
            callbacks.append(callback)
            let limit = answerWithin
            Task {
                try? await Task.sleep(for: limit)
                callback.call()
            }
        }
        if running {
            // Not dropped: one more check is remembered, with the newest settings, and whether "Send now" asked for it.
            wanted = Job(config: job.config, device: job.device, since: job.since,
                         sends: job.sends || (wanted?.manual ?? false), manual: job.manual || (wanted?.manual ?? false))
            return
        }
        running = true
        var next: Job? = job
        while let job = next {
            cut = false
            await check(job)
            next = wanted
            wanted = nil
            // iOS ended the round's time: what was asked for during it waits for a new word like the rest. The
            // check still runs, to count and to answer Health, but it sends nothing.
            if cut, let asked = next {
                next = Job(config: asked.config, device: asked.device, since: asked.since, sends: false, manual: false)
            }
        }
        running = false
    }

    private func check(_ job: Job) async {
        // A callback that arrives from here on waits for the next check: this scan may have read before its change.
        let answering = callbacks
        callbacks = []
        if job.manual || stopped?.config != job.config { stopped = nil }
        if job.sends { interrupted = false } // this check sends what the interrupted round left
        let plan = await scan(job)
        guard let plan, !plan.isEmpty, job.sends, let config = job.config, stopped == nil else { return answering.forEach { $0.call() } }
        // Answered inside the wrapper: once Health has its answer iOS may suspend the app, so the time for
        // the uploads is asked for first.
        await background {
            answering.forEach { $0.call() }
            await self.upload(plan, config: config, manual: job.manual)
        }
    }

    /// Reads Health and decides. nil when nothing could be decided.
    private func scan(_ job: Job) async -> [WorkoutRef]? {
        let entries: [String: LedgerEntry]
        do { entries = try ledger.load() } catch { return fail("the ledger cannot be read: \(error.localizedDescription)") }
        let refs: [WorkoutRef]
        do {
            guard let listed = try await list(job.since) else { return nil }
            refs = listed.sorted { $0.end < $1.end }
        } catch { return fail("Health could not be read: \(error.localizedDescription)") }

        var send: [WorkoutRef] = [], held = 0, unread = 0
        for ref in refs where WorkoutRule.worthReading(end: ref.end, entry: entries[ref.id], device: job.device, now: now(), manual: job.manual) {
            let content: WorkoutContent
            do { content = try await ref.load().content } catch {
                unread += 1
                continue
            }
            switch WorkoutRule.decide(content: content, entry: entries[ref.id], device: job.device, manual: job.manual) {
            case .send: send.append(ref)
            case .held: held += 1
            case .nothing: break
            }
        }
        let going = Set(send.map(\.id))
        let settled = refs.compactMap { ref in going.contains(ref.id) ? nil : entries[ref.id] }.filter { $0.device == job.device }
        status.found = refs.count
        status.sent = settled.filter { !$0.rejected }.count
        status.rejected = settled.filter(\.rejected).count
        status.lastRejection = settled.filter(\.rejected).max { $0.sentAt < $1.sentAt }?.reason
        status.lastSent = refs.compactMap { entries[$0.id] }.filter { $0.device == job.device && !$0.rejected }.max { $0.sentAt < $1.sentAt }.flatMap { entry in
            guard let heartRate = entry.storedHeartRate, let route = entry.storedRoute else { return nil }
            return Status.Sent(time: entry.sentAt, heartRate: heartRate, route: route)
        }
        status.waiting = send.count
        status.held = held
        if send.isEmpty { interrupted = false } // nothing waits: nothing was held back
        status.stop = stopped?.reason
        status.problem = stopped.map { "Stopped: \($0.reason)" } ?? (interrupted ? WorkoutSync.interrupted : nil)
            ?? (unread > 0 ? "\(unread) workouts could not be read" : nil)
        onStatus(status)
        return send
    }

    private func upload(_ plan: [WorkoutRef], config: ServerConfig, manual: Bool) async {
        // A server from before the app's workouts ignores the device name and would store them as the live
        // device's: no workout goes out until the server names the device it stores them under.
        if confirmed != config {
            switch await uploader.confirmDevice(config: config) {
            case nil:
                confirmed = config
            case let .retryLater(reason)?:
                fail(cutOff() ? WorkoutSync.interrupted : reason)
                return
            case let .stopped(reason)?:
                stopped = (reason, config)
                status.stop = reason
                fail("Stopped: \(reason)")
                return
            case .stored?, .rejected?:
                return // a confirmation names no workout
            }
        }
        for ref in plan {
            // The task was cancelled because iOS's time for the round ran out: nothing further goes out, also
            // not when the app runs again. What is left waits for the next check that may send.
            if cutOff() {
                fail(WorkoutSync.interrupted)
                return
            }
            // Setup was saved meanwhile: the rest goes out with the new settings, in the check that is wanted.
            if let next = wanted, next.config != config { return }
            var entries: [String: LedgerEntry]
            do { entries = try ledger.load() } catch {
                fail("the ledger cannot be read: \(error.localizedDescription)")
                return
            }
            // Read again, and decided again: only the copy that is sent may be written to the ledger.
            guard let workout = try? await ref.load() else {
                // Health ends its queries in a cancelled task: that is the interruption, not a workout that cannot be read.
                if cutOff() {
                    fail(WorkoutSync.interrupted)
                    return
                }
                continue
            }
            let content = workout.content
            switch WorkoutRule.decide(content: content, entry: entries[ref.id], device: config.device, manual: manual) {
            case .send:
                break
            case .held:
                // It got thinner after the scan: Status says so now, not at the next scan.
                status.waiting -= 1
                status.held += 1
                onStatus(status)
                continue
            case .nothing:
                status.waiting -= 1
                onStatus(status)
                continue
            }

            switch await uploader.upload(workout, config: config) {
            case let .stored(heartRate, route):
                entries[ref.id] = LedgerEntry(device: config.device, floor: content, sent: content, rejected: false, sentAt: now(),
                                              storedHeartRate: heartRate, storedRoute: route)
                status.sent += 1
                status.lastSent = Status.Sent(time: now(), heartRate: heartRate, route: route)
            case let .rejected(reason):
                // A copy the server did not take never moves the floor.
                entries[ref.id] = LedgerEntry(device: config.device, floor: entries[ref.id]?.floor, sent: content, rejected: true, sentAt: now(),
                                              reason: reason)
                status.rejected += 1
                status.lastRejection = reason
            case let .retryLater(reason):
                fail(cutOff() ? WorkoutSync.interrupted : reason)
                return
            case let .stopped(reason):
                stopped = (reason, config)
                status.stop = reason
                fail("Stopped: \(reason)")
                return
            }
            do { try ledger.save(entries) } catch {
                fail("the ledger cannot be written: \(error.localizedDescription)")
                return
            }
            status.waiting -= 1
            onStatus(status)
        }
    }

    /// Whether the round's task was cancelled; remembered, so that the next scan still says so.
    private func cutOff() -> Bool {
        if Task.isCancelled { (interrupted, cut) = (true, true) }
        return Task.isCancelled
    }

    @discardableResult
    private func fail(_ problem: String) -> [WorkoutRef]? {
        status.problem = problem
        onStatus(status)
        return nil
    }
}
