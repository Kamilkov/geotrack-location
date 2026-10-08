import Foundation
import Testing
@testable import GeoTrackKit

/// A stand-in for Health: what it lists, what it refuses, and how often it was asked.
final class FakeHealth: @unchecked Sendable {
    struct Broken: Error {}
    private let lock = NSLock()
    private var workouts: [Workout]
    private var unreadable = false
    private var listFails = false
    private var failing: Set<String> = []
    private var listed = 0

    init(_ workouts: [Workout]) { self.workouts = workouts }

    func set(_ workouts: [Workout]) { lock.withLock { self.workouts = workouts } }
    func lock(_ locked: Bool) { lock.withLock { unreadable = locked } }
    func failList(_ fails: Bool) { lock.withLock { listFails = fails } }
    func fail(_ ids: Set<String>) { lock.withLock { failing = ids } }
    var lists: Int { lock.withLock { listed } }

    var list: WorkoutSync.List {
        { since in
            try self.lock.withLock {
                self.listed += 1
                if self.listFails { throw Broken() }
                if self.unreadable { return nil }
                return self.workouts.filter { $0.start >= since }.map { listedWorkout in
                    WorkoutRef(id: listedWorkout.id, end: listedWorkout.end) {
                        try self.lock.withLock {
                            if self.failing.contains(listedWorkout.id) { throw Broken() }
                            // As Health has it now, not as it was when it was listed.
                            guard let current = self.workouts.first(where: { $0.id == listedWorkout.id }) else { throw Broken() }
                            return current
                        }
                    }
                }
            }
        }
    }
}

/// Counts how often a completion handler was called.
final class Calls: @unchecked Sendable {
    private let lock = NSLock()
    private var n = 0
    var count: Int { lock.withLock { n } }
    var handler: @Sendable () -> Void { { self.lock.withLock { self.n += 1 } } }
}

/// Counts requests, so that a test can hold a particular one.
actor Counter {
    private var n = 0
    func next() -> Int {
        n += 1
        return n
    }
}

/// The statuses a sync published, in order.
final class Statuses: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [WorkoutSync.Status] = []
    var last: WorkoutSync.Status { lock.withLock { all.last ?? WorkoutSync.Status() } }
    var record: @Sendable (WorkoutSync.Status) -> Void { { status in self.lock.withLock { self.all.append(status) } } }
}

/// Holds the task a round's uploads run in, so that a test can cancel it as the app does when iOS's time runs out.
actor RoundTask {
    private var task: Task<Void, Never>?
    var isSet: Bool { task != nil }
    func set(_ task: Task<Void, Never>) { self.task = task }
    func cancel() { task?.cancel() }
}

/// Answers a confirmation of the device name (an empty workouts list) as a server of this version does, and
/// passes every other request on: a test about workouts sees only the workouts' requests.
func confirming(_ send: @escaping Uploader.Send) -> Uploader.Send {
    { request in
        let body = try object(request.httpBody)
        guard ((body["data"] as? [String: Any])?["workouts"] as? [Any])?.isEmpty == true else { return try await send(request) }
        let answer = try JSONSerialization.data(withJSONObject: ["device": body["device"] ?? NSNull(), "workouts": [Any](), "skipped": [Any]()])
        return (answer, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

/// The answer of a server of this version to a confirmation of `device`.
func confirmed(_ device: String) -> FakeServer.Reply { .init(body: #"{"device":"\#(device)","workouts":[],"skipped":[]}"#) }

/// The time limit: a test here waits for a request to arrive, and a wait that never ends would hold the whole run.
@Suite(.timeLimit(.minutes(1))) struct WorkoutSyncTests {
    let now = workoutStart.addingTimeInterval(300)
    /// Ten days before the workouts of these tests.
    let since = workoutStart.addingTimeInterval(-10 * 86400)
    let a = "AAAAAAAA-0000-4000-8000-000000000001", b = "BBBBBBBB-0000-4000-8000-000000000002"

    func job(device: String = "trial-iphone", sends: Bool = true, manual: Bool = false, configured: Bool = true) -> WorkoutSync.Job {
        let config = ServerConfig(baseURL: URL(string: "https://example.invalid")!, token: "test-token-not-a-secret", device: device)
        return WorkoutSync.Job(config: configured ? config : nil, device: device, since: since, sends: sends, manual: manual)
    }

    func make(_ health: FakeHealth, _ send: @escaping Uploader.Send, statuses: Statuses = Statuses(), answerWithin: Duration = .seconds(15)) throws -> (WorkoutSync, WorkoutLedger) {
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let now = self.now
        return (WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: confirming(send)), now: { now }, answerWithin: answerWithin, onStatus: statuses.record), ledger)
    }

    /// How many workouts each request carried: 0 for a confirmation of the device name.
    func counts(_ server: FakeServer) throws -> [Int] {
        try server.requests.map { try #require(((try object($0.httpBody)["data"] as? [String: Any])?["workouts"] as? [Any])?.count) }
    }

    func ids(_ server: FakeServer) throws -> [String] {
        try server.requests.map { try #require((((try object($0.httpBody)["data"] as? [String: Any])?["workouts"] as? [[String: Any]])?.first?["id"]) as? String) }
    }

    @Test func sendsWhatWasNeverSentOldestFirstAndRemembersIt() async throws {
        let health = FakeHealth([walk(b, endedAgo: 600, now: now), walk(a, endedAgo: 3600, now: now)])
        let server = FakeServer([stored(a), stored(b, heartRate: 5, route: 3)])
        let statuses = Statuses()
        let (sync, ledger) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(try ids(server) == [a, b])
        #expect(try ledger.load().mapValues(\.device) == [a: "trial-iphone", b: "trial-iphone"])
        #expect(try ledger.load()[a]?.floor == walk().content)
        var expected = WorkoutSync.Status()
        expected.found = 2
        expected.sent = 2
        expected.lastSent = .init(time: now, heartRate: 5, route: 3)
        #expect(statuses.last == expected)

        await sync.request(job())
        #expect(server.requests.count == 2) // nothing changed: nothing is sent again
    }

    @Test func aCheckThatMayNotSendOnlyCounts() async throws {
        let health = FakeHealth([walk(a, now: now), walk(b, now: now)])
        let server = FakeServer([])
        let statuses = Statuses()
        let (sync, _) = try make(health, server.send, statuses: statuses)
        await sync.request(job(sends: false))
        await sync.request(job(sends: true, configured: false)) // Setup is incomplete
        #expect(server.requests.isEmpty)
        #expect(statuses.last.waiting == 2)
        #expect(statuses.last.found == 2)
    }

    @Test func aWorkoutThatStartedBeforeTheStartDateIsNotLookedAt() async throws {
        let health = FakeHealth([walk(a, endedAgo: 90 * 86400, now: now), walk(b, now: now)])
        let server = FakeServer([stored(b)])
        let (sync, _) = try make(health, server.send)
        await sync.request(job())
        #expect(try ids(server) == [b])
    }

    @Test func aGrownWorkoutGoesOutAgainAndAnOldOneOnlyOnSendNow() async throws {
        let health = FakeHealth([walk(a, endedAgo: 49 * 3600, now: now), walk(b, endedAgo: 3600, now: now)])
        let server = FakeServer([stored(a), stored(b), stored(b), stored(a)])
        let (sync, _) = try make(health, server.send)
        await sync.request(job())
        health.set([walk(a, endedAgo: 49 * 3600, now: now, route: 9), walk(b, endedAgo: 3600, now: now, route: 9)]) // both routes arrived late
        await sync.request(job())
        #expect(try ids(server) == [a, b, b]) // the old one is not read again by itself
        await sync.request(job(manual: true))
        #expect(try ids(server) == [a, b, b, a])
    }

    @Test func aCopyWithLessThanWasAcknowledgedIsHeldAlsoOnSendNowAndUnderANewDeviceName() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([stored(a)])
        let statuses = Statuses()
        let (sync, _) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        var thinner = walk(a, now: now, route: 9) // the route arrived, the steps became unreadable
        thinner.steps = nil
        health.set([thinner])
        await sync.request(job())
        await sync.request(job(manual: true))
        await sync.request(job(device: "iphone"))
        #expect(server.requests.count == 1)
        #expect(statuses.last.held == 1)
        #expect(statuses.last.waiting == 0)
    }

    @Test func aWorkoutThatGotThinnerBetweenTheScanAndItsUploadIsNotSent() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let gate = Gate()
        let counter = Counter()
        let server = FakeServer([stored(a), stored(b), stored(a), stored(b)])
        let statuses = Statuses()
        let (sync, _) = try make(health, { request in
            if await counter.next() == 3 { await gate.pass() } // holds the third request: the second check's first upload
            return try await server.send(request)
        }, statuses: statuses)
        await sync.request(job())
        health.set([walk(a, endedAgo: 600, now: now, route: 9), walk(b, now: now, route: 9)]) // both grew
        let second = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // scanned, and uploading the first
        var thinner = walk(b, now: now, route: 9)
        thinner.steps = nil // the steps became unreadable after the scan
        health.set([walk(a, endedAgo: 600, now: now, route: 9), thinner])
        await gate.release()
        await second.value
        #expect(try ids(server) == [a, b, a]) // the second was read again before sending, and held
        #expect(statuses.last.held == 1)
        #expect(statuses.last.waiting == 0)
    }

    @Test func aWorkoutThatIsAsItWasSentAgainBetweenTheScanAndItsUploadIsNotSent() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let gate = Gate()
        let counter = Counter()
        let server = FakeServer([stored(a), stored(b), stored(a), stored(b)])
        let statuses = Statuses()
        let (sync, _) = try make(health, { request in
            if await counter.next() == 3 { await gate.pass() } // holds the third request: the second check's first upload
            return try await server.send(request)
        }, statuses: statuses)
        await sync.request(job())
        health.set([walk(a, endedAgo: 600, now: now, route: 9), walk(b, now: now, route: 9)]) // both grew
        let second = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // scanned, and uploading the first
        health.set([walk(a, endedAgo: 600, now: now, route: 9), walk(b, now: now)]) // the second is as it was sent again
        await gate.release()
        await second.value
        #expect(try ids(server) == [a, b, a]) // the second was read again before sending: nothing new, nothing sent
        #expect(statuses.last.held == 0)
        #expect(statuses.last.waiting == 0)
    }

    @Test func aWorkoutWithAFailedQueryIsLeftOutAndTheOthersGo() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        health.fail([a])
        let server = FakeServer([stored(b), stored(a)])
        let statuses = Statuses()
        let (sync, ledger) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(try ids(server) == [b])
        #expect(try ledger.load()[a] == nil)
        health.fail([])
        await sync.request(job())
        #expect(try ids(server) == [b, a])
    }

    @Test func aRejectedWorkoutIsCountedAndAPlainCheckSendsItAgainOnlyWhenItHasGrown() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([.init(body: #"{"workouts":[],"skipped":[{"index":0,"id":"x","reason":"not stored: value too large"}]}"#), stored(a)])
        let statuses = Statuses()
        let (sync, ledger) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(statuses.last.rejected == 1)
        #expect(statuses.last.sent == 0)
        #expect(try ledger.load()[a]?.floor == nil)
        await sync.request(job())
        #expect(server.requests.count == 1)
        #expect(statuses.last.rejected == 1)
        health.set([walk(a, now: now, route: 9)])
        await sync.request(job())
        #expect(server.requests.count == 2)
        #expect(statuses.last.rejected == 0)
        #expect(statuses.last.sent == 1)
    }

    @Test func aRejectedWorkoutGoesOutAgainOnSendNowAndStatusKeepsTheServersReason() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([.init(body: #"{"workouts":[],"skipped":[{"index":0,"id":"x","reason":"not stored: value too large"}]}"#), stored(a)])
        let statuses = Statuses()
        let (sync, ledger) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(statuses.last.lastRejection == "not stored: value too large")
        await sync.request(job())
        #expect(server.requests.count == 1) // unchanged: a plain check does not send it again
        #expect(statuses.last.lastRejection == "not stored: value too large") // a scan does not clear the reason
        await sync.request(job(manual: true))
        #expect(try ids(server) == [a, a])
        #expect(statuses.last.rejected == 0)
        #expect(statuses.last.sent == 1)
        #expect(try ledger.load()[a]?.rejected == false)
    }

    @Test func aFailureLeavesTheLedgerUntouchedAndTheNextCheckTriesAgain() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let server = FakeServer([.init(error: URLError(.timedOut)), stored(a), stored(b)])
        let statuses = Statuses()
        let (sync, ledger) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(server.requests.count == 1) // the round ends at the first failure
        #expect(try ledger.load() == [:])
        #expect(statuses.last.problem != nil)
        #expect(statuses.last.waiting == 2)
        await sync.request(job())
        #expect(try ids(server) == [a, a, b])
        #expect(statuses.last.problem == nil)
    }

    @Test func stopsWhenResendingCannotHelpUntilSendNow() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([.init(status: 401), stored(a)])
        let statuses = Statuses()
        let (sync, _) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        await sync.request(job())
        #expect(server.requests.count == 1) // the second check did not reach the server
        #expect(statuses.last.problem == "Stopped: the server rejects the token")
        #expect(statuses.last.stop == "the server rejects the token")
        #expect(statuses.last.waiting == 1)
        await sync.request(job(manual: true))
        #expect(server.requests.count == 2)
        #expect(statuses.last.problem == nil)
        #expect(statuses.last.stop == nil)
        #expect(statuses.last.sent == 1)
    }

    @Test func aStopDoesNotStandForOtherSettings() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([.init(status: 401), stored(a)])
        let statuses = Statuses()
        let (sync, _) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(statuses.last.problem == "Stopped: the server rejects the token")
        await sync.request(job(device: "other-device", sends: false)) // Setup saved in Manual: the check only counts
        #expect(statuses.last.problem == nil) // the stop was the old settings'
        #expect(server.requests.count == 1)
        await sync.request(job(device: "other-device"))
        #expect(server.requests.count == 2)
        #expect(statuses.last.sent == 1)
    }

    @Test func anAnswerIsWrittenUnderTheDeviceNameItsRequestStartedWith() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a), stored(a)])
        let (sync, ledger) = try make(health) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let first = Task { await sync.request(job(device: "trial-iphone")) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the request for trial-iphone is under way
        await sync.request(job(device: "iphone")) // Setup was saved with the new name
        #expect(try ledger.load() == [:])
        await gate.release()
        await first.value

        // The answer for trial-iphone did not mark the workout as sent for iphone: it went out again under the new name.
        let devices = try server.requests.map { try object($0.httpBody)["device"] as? String }
        #expect(devices == ["trial-iphone", "iphone"])
        #expect(try ledger.load()[a]?.device == "iphone")
    }

    @Test func sendNowDuringACheckThatOnlyCountsStillSends() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a)])
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let list = health.list
        let sync = WorkoutSync(ledger: ledger, list: { since in
            await gate.pass()
            return try await list(since)
        }, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now })
        let counting = Task { await sync.request(job(sends: false)) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the scan is under way
        await sync.request(job(sends: true, manual: true)) // the tap
        #expect(server.requests.isEmpty)
        await gate.release()
        await counting.value
        #expect(try ids(server) == [a])
    }

    @Test func sendNowIsNotForgottenWhenAPlainRequestFollowsItDuringTheSameCheck() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([.init(status: 401), stored(a)])
        let (sync, _) = try make(health) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let first = Task { await sync.request(job()) } // will be stopped by the 401
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) }
        await sync.request(job(manual: true)) // the tap
        await sync.request(job(sends: false)) // and a check that only counts, asked for right after it
        await gate.release()
        await first.value
        #expect(server.requests.count == 2) // the remembered check still sends, and still lifts the stop
    }

    @Test func sendNowDuringAnUploadSendsAfterwardsAndOnlyOnce() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a), stored(b)])
        let (sync, _) = try make(health) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let uploading = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first upload is under way
        await sync.request(job(manual: true)) // the tap
        await gate.release()
        await uploading.value
        #expect(try ids(server) == [a, b]) // the check the tap asked for found nothing left to send
        #expect(health.lists == 2)
    }

    @Test(arguments: ["nothing to send", "something to send", "Health is locked", "Health fails", "a query fails"])
    func aCallbackIsAnsweredOnceWhenItsScanHasEnded(path: String) async throws {
        let health = FakeHealth(path == "nothing to send" ? [] : [walk(a, now: now)])
        health.lock(path == "Health is locked")
        health.failList(path == "Health fails")
        if path == "a query fails" { health.fail([a]) }
        let server = FakeServer([stored(a)])
        let calls = Calls()
        let (sync, _) = try make(health, server.send)
        await sync.request(job(), completion: calls.handler)
        #expect(calls.count == 1)
    }

    @Test func aCallbackIsAnsweredAfterTheScanAndBeforeTheUploadsEnd() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a)])
        let calls = Calls()
        let (sync, _) = try make(health) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let check = Task { await sync.request(job(), completion: calls.handler) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the upload is under way
        #expect(calls.count == 1)
        await gate.release()
        await check.value
        #expect(calls.count == 1)
    }

    @Test func aCallbackDuringARunningCheckWaitsForTheScanOfTheNextOne() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a)])
        let calls = Calls()
        let (sync, _) = try make(health) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let check = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // past its scan, uploading
        await sync.request(job(), completion: calls.handler)
        #expect(calls.count == 0) // this check read Health before the change the callback reports
        await gate.release()
        await check.value
        #expect(calls.count == 1)
        #expect(health.lists == 2)
    }

    @Test func aCallbackIsAnsweredAfterTheLimitWhenItsScanHasNotEnded() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a)])
        let calls = Calls()
        let (sync, _) = try make(health, { request in
            await gate.pass()
            return try await server.send(request)
        }, answerWithin: .milliseconds(30))
        let check = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // uploading: the next scan cannot start
        await sync.request(job(), completion: calls.handler)
        while calls.count == 0 { try await Task.sleep(for: .milliseconds(2)) } // answered although its scan has not run
        #expect(health.lists == 1)
        await gate.release()
        await check.value
        #expect(health.lists == 2) // the scan still ran
        #expect(calls.count == 1) // and did not answer a second time
    }

    @Test func anAutoRequestIsNotRememberedWhenALaterRequestMayNotSend() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a)])
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let list = health.list
        let sync = WorkoutSync(ledger: ledger, list: { since in
            await gate.pass()
            return try await list(since)
        }, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now })
        let counting = Task { await sync.request(job(sends: false)) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the scan is under way
        await sync.request(job(sends: true)) // asked for in Auto
        await sync.request(job(sends: false)) // then the owner switched to Manual
        await gate.release()
        await counting.value
        #expect(server.requests.isEmpty)
    }

    @Test func aRoundStopsBeforeItsNextRequestWhenSetupWasSavedMeanwhile() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let gate = Gate()
        let server = FakeServer([stored(a), stored(a), stored(b)])
        let (sync, ledger) = try make(health) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let first = Task { await sync.request(job(device: "trial-iphone")) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first workout is under way as trial-iphone
        await sync.request(job(device: "iphone")) // Setup was saved with the new name
        await gate.release()
        await first.value

        let devices = try server.requests.map { try object($0.httpBody)["device"] as? String }
        #expect(devices == ["trial-iphone", "iphone", "iphone"]) // the second workout never went out under the old name
        #expect(try ids(server) == [a, a, b])
        #expect(try ledger.load().mapValues(\.device) == [a: "iphone", b: "iphone"])
    }

    @Test func aLedgerThatCannotBeReadStopsTheCheckAndSendsNothing() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([stored(a)])
        let statuses = Statuses()
        let calls = Calls()
        let (sync, ledger) = try make(health, server.send, statuses: statuses)
        try Data("not a ledger".utf8).write(to: ledger.url)
        await sync.request(job(), completion: calls.handler)
        #expect(server.requests.isEmpty)
        #expect(statuses.last.problem?.contains("ledger") == true)
        #expect(calls.count == 1)
        #expect(statuses.last.found == nil) // stopped in the scan, before anything was counted or decided on an empty ledger
    }

    @Test func aLedgerThatCannotBeReadWhenTheUploadsBeginSendsNothingAndIsNotWrittenOver() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([stored(a)])
        let statuses = Statuses()
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now },
                               background: { work in
                                   try? Data("not a ledger".utf8).write(to: ledger.url) // after the scan, before the first upload
                                   await work()
                               }, onStatus: statuses.record)
        await sync.request(job())
        #expect(server.requests.isEmpty) // taken for "nothing sent yet", the workout would go out and every floor be lost
        #expect(statuses.last.problem?.contains("ledger") == true)
        #expect(try String(contentsOf: ledger.url, encoding: .utf8) == "not a ledger")
    }

    @Test func theUploadsRunThroughTheBackgroundWrapperAndAScanAloneDoesNot() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([stored(a)])
        let wrapped = Calls()
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now },
                               background: { work in
                                   wrapped.handler()
                                   await work()
                               })
        await sync.request(job(sends: false))
        #expect(wrapped.count == 0)
        await sync.request(job())
        #expect(wrapped.count == 1)
        #expect(server.requests.count == 1)
        await sync.request(job()) // nothing is left to send
        #expect(wrapped.count == 1)
    }

    /// A round over the workouts a and b whose task is cancelled while a's request is under way, as the app
    /// does when iOS's time for the round runs out. `requestFails`: the request ends as URLSession ends one of
    /// a cancelled task; otherwise it is still answered.
    func interruptedRound(requestFails: Bool, during: @Sendable (WorkoutSync) async -> Void = { _ in }) async throws
        -> (WorkoutSync, FakeHealth, FakeServer, Statuses, WorkoutLedger) {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let server = FakeServer([stored(a), stored(b)])
        let gate = Gate(), round = RoundTask(), statuses = Statuses()
        let send: Uploader.Send = { request in
            await gate.pass()
            if requestFails { try Task.checkCancellation() }
            return try await server.send(request)
        }
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: confirming(send)), now: { [now] in now },
                               background: { work in
                                   let task = Task { await work() }
                                   await round.set(task)
                                   await task.value
                               }, onStatus: statuses.record)
        let check = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first workout's request is under way
        while await !round.isSet { try await Task.sleep(for: .milliseconds(2)) }
        await during(sync)
        await round.cancel() // iOS's time ran out
        await gate.release()
        await check.value
        return (sync, health, server, statuses, ledger)
    }

    @Test(arguments: [false, true])
    func aRoundWhoseTimeRanOutSendsNothingFurtherAndSaysSo(requestFails: Bool) async throws {
        let (sync, _, server, statuses, ledger) = try await interruptedRound(requestFails: requestFails)
        #expect(try ids(server) == (requestFails ? [] : [a])) // the second workout's request was never made
        #expect(statuses.last.sent == (requestFails ? 0 : 1))
        #expect(statuses.last.waiting == (requestFails ? 2 : 1))
        #expect(statuses.last.problem == "Interrupted: iOS ended the time for sending")
        #expect(try ledger.load().count == (requestFails ? 0 : 1))

        // The app is opened again in Manual: the check only counts, and Status still says why something waits.
        let sent = server.requests.count
        await sync.request(job(sends: false))
        #expect(server.requests.count == sent)
        #expect(statuses.last.problem == "Interrupted: iOS ended the time for sending")
        await sync.request(job(manual: true)) // "Send now"
        #expect(statuses.last.problem == nil)
        #expect(statuses.last.waiting == 0)
        #expect(statuses.last.sent == 2)
    }

    @Test func whatWasAskedForDuringARoundWhoseTimeRanOutWaitsForANewWordToo() async throws {
        let again = job(manual: true) // a second "Send now" while the round runs
        let (sync, _, server, statuses, _) = try await interruptedRound(requestFails: false, during: { await $0.request(again) })
        #expect(try ids(server) == [a]) // the check that was asked for only counted
        #expect(statuses.last.waiting == 1)
        #expect(statuses.last.problem == "Interrupted: iOS ended the time for sending")
        await sync.request(job(manual: true)) // a new word
        #expect(try ids(server) == [a, b])
        #expect(statuses.last.problem == nil)
    }

    @Test func aRoundWhoseTimeRanOutWhileItsLastWorkoutWasReadSaysSoToo() async throws {
        let workout = walk(a, now: now)
        let loads = Counter(), gate = Gate(), round = RoundTask(), statuses = Statuses()
        let server = FakeServer([stored(a)])
        let list: WorkoutSync.List = { _ in
            [WorkoutRef(id: workout.id, end: workout.end) {
                if await loads.next() == 2 { // the read before the upload; the scan's read passes
                    await gate.pass()
                    try Task.checkCancellation() // as Health's queries end in a cancelled task
                }
                return workout
            }]
        }
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: list, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now },
                               background: { work in
                                   let task = Task { await work() }
                                   await round.set(task)
                                   await task.value
                               }, onStatus: statuses.record)
        let check = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the workout is being read again
        while await !round.isSet { try await Task.sleep(for: .milliseconds(2)) }
        await round.cancel()
        await gate.release()
        await check.value

        #expect(server.requests.isEmpty)
        #expect(statuses.last.waiting == 1)
        #expect(statuses.last.problem == "Interrupted: iOS ended the time for sending")
    }

    @Test func anInterruptionWithNothingLeftToSendIsNoLongerShown() async throws {
        let (sync, health, _, statuses, _) = try await interruptedRound(requestFails: false)
        health.set([walk(a, endedAgo: 600, now: now)]) // the workout that was left is gone from Health
        await sync.request(job(sends: false))
        #expect(statuses.last.waiting == 0)
        #expect(statuses.last.problem == nil)
    }

    @Test func aRoundWhoseTimeRanOutDuringTheDeviceConfirmationSaysSoToo() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([confirmed("trial-iphone"), stored(a)])
        let gate = Gate(), round = RoundTask(), statuses = Statuses()
        let send: Uploader.Send = { request in
            await gate.pass()
            try Task.checkCancellation()
            return try await server.send(request)
        }
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: send), now: { [now] in now },
                               background: { work in
                                   let task = Task { await work() }
                                   await round.set(task)
                                   await task.value
                               }, onStatus: statuses.record)
        let check = Task { await sync.request(job()) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the confirmation is under way
        while await !round.isSet { try await Task.sleep(for: .milliseconds(2)) }
        await round.cancel()
        await gate.release()
        await check.value

        #expect(server.requests.isEmpty)
        #expect(statuses.last.waiting == 1)
        #expect(statuses.last.problem == "Interrupted: iOS ended the time for sending")
    }

    @Test func aServerThatDoesNotNameTheDeviceIsSentNoWorkoutAndSendNowAsksAgain() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let before = FakeServer.Reply(body: #"{"workouts":[],"skipped":[]}"#) // a server from before the app's workouts
        let server = FakeServer([before, before])
        let statuses = Statuses()
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: server.send), now: { [now] in now }, onStatus: statuses.record)
        await sync.request(job())
        #expect(try counts(server) == [0]) // the confirmation only: no workout went out
        #expect(statuses.last.problem == "Stopped: the server does not store workouts under a device name yet: deploy it first")
        #expect(statuses.last.waiting == 1)
        #expect(try ledger.load() == [:])
        await sync.request(job())
        #expect(server.requests.count == 1) // stopped: a plain check does not ask again
        await sync.request(job(manual: true))
        #expect(try counts(server) == [0, 0]) // "Send now" asked again, and still sent no workout
        #expect(try ledger.load() == [:])
    }

    @Test func theDeviceIsConfirmedOncePerSyncAndSettings() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now)])
        let server = FakeServer([confirmed("trial-iphone"), stored(a), stored(b), confirmed("iphone"), stored(a), stored(b)])
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: server.send), now: { [now] in now })
        await sync.request(job())
        health.set([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        await sync.request(job()) // a second round under the same settings
        await sync.request(job(device: "iphone")) // Setup was saved with a new name
        #expect(try counts(server) == [0, 1, 1, 0, 1, 1])
        let devices = try server.requests.map { try object($0.httpBody)["device"] as? String }
        #expect(devices == ["trial-iphone", "trial-iphone", "trial-iphone", "iphone", "iphone", "iphone"])
        #expect(try ledger.load().mapValues(\.device) == [a: "iphone", b: "iphone"])
    }

    @Test func aConfirmationThatFailsSendsNoWorkoutAndTheNextCheckAsksAgain() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([.init(status: 503), confirmed("trial-iphone"), stored(a)])
        let statuses = Statuses()
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: server.send), now: { [now] in now }, onStatus: statuses.record)
        await sync.request(job())
        #expect(try counts(server) == [0]) // the confirmation only: no workout went out unconfirmed
        #expect(statuses.last.problem == "server answered 503")
        #expect(statuses.last.waiting == 1)
        #expect(try ledger.load() == [:])
        await sync.request(job()) // not stopped: a plain check asks again
        #expect(try counts(server) == [0, 0, 1])
        #expect(statuses.last.sent == 1)
    }

    @Test func theBackgroundWrapperHasBegunWhenACallbackIsAnswered() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([stored(a)])
        let begun = Calls(), begunAtTheAnswer = Calls()
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        let sync = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now },
                               background: { work in
                                   begun.handler()
                                   await work()
                               })
        // iOS may suspend the app once the callback is answered: the time for the uploads must be asked for before.
        await sync.request(job(), completion: { if begun.count == 1 { begunAtTheAnswer.handler() } })
        #expect(begunAtTheAnswer.count == 1)
        #expect(server.requests.count == 1)
    }

    @Test func afterARelaunchStatusShowsTheLastSentAndTheReasonOfTheRejectedWorkout() async throws {
        let health = FakeHealth([walk(a, endedAgo: 600, now: now), walk(b, now: now)])
        let server = FakeServer([stored(a, heartRate: 7, route: 4), .init(body: #"{"workouts":[],"skipped":[{"index":0,"id":"x","reason":"not stored: value too large"}]}"#)])
        let (sync, ledger) = try make(health, server.send)
        await sync.request(job())

        let statuses = Statuses()
        let relaunched = WorkoutSync(ledger: ledger, list: health.list, uploader: WorkoutUploader(send: confirming(server.send)), now: { [now] in now }, onStatus: statuses.record)
        await relaunched.request(job(sends: false))
        #expect(statuses.last.lastSent == .init(time: now, heartRate: 7, route: 4))
        #expect(statuses.last.lastRejection == "not stored: value too large")
        #expect(server.requests.count == 2)
    }

    @Test func theReasonGoesWhenItsWorkoutIsNoLongerCountedAsRejected() async throws {
        let health = FakeHealth([walk(a, now: now)])
        let server = FakeServer([.init(body: #"{"workouts":[],"skipped":[{"index":0,"id":"x","reason":"not stored: value too large"}]}"#), stored(a)])
        let statuses = Statuses()
        let (sync, _) = try make(health, server.send, statuses: statuses)
        await sync.request(job())
        #expect(statuses.last.lastRejection == "not stored: value too large")
        await sync.request(job(manual: true)) // stored this time
        await sync.request(job())
        #expect(statuses.last.rejected == 0)
        #expect(statuses.last.lastRejection == nil)
    }
}
