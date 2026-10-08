import Foundation
import Testing
@testable import GeoTrackKit

/// A stand-in for the server: answers in order and records what it was sent.
final class FakeServer: @unchecked Sendable {
    struct Reply { var status = 200; var body = "{}"; var error: URLError? = nil }
    private let lock = NSLock()
    private var replies: [Reply]
    private(set) var requests: [URLRequest] = []

    init(_ replies: [Reply]) { self.replies = replies }

    var send: Uploader.Send {
        { request in
            let reply: Reply = self.lock.withLock {
                self.requests.append(request)
                return self.replies.isEmpty ? Reply(status: 500) : self.replies.removeFirst()
            }
            if let error = reply.error { throw error }
            return (Data(reply.body.utf8), HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: nil, headerFields: nil)!)
        }
    }

    func devicesAndTimes() throws -> [[Int]] {
        try requests.map { request in
            return (try object(request.httpBody)["positions"] as? [[String: Any]] ?? []).compactMap { $0["tst"] as? Int }
        }
    }
}

/// Holds the first request until `release()` is called; later ones pass at once, so a test cannot hang on them.
actor Gate {
    private var held: CheckedContinuation<Void, Never>?
    private var open = false
    private(set) var arrived = 0

    func pass() async {
        arrived += 1
        if open || arrived > 1 { return }
        await withCheckedContinuation { held = $0 }
    }

    func release() {
        open = true
        held?.resume()
        held = nil
    }
}

/// A clock a test moves by hand.
final class FakeClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = ContinuousClock.now
    var now: ContinuousClock.Instant { lock.withLock { instant } }
    func advance(_ duration: Duration) { lock.withLock { instant = instant.advanced(by: duration) } }
}

/// The time limit: a test here waits for a request to arrive, and a wait that never ends would hold the whole run.
@Suite(.timeLimit(.minutes(1))) struct UploaderTests {
    let config = ServerConfig(baseURL: URL(string: "https://example.invalid")!, token: "test-token-not-a-secret", device: "trial-iphone")

    func queue(_ seconds: [Double]) throws -> PositionQueue {
        let queue = try PositionQueue(directory: scratch())
        for s in seconds { try queue.append(Position(sample: sample(s), keptForTime: false)) }
        return queue
    }

    @Test func nothingWaitingSendsNothing() async throws {
        let server = FakeServer([])
        #expect(await Uploader(queue: try queue([]), send: server.send).drain(config: config) == .idle)
        #expect(server.requests.isEmpty)
    }

    @Test func sendsOldestFirstInBatchesAndRemovesWhatTheServerConfirmed() async throws {
        let q = try queue([600, 0, 300])
        let server = FakeServer([.init(body: #"{"stored":2,"duplicates":0,"skipped":[]}"#), .init(body: #"{"stored":0,"duplicates":1,"skipped":[]}"#)])
        let outcome = await Uploader(queue: q, batchSize: 2, send: server.send).drain(config: config)
        #expect(outcome == .sent(stored: 2, duplicates: 1, skipped: 0))
        #expect(try server.devicesAndTimes() == [[1_790_000_000, 1_790_000_300], [1_790_000_600]])
        #expect(q.count() == 0)
        let first = server.requests[0]
        #expect(first.url?.absoluteString == "https://example.invalid/positions")
        #expect(first.httpMethod == "POST")
        #expect(first.value(forHTTPHeaderField: "Authorization") == "Bearer test-token-not-a-secret")
        #expect(try object(first.httpBody)["device"] as? String == "trial-iphone")
    }

    @Test func setsAsideWhatTheServerSkipped() async throws {
        let q = try queue([0, 300, 600])
        let server = FakeServer([.init(body: #"{"stored":2,"duplicates":0,"skipped":[1]}"#)])
        #expect(await Uploader(queue: q, send: server.send).drain(config: config) == .sent(stored: 2, duplicates: 0, skipped: 1))
        #expect(q.count() == 0)
        #expect(q.rejectedCount() == 1)
    }

    @Test func sendNowTriesWhatTheServerSkippedOnceMore() async throws {
        let q = try queue([0, 300])
        let stored = FakeServer.Reply(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)
        let server = FakeServer([.init(body: #"{"stored":1,"duplicates":0,"skipped":[1]}"#), stored])
        let uploader = Uploader(queue: q, send: server.send)
        #expect(await uploader.drain(config: config) == .sent(stored: 1, duplicates: 0, skipped: 1))
        #expect(await uploader.drain(config: config) == .idle) // by itself it stays set aside
        #expect(q.rejectedCount() == 1)
        #expect(await uploader.drain(config: config, manual: true) == .sent(stored: 1, duplicates: 0, skipped: 0))
        #expect(try server.devicesAndTimes() == [[1_790_000_000, 1_790_000_300], [1_790_000_300]])
        #expect(q.rejectedCount() == 0)
    }

    @Test func whatCannotBePutBackStaysSetAsideAndTheQueueGoesOutAllTheSame() async throws {
        let q = try queue([0])
        try q.reject(try q.oldest(1).map(\.name))
        try q.append(Position(sample: sample(0), keptForTime: false)) // the same second waits in the queue: the place is taken
        let server = FakeServer([.init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#), .init(body: #"{"stored":0,"duplicates":1,"skipped":[]}"#)])
        let uploader = Uploader(queue: q, send: server.send)
        #expect(await uploader.drain(config: config, manual: true) == .sent(stored: 1, duplicates: 0, skipped: 0))
        #expect(q.rejectedCount() == 1) // nothing was deleted to make room
        #expect(await uploader.drain(config: config, manual: true) == .sent(stored: 0, duplicates: 1, skipped: 0)) // its place is free now
        #expect(q.rejectedCount() == 0)
    }

    @Test func sendNowDuringAnUploadAddsWhatItSendsToTheUploadsResult() async throws {
        let q = try queue([0, 300])
        try q.reject([try q.oldest(2)[1].name]) // set aside by an earlier upload
        let server = FakeServer([.init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#), .init(body: #"{"stored":0,"duplicates":0,"skipped":[0]}"#)])
        let (uploader, gate, first) = try await held(q, server)
        #expect(await uploader.drain(config: config, manual: true) == .busy) // "Send now" during the upload
        await gate.release()
        #expect(await first.value == .sent(stored: 1, duplicates: 0, skipped: 1)) // what the upload stored is not lost from the result
        #expect(try server.devicesAndTimes() == [[1_790_000_000], [1_790_000_300]])
        #expect(q.rejectedCount() == 1)
    }

    @Test func keepsTheQueueWhenTheServerIsDownOrUnreachable() async throws {
        let q = try queue([0, 300])
        let server = FakeServer([.init(status: 503, body: #"{"error":"database unavailable"}"#), .init(error: URLError(.notConnectedToInternet)), .init(body: #"{"stored":2,"duplicates":0,"skipped":[]}"#)])
        let clock = FakeClock()
        let uploader = Uploader(queue: q, send: server.send, now: { clock.now })
        #expect(await uploader.drain(config: config) == .retryLater("server answered 503"))
        clock.advance(.seconds(60))
        guard case .retryLater = await uploader.drain(config: config) else { Issue.record("expected retryLater"); return }
        #expect(q.count() == 2)
        clock.advance(.seconds(60))
        #expect(await uploader.drain(config: config) == .sent(stored: 2, duplicates: 0, skipped: 0))
    }

    @Test func afterAFailedUploadKeptPositionsWaitAMinuteBeforeTheNextTry() async throws {
        let q = try queue([0])
        let clock = FakeClock()
        let server = FakeServer([.init(status: 503, body: #"{"error":"database unavailable"}"#), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let uploader = Uploader(queue: q, send: server.send, now: { clock.now })
        #expect(await uploader.drain(config: config) == .retryLater("server answered 503"))
        #expect(await uploader.drain(config: config) == .paused) // the next kept position
        clock.advance(.seconds(59))
        #expect(await uploader.drain(config: config) == .paused)
        #expect(server.requests.count == 1)
        clock.advance(.seconds(1))
        #expect(await uploader.drain(config: config) == .sent(stored: 1, duplicates: 0, skipped: 0))
    }

    @Test func sendNowDoesNotWaitAndAFailureOfItsOwnStartsTheWaitAnew() async throws {
        let q = try queue([0])
        let clock = FakeClock()
        let server = FakeServer([.init(error: URLError(.timedOut)), .init(status: 500), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let uploader = Uploader(queue: q, send: server.send, now: { clock.now })
        guard case .retryLater = await uploader.drain(config: config) else { Issue.record("expected retryLater"); return }
        clock.advance(.seconds(30))
        #expect(await uploader.drain(config: config, manual: true) == .retryLater("server answered 500")) // tried at once
        clock.advance(.seconds(30)) // a minute after the first failure, half a minute after the second
        #expect(await uploader.drain(config: config) == .paused)
        #expect(server.requests.count == 2)
        clock.advance(.seconds(30))
        #expect(await uploader.drain(config: config) == .sent(stored: 1, duplicates: 0, skipped: 0))
    }

    @Test func aCallWithOtherSettingsDuringAFailingUploadWaitsLikeAnyOther() async throws {
        let q = try queue([0])
        let server = FakeServer([.init(status: 500), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let (uploader, gate, first) = try await held(q, server)
        var other = config
        other.device = "other-device"
        #expect(await uploader.drain(config: other) == .busy) // not manual: it does not lift the wait
        await gate.release()
        #expect(await first.value == .retryLater("server answered 500")) // the failure is what is reported
        #expect(server.requests.count == 1)
    }

    @Test(arguments: [(401, "{}"), (400, "{}"), (413, "{}"), (503, #"{"error":"endpoint disabled: HEALTH_TOKEN not set"}"#)])
    func stopsWhenResendingCannotHelpUntilAskedByHand(status: Int, body: String) async throws {
        let q = try queue([0])
        let server = FakeServer([.init(status: status, body: body), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let uploader = Uploader(queue: q, send: server.send)
        guard case .stopped = await uploader.drain(config: config) else { Issue.record("expected stopped"); return }
        guard case .stopped = await uploader.drain(config: config) else { Issue.record("expected stopped again"); return }
        #expect(server.requests.count == 1) // the second call did not reach the server
        #expect(q.count() == 1)
        #expect(await uploader.drain(config: config, manual: true) == .sent(stored: 1, duplicates: 0, skipped: 0))
    }

    @Test func aStopDoesNotStandForOtherSettings() async throws {
        let q = try queue([0])
        let server = FakeServer([.init(status: 401), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let uploader = Uploader(queue: q, send: server.send)
        guard case .stopped = await uploader.drain(config: config) else { Issue.record("expected stopped"); return }
        var corrected = config
        corrected.token = "corrected-token-not-a-secret"
        #expect(await uploader.drain(config: corrected) == .sent(stored: 1, duplicates: 0, skipped: 0)) // not manual: the stop was the old token's
        #expect(server.requests.count == 2)
    }

    @Test func anAnswerItCannotReadRemovesNothing() async throws {
        let q = try queue([0])
        let server = FakeServer([.init(body: "<html>")])
        guard case .retryLater = await Uploader(queue: q, send: server.send).drain(config: config) else { Issue.record("expected retryLater"); return }
        #expect(q.count() == 1)
    }

    @Test func sendsOneRequestAtATimeAndLeavesAloneWhatIsKeptMeanwhile() async throws {
        let q = try queue([0])
        let gate = Gate()
        let answer = FakeServer.Reply(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)
        let server = FakeServer([answer, answer])
        let uploader = Uploader(queue: q) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let first = Task { await uploader.drain(config: config) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first request is under way

        #expect(await uploader.drain(config: config) == .busy)
        #expect(await uploader.drain(config: config, manual: true) == .busy)
        try q.append(Position(sample: sample(300), keptForTime: false)) // kept while the request is under way
        await gate.release()

        #expect(await first.value == .sent(stored: 2, duplicates: 0, skipped: 0))
        #expect(try server.devicesAndTimes() == [[1_790_000_000], [1_790_000_300]]) // never the same position twice
        #expect(q.count() == 0)
    }

    /// An upload whose first request is held, so that a second call can arrive while it runs.
    func held(_ q: PositionQueue, _ server: FakeServer) async throws -> (Uploader, Gate, Task<UploadOutcome, Never>) {
        let gate = Gate()
        let uploader = Uploader(queue: q) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let first = Task { [config] in await uploader.drain(config: config) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first request is under way
        return (uploader, gate, first)
    }

    @Test func settingsSavedDuringAnUploadAreTriedAfterItAndNoStopStands() async throws {
        let q = try queue([0])
        let answer = FakeServer.Reply(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)
        let server = FakeServer([.init(status: 401), answer, answer])
        let (uploader, gate, first) = try await held(q, server)
        var corrected = config
        corrected.token = "corrected-token-not-a-secret"
        #expect(await uploader.drain(config: corrected, manual: true) == .busy) // Setup saved in Auto
        #expect(await uploader.drain(config: corrected) == .busy) // the next kept position: the manual call is not forgotten
        await gate.release() // the old token's request is answered 401

        #expect(await first.value == .sent(stored: 1, duplicates: 0, skipped: 0))
        #expect(server.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer test-token-not-a-secret", "Bearer corrected-token-not-a-secret"])
        try q.append(Position(sample: sample(300), keptForTime: false))
        #expect(await uploader.drain(config: corrected) == .sent(stored: 1, duplicates: 0, skipped: 0)) // no stop stands
    }

    @Test func otherSettingsDuringAnUploadAreTriedAfterItAlsoWhenTheCallWasNotManual() async throws {
        let q = try queue([0])
        let server = FakeServer([.init(status: 401), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let (uploader, gate, first) = try await held(q, server)
        var corrected = config
        corrected.token = "corrected-token-not-a-secret"
        #expect(await uploader.drain(config: corrected) == .busy) // not manual: the mode went to Auto after a save in Manual
        await gate.release() // the old token's request is answered 401

        #expect(await first.value == .sent(stored: 1, duplicates: 0, skipped: 0)) // the stop was the old token's
        #expect(server.requests.count == 2)
    }

    @Test func whatAnUploadSentStandsWhenTheCallDuringItFindsNothingLeft() async throws {
        let q = try queue([0])
        let server = FakeServer([.init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let (uploader, gate, first) = try await held(q, server)
        #expect(await uploader.drain(config: config, manual: true) == .busy) // "Send now" during the upload
        await gate.release()
        #expect(await first.value == .sent(stored: 1, duplicates: 0, skipped: 0))
        #expect(server.requests.count == 1)
    }

    @Test func aCallDuringAnUploadThatAsksForNothingNewAddsNoUpload() async throws {
        let q = try queue([0])
        let server = FakeServer([.init(status: 500), .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let (uploader, gate, first) = try await held(q, server)
        #expect(await uploader.drain(config: config) == .busy) // the next kept position
        await gate.release()
        #expect(await first.value == .retryLater("server answered 500"))
        #expect(server.requests.count == 1)
    }

    @Test(arguments: [
        #"{"stored":0,"duplicates":0,"skipped":[]}"#, // accounts for none of the two
        #"{"stored":2,"duplicates":0,"skipped":[7]}"#, // a place that is not in the batch
        #"{"stored":1,"duplicates":0,"skipped":[0,0]}"#, // the same place twice
        #"{"stored":3,"duplicates":0,"skipped":[]}"#, // more than were sent
        #"{"stored":3,"duplicates":-1,"skipped":[]}"#, // a negative count
        #"{"stored":-1,"duplicates":3,"skipped":[]}"#, // the other negative count, the sum fitting too
        #"{"stored":1,"duplicates":0,"skipped":[7]}"#, // a place that is not in the batch, the sum fitting
    ])
    func anAnswerThatDoesNotAccountForTheBatchRemovesNothing(body: String) async throws {
        let q = try queue([0, 300])
        let server = FakeServer([.init(body: body)])
        #expect(await Uploader(queue: q, send: server.send).drain(config: config) == .retryLater("the server's answer does not fit the batch"))
        #expect(q.count() == 2)
        #expect(q.rejectedCount() == 0)
    }
}

@Suite struct UploaderHomeTests {
    let config = ServerConfig(baseURL: URL(string: "https://example.invalid")!, token: "test-token-not-a-secret", device: "iphone")

    func queue(_ seconds: [Double]) throws -> PositionQueue {
        let queue = try PositionQueue(directory: scratch())
        for s in seconds { try queue.append(Position(sample: sample(s), keptForTime: false)) }
        return queue
    }

    @Test func theBaseZoneTheServerNamesIsKeptFromTheLastAnswerAndForgottenWhenAnAnswerNamesNone() async throws {
        let home = HomeZone(lat: 42.5, lon: 1.5, radiusM: 300)
        let server = FakeServer([.init(body: #"{"stored":1,"duplicates":0,"skipped":[],"home":{"lat":42.5,"lon":1.5,"radiusM":300}}"#),
                                 .init(body: #"{"stored":1,"duplicates":0,"skipped":[]}"#)])
        let uploader = Uploader(queue: try queue([0, 300]), batchSize: 1, send: server.send)
        #expect(await uploader.home == nil)
        _ = await uploader.drain(config: config)
        #expect(await uploader.home == nil, "the second answer named no base zone, so none is kept")
        let named = Uploader(queue: try queue([0]), send: FakeServer([.init(body: #"{"stored":1,"duplicates":0,"skipped":[],"home":{"lat":42.5,"lon":1.5,"radiusM":300}}"#)]).send)
        _ = await named.drain(config: config)
        #expect(await named.home == home)
    }
}
