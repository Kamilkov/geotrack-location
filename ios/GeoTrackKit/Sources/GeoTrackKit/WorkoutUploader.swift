import Foundation

public enum WorkoutOutcome: Equatable, Sendable {
    /// The server stored the workout: what it counted.
    case stored(heartRate: Int, route: Int)
    /// The server skipped the workout.
    case rejected(String)
    /// No connection, a timeout, a 5xx, or an answer that does not name the workout: the next check tries again.
    case retryLater(String)
    /// The server refuses the token or the request itself: resending cannot help.
    case stopped(String)
}

/// Sends one workout per request, because a resend replaces the stored copy.
public struct WorkoutUploader: Sendable {
    private struct Answer: Decodable {
        struct Stored: Decodable { let id: String; let hrSamples: Int; let routePoints: Int }
        struct Skipped: Decodable { let index: Int; let reason: String }
        let workouts: [Stored]
        let skipped: [Skipped]
    }

    /// Any answer but a 200: what it means for the upload.
    private struct NotOK: Error { let outcome: WorkoutOutcome }

    private let send: Uploader.Send

    public init(send: @escaping Uploader.Send = Uploader.send) {
        self.send = send
    }

    public func upload(_ workout: Workout, config: ServerConfig) async -> WorkoutOutcome {
        let data: Data
        do throws(NotOK) { data = try await post(WorkoutBody(device: config.device, workout: workout), config: config) } catch { return error.outcome }
        guard let answer = try? JSONDecoder().decode(Answer.self, from: data) else { return .retryLater("the server's answer could not be read") }
        if let stored = answer.workouts.first(where: { $0.id == workout.id }) { return .stored(heartRate: stored.hrSamples, route: stored.routePoints) }
        if let skipped = answer.skipped.first(where: { $0.index == 0 }) { return .rejected(Uploader.serverText(skipped.reason)) }
        return .retryLater("the server's answer does not name the workout")
    }

    /// Asks the server, without sending a workout, whether it stores workouts under the device name it is given.
    /// A server from before the app's workouts ignores the name and would store them as the live device's,
    /// replacing Health Auto Export's copies. nil when the server confirms the name.
    public func confirmDevice(config: ServerConfig) async -> WorkoutOutcome? {
        struct Empty: Encodable { let device: String; let data = ["workouts": [String]()] }
        struct Named: Decodable { let device: String? }
        let data: Data
        do throws(NotOK) { data = try await post(Empty(device: config.device), config: config) } catch { return error.outcome }
        guard (try? JSONDecoder().decode(Named.self, from: data))?.device == config.device else {
            return .stopped("the server does not store workouts under a device name yet: deploy it first")
        }
        return nil
    }

    /// Posts to the workouts endpoint: the body of a 200, or what any other answer means.
    private func post(_ body: some Encodable, config: ServerConfig) async throws(NotOK) -> Data {
        var request = URLRequest(url: config.baseURL.appendingPathComponent("health/workouts"), timeoutInterval: 120)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        do { request.httpBody = try JSONEncoder().encode(body) } catch { throw NotOK(outcome: .stopped("the request could not be encoded")) }

        let data: Data, status: Int
        do {
            let (d, response) = try await send(request)
            data = d
            status = (response as? HTTPURLResponse)?.statusCode ?? 0
        } catch { throw NotOK(outcome: .retryLater(error.localizedDescription)) }

        guard status == 200 else {
            throw NotOK(outcome: Uploader.stopReason(status: status, data: data).map { .stopped($0) } ?? .retryLater("server answered \(status)"))
        }
        return data
    }
}
