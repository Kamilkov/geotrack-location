import Foundation
import Testing
@testable import GeoTrackKit

let workoutsConfig = ServerConfig(baseURL: URL(string: "https://example.invalid")!, token: "test-token-not-a-secret", device: "trial-iphone")

/// The server's answer for a stored workout.
func stored(_ id: String = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D", heartRate: Int = 5, route: Int = 3) -> FakeServer.Reply {
    .init(body: #"{"workouts":[{"id":"\#(id)","name":"Outdoor Walk","hrSamples":\#(heartRate),"routePoints":\#(route),"coarsened":1,"startsInPrivateZone":true,"endsInPrivateZone":false}],"skipped":[]}"#)
}

@Suite struct WorkoutUploaderTests {
    @Test func sendsOneWorkoutToTheWorkoutsEndpointUnderTheDeviceName() async throws {
        let server = FakeServer([stored()])
        #expect(await WorkoutUploader(send: server.send).upload(walk(), config: workoutsConfig) == .stored(heartRate: 5, route: 3))
        let request = try #require(server.requests.first)
        #expect(request.url?.absoluteString == "https://example.invalid/health/workouts")
        #expect(request.httpMethod == "POST")
        #expect(request.timeoutInterval == 120)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token-not-a-secret")
        let body = try object(request.httpBody)
        #expect(body["device"] as? String == "trial-iphone")
        #expect(((body["data"] as? [String: Any])?["workouts"] as? [[String: Any]])?.count == 1)
    }

    @Test func aWorkoutTheServerSkippedIsRejectedWithTheServersReason() async {
        let server = FakeServer([.init(body: #"{"workouts":[],"skipped":[{"index":0,"id":"A","reason":"not stored: value too large"}]}"#)])
        #expect(await WorkoutUploader(send: server.send).upload(walk(), config: workoutsConfig) == .rejected("not stored: value too large"))
        // The server names a skipped workout's id only when it could read one.
        let unnamed = FakeServer([.init(body: #"{"workouts":[],"skipped":[{"index":0,"reason":"no start"}]}"#)])
        #expect(await WorkoutUploader(send: unnamed.send).upload(walk(), config: workoutsConfig) == .rejected("no start"))
    }

    @Test(arguments: [
        #"{"workouts":[],"skipped":[]}"#, // names nothing
        #"{"workouts":[{"id":"SOMETHING-ELSE","name":"x","hrSamples":1,"routePoints":1}],"skipped":[]}"#, // names another workout
        "<html>", // a proxy's page
    ])
    func anAnswerThatDoesNotNameTheWorkoutIsAFailure(body: String) async {
        let server = FakeServer([.init(body: body)])
        guard case .retryLater = await WorkoutUploader(send: server.send).upload(walk(), config: workoutsConfig) else { Issue.record("expected retryLater"); return }
    }

    /// The reason goes into the backed-up ledger and onto Status: one line of at most 200 characters.
    @Test func theServersReasonIsCutToOneShortLine() async {
        let long = "a\\nb\\u202e" + String(repeating: "x", count: 1000)
        let server = FakeServer([.init(body: #"{"workouts":[],"skipped":[{"index":0,"reason":"\#(long)"}]}"#)])
        #expect(await WorkoutUploader(send: server.send).upload(walk(), config: workoutsConfig) == .rejected("a b " + String(repeating: "x", count: 196)))
    }

    @Test func noConnectionATimeoutOrA5xxIsTriedAgainLater() async {
        let server = FakeServer([.init(status: 503, body: #"{"error":"database unavailable"}"#), .init(error: URLError(.timedOut)), .init(status: 502)])
        let uploader = WorkoutUploader(send: server.send)
        #expect(await uploader.upload(walk(), config: workoutsConfig) == .retryLater("server answered 503"))
        guard case .retryLater = await uploader.upload(walk(), config: workoutsConfig) else { Issue.record("expected retryLater"); return }
        #expect(await uploader.upload(walk(), config: workoutsConfig) == .retryLater("server answered 502"))
    }

    @Test(arguments: [(401, "{}"), (400, "{}"), (413, "{}"), (503, #"{"error":"endpoint disabled: HEALTH_TOKEN not set"}"#)])
    func stopsWhenResendingCannotHelp(status: Int, body: String) async {
        let server = FakeServer([.init(status: status, body: body)])
        guard case .stopped = await WorkoutUploader(send: server.send).upload(walk(), config: workoutsConfig) else { Issue.record("expected stopped"); return }
    }

    @Test func aServerThatNamesTheDeviceConfirmsItWithoutAWorkout() async throws {
        let server = FakeServer([.init(body: #"{"device":"trial-iphone","workouts":[],"skipped":[]}"#)])
        #expect(await WorkoutUploader(send: server.send).confirmDevice(config: workoutsConfig) == nil)
        let request = try #require(server.requests.first)
        #expect(request.url?.absoluteString == "https://example.invalid/health/workouts")
        #expect(request.httpMethod == "POST")
        #expect(request.timeoutInterval == 120)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-token-not-a-secret")
        let body = try object(request.httpBody)
        #expect(body["device"] as? String == "trial-iphone")
        #expect(((body["data"] as? [String: Any])?["workouts"] as? [Any])?.isEmpty == true)
    }

    @Test(arguments: [
        #"{"workouts":[],"skipped":[]}"#, // a server from before the app's workouts
        #"{"device":"iphone","workouts":[],"skipped":[]}"#, // another device
        "<html>", // a proxy's page
    ])
    func aServerThatDoesNotNameTheDeviceIsNotSentWorkouts(body: String) async {
        let server = FakeServer([.init(body: body)])
        #expect(await WorkoutUploader(send: server.send).confirmDevice(config: workoutsConfig)
            == .stopped("the server does not store workouts under a device name yet: deploy it first"))
    }

    @Test func aConfirmationMeetsTheOtherAnswersAsAnUploadDoes() async {
        let server = FakeServer([.init(status: 401), .init(status: 503, body: #"{"error":"database unavailable"}"#), .init(error: URLError(.timedOut))])
        let uploader = WorkoutUploader(send: server.send)
        #expect(await uploader.confirmDevice(config: workoutsConfig) == .stopped("the server rejects the token"))
        #expect(await uploader.confirmDevice(config: workoutsConfig) == .retryLater("server answered 503"))
        guard case .retryLater = await uploader.confirmDevice(config: workoutsConfig) else { Issue.record("expected retryLater"); return }
    }
}
