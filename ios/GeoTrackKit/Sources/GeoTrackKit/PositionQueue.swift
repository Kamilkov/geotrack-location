import Foundation

/// The positions waiting for the server: one small file each, oldest first by name.
/// The only place a position lives until the server has confirmed it.
public struct PositionQueue: Sendable {
    public struct Entry: Equatable, Sendable {
        public let name: String
        public let position: Position
    }

    public let directory: URL
    private var rejected: URL { directory.appendingPathComponent("rejected", isDirectory: true) }

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: rejected, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var dir = directory
        try dir.setResourceValues(values)
    }

    /// Written whole or not at all, and readable while the phone is locked (after its first unlock).
    public func append(_ position: Position) throws {
        let data = try JSONEncoder().encode(position)
        let name = String(format: "%012ld.json", position.tst)
        try data.write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    public func count() -> Int { names(in: directory).count }
    public func rejectedCount() -> Int { names(in: rejected).count }

    /// The oldest positions. A file whose content is not a position is set aside, so it never blocks the queue.
    /// A file that cannot be read right now (the phone is locked before its first unlock, a passing I/O error)
    /// stays where it is and is passed over: the next call tries it again.
    public func oldest(_ limit: Int) throws -> [Entry] {
        var out: [Entry] = []
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
        for name in names {
            if out.count >= limit { break }
            guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { continue }
            if let position = try? JSONDecoder().decode(Position.self, from: data) {
                out.append(Entry(name: name, position: position))
            } else {
                try? reject([name])
            }
        }
        return out
    }

    public func remove(_ names: [String]) throws {
        for name in names { try FileManager.default.removeItem(at: directory.appendingPathComponent(name)) }
    }

    /// Sets positions aside instead of deleting them: the server would not take them.
    public func reject(_ names: [String]) throws {
        for name in names {
            let target = rejected.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: target)
            try FileManager.default.moveItem(at: directory.appendingPathComponent(name), to: target)
        }
    }

    /// Puts what was set aside back into the queue, for one more try. A position that cannot be moved (its
    /// second waits in the queue already, or the folder cannot be written) stays set aside: nothing is deleted.
    public func restoreRejected() {
        for name in names(in: rejected) {
            try? FileManager.default.moveItem(at: rejected.appendingPathComponent(name), to: directory.appendingPathComponent(name))
        }
    }

    private func names(in dir: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    }
}
