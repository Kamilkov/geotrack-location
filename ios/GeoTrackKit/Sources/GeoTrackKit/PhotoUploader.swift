import Foundation

/// What the server answered for one photo.
public enum PhotoAnswer: Equatable, Sendable {
    /// Stored. `borrowed`: placed by a position of the live device, because the photo had none of its own.
    case stored(borrowed: Bool, id: String)
    /// Decided but not kept: a private zone, or no usable position.
    case dropped(reason: String, id: String)
    /// A 400 or a 413: resending the same photo cannot help.
    case failed(reason: String)
}

/// One answered photo: its name in the queue, its file name, and the answer.
public struct PhotoResult: Equatable, Sendable {
    public var name: String
    public var fileName: String
    public var answer: PhotoAnswer

    public init(name: String, fileName: String, answer: PhotoAnswer) {
        self.name = name
        self.fileName = fileName
        self.answer = answer
    }
}

public enum PhotoRound: Equatable, Sendable {
    /// Another round is running; it also takes what was queued meanwhile, and goes on with this call's settings
    /// when they are newer or the call was manual.
    case busy
    /// Every photo that could be read was answered.
    case done
    /// No connection, a timeout, a 5xx or an answer that names no status: the photo stays, a later round tries again.
    case retryLater(String)
    /// The server refuses the token: resending cannot help.
    case stopped(String)
    /// The round's task was cancelled (iOS's background time ran out): nothing further was sent.
    case interrupted
}

/// Sends the queue, oldest first, one photo per request, and removes a photo only after the server's answer
/// for it was read.
public actor PhotoUploader {
    private struct Answer: Decodable { let id: String; let status: String; let reason: String?; let positionSource: String? }
    private struct Refusal: Decodable { let error: String }

    private let queue: PhotoQueue
    private let send: Uploader.Send
    private let onAnswer: @Sendable (PhotoResult) async -> Void
    private var running = false
    /// What was asked for while a round ran.
    private var wanted: (config: ServerConfig, manual: Bool)?
    /// Why resending cannot help, and the settings that earned it: a stop does not stand for other settings.
    private var stopped: (reason: String, config: ServerConfig)?

    public init(queue: PhotoQueue, send: @escaping Uploader.Send = { try await URLSession.shared.data(for: $0) },
                onAnswer: @escaping @Sendable (PhotoResult) async -> Void = { _ in }) {
        self.queue = queue
        self.send = send
        self.onAnswer = onAnswer
    }

    /// One round. It runs in the caller's task: cancelling that task ends the round before its next request,
    /// and a request that was under way leaves its photo in the queue. After a stop only a manual round
    /// (a pick, "Send now", Setup saved) or one with other settings tries again.
    public func round(config: ServerConfig, manual: Bool = false) async -> PhotoRound {
        if running {
            // Not dropped: remembered with the newest settings, and whether a manual call was among them.
            wanted = (config, manual || wanted?.manual == true)
            return .busy
        }
        running = true
        defer { running = false; wanted = nil }
        var config = config, outcome = await pass(config: config, manual: manual)
        // A call during the round asked for more than the round did when it brought newer settings or was
        // manual: what the round left is then tried once more, so that a stop the old settings earned does not
        // stand. After iOS ended the round's time nothing goes out: the task stays cancelled.
        while let next = wanted, next.manual || next.config != config {
            wanted = nil
            config = next.config
            outcome = await pass(config: config, manual: next.manual)
        }
        return outcome
    }

    private func pass(config: ServerConfig, manual: Bool) async -> PhotoRound {
        if manual || stopped?.config != config { stopped = nil }
        if let stopped { return .stopped(stopped.reason) }

        // Listed anew for every photo: what is queued during the round goes out in it.
        var passed: Set<String> = []
        while let name = queue.names().first(where: { !passed.contains($0) }) {
            if Task.isCancelled { return .interrupted }
            guard let photo = queue.photo(name) else {
                passed.insert(name) // not readable for now, or no photo and removed
                continue
            }
            var request = URLRequest(url: config.baseURL.appendingPathComponent("photos"), timeoutInterval: 60)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
            guard let body = try? JSONEncoder().encode(photo) else { return .retryLater("the photo could not be encoded") }
            request.httpBody = body

            let data: Data, status: Int
            do {
                let (d, response) = try await send(request)
                data = d
                status = (response as? HTTPURLResponse)?.statusCode ?? 0
            } catch { return Task.isCancelled ? .interrupted : .retryLater(error.localizedDescription) }

            let answer: PhotoAnswer
            switch status {
            case 200:
                guard let a = try? JSONDecoder().decode(Answer.self, from: data), ["stored", "dropped"].contains(a.status) else {
                    return .retryLater("the server's answer names no status")
                }
                answer = a.status == "stored" ? .stored(borrowed: a.positionSource == "owntracks", id: a.id) : .dropped(reason: a.reason ?? "no reason given", id: a.id)
            case 400, 413:
                // About this one photo, unlike a 400 for positions or workouts: it goes, the round goes on.
                answer = .failed(reason: (try? JSONDecoder().decode(Refusal.self, from: data))?.error ?? "server answered \(status)")
            default:
                if let reason = Uploader.stopReason(status: status, data: data) {
                    stopped = (reason, config)
                    return .stopped(reason)
                }
                return .retryLater("server answered \(status)")
            }
            // Removed first: an answer is counted once, also when the removal fails and the photo goes out again.
            do { try queue.remove(name) } catch { return .retryLater("storage: \(error.localizedDescription)") }
            await onAnswer(PhotoResult(name: name, fileName: photo.fileName, answer: answer))
        }
        return .done
    }
}
