import Foundation
import Testing
@testable import GeoTrackKit

/// The server's answer for a stored photo.
func storedPhoto(_ id: String = "3f9a12c4-0000-5000-8000-000000000001", source: String = "photo") -> FakeServer.Reply {
    .init(body: #"{"id":"\#(id)","status":"stored","reason":null,"positionSource":"\#(source)"}"#)
}

/// The answers a round handed on, in order.
actor Answers {
    private(set) var all: [PhotoResult] = []
    func add(_ result: PhotoResult) { all.append(result) }
}

/// The time limit: a test here waits for a request to arrive, and a wait that never ends would hold the whole run.
@Suite(.timeLimit(.minutes(1))) struct PhotoUploaderTests {
    let config = ServerConfig(baseURL: URL(string: "https://example.invalid")!, token: "test-token-not-a-secret", device: "trial-iphone")
    let id = "3f9a12c4-0000-5000-8000-000000000001"

    /// A queue holding `fileNames`, oldest first, an uploader over `send`, and the answers it hands on.
    func make(_ fileNames: [String], _ send: @escaping Uploader.Send) throws -> (PhotoUploader, PhotoQueue, Answers, [String]) {
        let queue = try PhotoQueue(directory: scratch())
        let names = try fileNames.enumerated().map { try queue.append(photo($0.element), at: origin.addingTimeInterval(Double($0.offset))) }
        let answers = Answers()
        return (PhotoUploader(queue: queue, send: send, onAnswer: { await answers.add($0) }), queue, answers, names)
    }

    @Test func sendsOnePhotoPerRequestOldestFirstToThePhotosEndpoint() async throws {
        let server = FakeServer([storedPhoto(), storedPhoto()])
        let (uploader, queue, _, _) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC"], server.send)
        #expect(await uploader.round(config: config) == .done)
        #expect(queue.count() == 0)
        #expect(try server.requests.map { try object($0.httpBody)["fileName"] as? String } == ["IMG_0001.HEIC", "IMG_0002.HEIC"])
        let request = try #require(server.requests.first)
        #expect(request.url?.absoluteString == "https://example.invalid/photos")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token-not-a-secret")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.timeoutInterval == 60)
        #expect(try JSONDecoder().decode(Photo.self, from: #require(request.httpBody)) == photo("IMG_0001.HEIC"))
    }

    @Test func aStoredPhotoIsRemovedAndHandedOnWithItsIDAndWhetherItsPositionWasBorrowed() async throws {
        let server = FakeServer([storedPhoto(), storedPhoto(source: "owntracks")])
        let (uploader, _, answers, names) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC"], server.send)
        _ = await uploader.round(config: config)
        #expect(await answers.all == [PhotoResult(name: names[0], fileName: "IMG_0001.HEIC", answer: .stored(borrowed: false, id: id)),
                                      PhotoResult(name: names[1], fileName: "IMG_0002.HEIC", answer: .stored(borrowed: true, id: id))])
    }

    @Test func aDroppedPhotoIsRemovedAndHandedOnWithTheServersReason() async throws {
        let server = FakeServer([.init(body: #"{"id":"\#(id)","status":"dropped","reason":"private zone","positionSource":null}"#)])
        let (uploader, queue, answers, names) = try make(["IMG_0001.HEIC"], server.send)
        #expect(await uploader.round(config: config) == .done)
        #expect(queue.count() == 0)
        #expect(await answers.all == [PhotoResult(name: names[0], fileName: "IMG_0001.HEIC", answer: .dropped(reason: "private zone", id: id))])
    }

    @Test(arguments: [400, 413])
    func aPhotoTheServerRefusesIsRemovedAsFailedAndTheRoundGoesOn(status: Int) async throws {
        let server = FakeServer([.init(status: status, body: #"{"error":"thumbnail larger than 500 KB"}"#), storedPhoto()])
        let (uploader, queue, answers, _) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC"], server.send)
        #expect(await uploader.round(config: config) == .done)
        #expect(queue.count() == 0)
        #expect(await answers.all.map(\.answer) == [.failed(reason: "thumbnail larger than 500 KB"), .stored(borrowed: false, id: id)])
    }

    @Test func aRefusalWithoutAReadableReasonNamesTheStatus() async throws {
        let server = FakeServer([.init(status: 413, body: "<html>too large</html>")])
        let (uploader, _, answers, _) = try make(["IMG_0001.HEIC"], server.send)
        _ = await uploader.round(config: config)
        #expect(await answers.all.map(\.answer) == [.failed(reason: "server answered 413")])
    }

    @Test(arguments: [(401, "{}", "the server rejects the token"), (503, #"{"error":"endpoint disabled: HEALTH_TOKEN not set"}"#, "the server has no token configured")])
    func stopsWhenResendingCannotHelpUntilAManualRound(status: Int, body: String, reason: String) async throws {
        let server = FakeServer([.init(status: status, body: body), storedPhoto()])
        let (uploader, queue, _, _) = try make(["IMG_0001.HEIC"], server.send)
        #expect(await uploader.round(config: config) == .stopped(reason))
        #expect(await uploader.round(config: config) == .stopped(reason))
        #expect(server.requests.count == 1) // the second round did not reach the server
        #expect(queue.count() == 1)
        #expect(await uploader.round(config: config, manual: true) == .done)
        #expect(queue.count() == 0)
    }

    @Test func aStopDoesNotStandForOtherSettings() async throws {
        let server = FakeServer([.init(status: 401), storedPhoto()])
        let (uploader, queue, _, _) = try make(["IMG_0001.HEIC"], server.send)
        #expect(await uploader.round(config: config) == .stopped("the server rejects the token"))
        var corrected = config
        corrected.token = "corrected-token-not-a-secret"
        #expect(await uploader.round(config: corrected) == .done) // not manual: the stop was the old token's
        #expect(queue.count() == 0)
    }

    @Test(arguments: [FakeServer.Reply(error: URLError(.timedOut)), .init(status: 500), .init(status: 503, body: #"{"error":"database unavailable"}"#),
                      .init(body: "{}"), .init(body: #"{"id":"x","status":"queued"}"#), .init(body: "not json")])
    func aFailureLeavesThePhotoAndEndsTheRoundAndTheNextRoundSendsTheRest(reply: FakeServer.Reply) async throws {
        let server = FakeServer([storedPhoto(), reply, storedPhoto(), storedPhoto()])
        let (uploader, queue, answers, names) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC", "IMG_0003.HEIC"], server.send)
        guard case .retryLater = await uploader.round(config: config) else {
            Issue.record("the round did not end as a failure to retry")
            return
        }
        #expect(server.requests.count == 2)
        #expect(queue.names() == Array(names[1...]))
        #expect(await uploader.round(config: config) == .done)
        #expect(await answers.all.map(\.fileName) == ["IMG_0001.HEIC", "IMG_0002.HEIC", "IMG_0003.HEIC"])
    }

    @Test func aRoundCancelledDuringARequestLeavesItsPhotoSendsNothingFurtherAndHasEnded() async throws {
        let gate = Gate()
        let server = FakeServer([storedPhoto(), storedPhoto()])
        let (uploader, queue, answers, _) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC"]) { request in
            await gate.pass()
            try Task.checkCancellation() // as URLSession does: a cancelled task's request fails
            return try await server.send(request)
        }
        let round = Task { await uploader.round(config: config) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first request is under way
        round.cancel() // iOS's background time ran out
        await gate.release()
        #expect(await round.value == .interrupted)
        #expect(server.requests.isEmpty)
        #expect(queue.count() == 2)
        #expect(await answers.all.isEmpty)

        #expect(await uploader.round(config: config) == .done) // not "busy": the cancelled round has ended
        #expect(queue.count() == 0)
    }

    @Test func aRoundCancelledBetweenTwoPhotosKeepsTheAnswerItReadAndSendsNoFurtherPhoto() async throws {
        let gate = Gate()
        let server = FakeServer([storedPhoto(), storedPhoto()])
        let (uploader, queue, answers, names) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC"]) { request in
            await gate.pass()
            return try await server.send(request) // the answer arrives although the task was cancelled meanwhile
        }
        let round = Task { await uploader.round(config: config) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) }
        round.cancel()
        await gate.release()
        #expect(await round.value == .interrupted)
        #expect(server.requests.count == 1)
        #expect(queue.names() == [names[1]])
        #expect(await answers.all.map(\.fileName) == ["IMG_0001.HEIC"])
    }

    @Test func aStoredPhotoWhoseAnswerWasLostIsSentAgain() async throws {
        let server = FakeServer([.init(error: URLError(.networkConnectionLost)), storedPhoto()]) // the server stored it; the answer never arrived
        let (uploader, queue, answers, _) = try make(["IMG_0001.HEIC"], server.send)
        _ = await uploader.round(config: config)
        #expect(queue.count() == 1)
        #expect(await uploader.round(config: config) == .done)
        #expect(server.requests.count == 2)
        #expect(await answers.all.count == 1)
    }

    @Test func onlyOneRoundRunsAndItAlsoTakesWhatIsQueuedMeanwhile() async throws {
        let gate = Gate()
        let server = FakeServer([storedPhoto(), storedPhoto()])
        let (uploader, queue, _, _) = try make(["IMG_0001.HEIC"]) { request in
            await gate.pass()
            return try await server.send(request)
        }
        let round = Task { await uploader.round(config: config) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) }
        try queue.append(photo("IMG_0002.HEIC")) // a second pick during the round
        #expect(await uploader.round(config: config) == .busy)
        await gate.release()
        #expect(await round.value == .done)
        #expect(try server.requests.map { try object($0.httpBody)["fileName"] as? String } == ["IMG_0001.HEIC", "IMG_0002.HEIC"])
    }

    /// A round whose first request is held, so that a second call can arrive while it runs.
    func held(_ fileNames: [String], _ server: FakeServer, checksCancellation: Bool = false) async throws -> (PhotoUploader, PhotoQueue, Gate, Task<PhotoRound, Never>) {
        let gate = Gate()
        let (uploader, queue, _, _) = try make(fileNames) { request in
            await gate.pass()
            if checksCancellation { try Task.checkCancellation() }
            return try await server.send(request)
        }
        let round = Task { [config] in await uploader.round(config: config) }
        while await gate.arrived == 0 { try await Task.sleep(for: .milliseconds(2)) } // the first request is under way
        return (uploader, queue, gate, round)
    }

    @Test func settingsSavedDuringARoundAreTriedAfterItAndNoStopStands() async throws {
        let server = FakeServer([.init(status: 401), storedPhoto(), storedPhoto()])
        let (uploader, queue, gate, round) = try await held(["IMG_0001.HEIC"], server)
        var corrected = config
        corrected.token = "corrected-token-not-a-secret"
        #expect(await uploader.round(config: corrected, manual: true) == .busy) // Setup saved in Auto
        #expect(await uploader.round(config: corrected) == .busy) // the next photo of a pick: the manual call is not forgotten
        await gate.release() // the old token's request is answered 401

        #expect(await round.value == .done)
        #expect(server.requests.map { $0.value(forHTTPHeaderField: "Authorization") } == ["Bearer test-token-not-a-secret", "Bearer corrected-token-not-a-secret"])
        #expect(queue.count() == 0)
        try queue.append(photo("IMG_0002.HEIC"))
        #expect(await uploader.round(config: corrected) == .done) // a round that is not manual goes on: no stop stands
    }

    @Test func otherSettingsDuringARoundAreTriedAfterItAlsoWhenTheCallWasNotManual() async throws {
        let server = FakeServer([.init(status: 401), storedPhoto()])
        let (uploader, queue, gate, round) = try await held(["IMG_0001.HEIC"], server)
        var corrected = config
        corrected.token = "corrected-token-not-a-secret"
        #expect(await uploader.round(config: corrected) == .busy) // not manual: the mode went to Auto after a save in Manual
        await gate.release() // the old token's request is answered 401

        #expect(await round.value == .done) // the stop was the old token's
        #expect(queue.count() == 0)
    }

    @Test func sendNowDuringARoundLiftsTheStopTheRoundEndsWith() async throws {
        let server = FakeServer([.init(status: 401), storedPhoto()])
        let (uploader, queue, gate, round) = try await held(["IMG_0001.HEIC"], server)
        #expect(await uploader.round(config: config, manual: true) == .busy)
        await gate.release()
        #expect(await round.value == .done)
        #expect(queue.count() == 0)
    }

    @Test func aCallDuringARoundThatAsksForNothingNewAddsNoRound() async throws {
        let server = FakeServer([.init(status: 500), storedPhoto()])
        let (uploader, queue, gate, round) = try await held(["IMG_0001.HEIC"], server)
        #expect(await uploader.round(config: config) == .busy) // the next photo of a pick
        await gate.release()
        #expect(await round.value == .retryLater("server answered 500"))
        #expect(server.requests.count == 1)
        #expect(queue.count() == 1)
    }

    @Test func anInterruptedRoundDropsWhatWasAskedForDuringIt() async throws {
        let server = FakeServer([storedPhoto()])
        let (uploader, queue, gate, round) = try await held(["IMG_0001.HEIC"], server, checksCancellation: true)
        #expect(await uploader.round(config: config, manual: true) == .busy)
        round.cancel() // iOS's background time ran out
        await gate.release()
        #expect(await round.value == .interrupted)
        #expect(server.requests.isEmpty)
        #expect(queue.count() == 1)
    }

    @Test func aPhotoThatCannotBeRemovedEndsTheRoundAndItsAnswerIsNotCountedYet() async throws {
        let server = FakeServer([storedPhoto(), storedPhoto()])
        let (uploader, queue, answers, names) = try make(["IMG_0001.HEIC"], server.send)
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: queue.directory.path) // readable, not writable
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: queue.directory.path) }
        guard case let .retryLater(reason) = await uploader.round(config: config), reason.hasPrefix("storage") else {
            Issue.record("the round did not end as a storage failure")
            return
        }
        #expect(server.requests.count == 1) // not sent again and again in the same round
        #expect(queue.names() == names)
        #expect(await answers.all.isEmpty) // counted when it is removed: a later round sends it again
    }

    @Test func aFileThatCannotBeReadIsPassedOverAndTheOthersGo() async throws {
        let server = FakeServer([storedPhoto()])
        let (uploader, queue, _, names) = try make(["IMG_0001.HEIC", "IMG_0002.HEIC"], server.send)
        let file = queue.directory.appendingPathComponent(names[0])
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: file.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path) }
        #expect(await uploader.round(config: config) == .done)
        #expect(queue.names() == [names[0]])
        #expect(try server.requests.map { try object($0.httpBody)["fileName"] as? String } == ["IMG_0002.HEIC"])
    }

    @Test func nothingWaitingIsARoundWithoutARequest() async throws {
        let server = FakeServer([])
        let (uploader, _, _, _) = try make([], server.send)
        #expect(await uploader.round(config: config) == .done)
        #expect(server.requests.isEmpty)
    }
}
