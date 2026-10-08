import Foundation

public struct ServerConfig: Equatable, Sendable {
    public var baseURL: URL
    public var token: String
    public var device: String

    public init(baseURL: URL, token: String, device: String) {
        self.baseURL = baseURL
        self.token = token
        self.device = device
    }
}

public enum UploadOutcome: Equatable, Sendable {
    /// Nothing was waiting.
    case idle
    /// Another upload is running. When this call was manual or brought newer settings, the upload goes on once
    /// more with them; a call that is not manual does not lift the wait after a failed upload.
    case busy
    /// The server answered 200 for everything that was waiting.
    case sent(stored: Int, duplicates: Int, skipped: Int)
    /// No connection, a timeout or a 5xx: the queue is kept, and after `Uploader.pause` a kept position tries again.
    case retryLater(String)
    /// The server refuses the token or the request itself: resending cannot help.
    case stopped(String)
    /// An upload failed less than a minute ago: nothing was tried.
    case paused
}

/// Sends the queue, oldest first, one request at a time, and removes a batch only after the server's 200.
public actor Uploader {
    public typealias Send = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    /// How long kept positions wait after a failed upload before one of them tries again.
    public static let pause = Duration.seconds(60)

    private struct Body: Encodable { let device: String; let positions: [Position] }
    private struct Answer: Decodable { let stored: Int; let duplicates: Int; let skipped: [Int]; let home: HomeZone? }

    /// The base zone the last answer named; nil when the last answer named none (or there was no answer yet).
    public private(set) var home: HomeZone?

    private let queue: PositionQueue
    private let batchSize: Int
    private let send: Send
    private let now: @Sendable () -> ContinuousClock.Instant
    private var draining = false
    /// What was asked for while an upload ran.
    private var wanted: (config: ServerConfig, manual: Bool)?
    /// Why resending cannot help, and the settings that earned it: a stop does not stand for other settings.
    private var stopped: (reason: String, config: ServerConfig)?
    /// After a failed upload: until then only a manual call tries.
    private var pausedUntil: ContinuousClock.Instant?

    public init(queue: PositionQueue, batchSize: Int = 50, send: @escaping Send = Uploader.send,
                now: @escaping @Sendable () -> ContinuousClock.Instant = { .now }) {
        self.queue = queue
        self.batchSize = batchSize
        self.send = send
        self.now = now
    }

    /// After a stop only a manual call (Send now, or Setup saved) or one with other settings tries again; for a
    /// minute after a failed upload only a manual one. A manual call also sends what the server skipped before.
    public func drain(config: ServerConfig, manual: Bool = false) async -> UploadOutcome {
        if draining {
            // Not dropped: remembered with the newest settings, and whether a manual call was among them.
            wanted = (config, manual || wanted?.manual == true)
            return .busy
        }
        draining = true
        defer { draining = false; wanted = nil }
        var config = config, outcome = await pass(config: config, manual: manual)
        // A call during the upload asked for more than the upload did when it brought newer settings or was
        // manual: what the upload left is then tried once more, so that a stop the old settings earned does
        // not stand. A call that is not manual waits out a failed upload's minute like any other.
        while let next = wanted, next.manual || next.config != config {
            wanted = nil
            config = next.config
            switch (outcome, await pass(config: config, manual: next.manual)) {
            case (_, .idle), (_, .paused): break // nothing was left or tried: what the upload did stands
            case let (.sent(stored, duplicates, skipped), .sent(more, known, set)):
                outcome = .sent(stored: stored + more, duplicates: duplicates + known, skipped: skipped + set)
            case let (_, again): outcome = again
            }
        }
        return outcome
    }

    private func pass(config: ServerConfig, manual: Bool) async -> UploadOutcome {
        if stopped?.config != config { stopped = nil }
        if manual {
            stopped = nil
            pausedUntil = nil
            // The owner's word is the one way back for what the server skipped: it goes out once more.
            queue.restoreRejected()
        }
        if let stopped { return .stopped(stopped.reason) }
        if let pausedUntil, now() < pausedUntil { return .paused }
        let outcome = await batches(config: config)
        // ponytail: a fixed minute, not a growing wait; grow it if a long outage on the move shows in the battery.
        if case .retryLater = outcome { pausedUntil = now().advanced(by: Uploader.pause) }
        return outcome
    }

    private func batches(config: ServerConfig) async -> UploadOutcome {
        var stored = 0, duplicates = 0, skipped = 0, sentAny = false
        while true {
            let batch: [PositionQueue.Entry]
            do { batch = try queue.oldest(batchSize) } catch { return .retryLater("storage: \(error.localizedDescription)") }
            if batch.isEmpty { return sentAny ? .sent(stored: stored, duplicates: duplicates, skipped: skipped) : .idle }

            var request = URLRequest(url: config.baseURL.appendingPathComponent("positions"), timeoutInterval: 60)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            do { request.httpBody = try JSONEncoder().encode(Body(device: config.device, positions: batch.map(\.position))) } catch {
                return stop("the batch could not be encoded", config)
            }

            let data: Data, status: Int
            do {
                let (d, response) = try await send(request)
                data = d
                status = (response as? HTTPURLResponse)?.statusCode ?? 0
            } catch { return .retryLater(error.localizedDescription) }

            switch status {
            case 200:
                guard let answer = try? JSONDecoder().decode(Answer.self, from: data) else { return .retryLater("the server's answer could not be read") }
                home = answer.home?.usable
                let set = Set(answer.skipped)
                // Removing is the one step that cannot be undone: an answer that does not account for exactly
                // this batch removes nothing.
                guard answer.stored >= 0, answer.duplicates >= 0, set.count == answer.skipped.count,
                      set.allSatisfy(batch.indices.contains), answer.stored + answer.duplicates + set.count == batch.count else {
                    return .retryLater("the server's answer does not fit the batch")
                }
                do {
                    try queue.reject(batch.enumerated().filter { set.contains($0.offset) }.map(\.element.name))
                    try queue.remove(batch.enumerated().filter { !set.contains($0.offset) }.map(\.element.name))
                } catch { return .retryLater("storage: \(error.localizedDescription)") }
                stored += answer.stored; duplicates += answer.duplicates; skipped += answer.skipped.count; sentAny = true
            default:
                if let reason = Uploader.stopReason(status: status, data: data) { return stop(reason, config) }
                return .retryLater("server answered \(status)")
            }
        }
    }

    private func stop(_ reason: String, _ config: ServerConfig) -> UploadOutcome {
        stopped = (reason, config)
        return .stopped(reason)
    }
}

extension Uploader {
    /// Every upload goes through this session, and it never follows a redirect: a 307 would resend the batch, and
    /// perhaps the token, to an address Setup does not show, plain HTTP on the LAN included. The 3xx itself
    /// comes back and is a failed upload.
    public static let send: Send = { try await shared.data(for: $0) }
    private static let shared = session(.default)

    static func session(_ configuration: URLSessionConfiguration) -> URLSession {
        URLSession(configuration: configuration, delegate: RefuseRedirects(), delegateQueue: nil)
    }

    private final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    /// A server's text as Status shows it and the backed-up report and ledger keep it: one line, at most 200
    /// characters, with line breaks and control or direction marks turned into spaces.
    static func serverText(_ text: String) -> String {
        String(String(text.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) ? " " : Character($0) }).prefix(200))
    }

    /// Why resending cannot help, for an answer that says so; nil for every other answer.
    /// One place for both uploaders: the texts follow the server's.
    static func stopReason(status: Int, data: Data) -> String? {
        struct Refusal: Decodable { let error: String }
        switch status {
        case 401: return "the server rejects the token"
        case 400, 413: return "the server refuses the request (\(status)); a fault in the app"
        case 503 where (try? JSONDecoder().decode(Refusal.self, from: data))?.error.hasPrefix("endpoint disabled") == true:
            return "the server has no token configured"
        default: return nil
        }
    }
}

extension ServerConfig {
    /// nil unless the address is HTTPS (plain HTTP only for localhost), the token is not empty
    /// and the device name is 1 to 40 of a-z, 0-9 and -.
    public init?(server: String, token: String, device: String) {
        guard let url = ServerConfig.address(server), !token.isEmpty,
              device.range(of: "^[a-z0-9-]{1,40}$", options: .regularExpression) != nil else { return nil }
        self.init(baseURL: url, token: token, device: device)
    }

    /// An address the app talks to: HTTPS, or plain HTTP for localhost only, with no user part, query or fragment.
    /// nil for anything else.
    /// Scheme and host mean the same in any case and come back in lower case: the keyboard likes to begin
    /// with a capital, and one server must not look like two.
    static func address(_ text: String) -> URL? {
        guard var parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = parts.scheme?.lowercased(), let host = parts.host?.lowercased(), !host.isEmpty,
              // A user part makes the host another one than it seems; a query or a fragment would ride on every request.
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1"].contains(host)) else { return nil }
        parts.scheme = scheme
        parts.host = host
        return parts.url
    }
}
