import Foundation

/// The photos waiting for the server: one file each, oldest first by name. A photo leaves the queue only
/// after the server's answer for it was read. The originals stay in Photos, so nothing here is the only copy.
public struct PhotoQueue: Sendable {
    public let directory: URL

    public init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // The fields hold precise places: out of backups, like the position queue.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var dir = directory
        try dir.setResourceValues(values)
    }

    /// Written whole or not at all, and readable while the phone is locked (after its first unlock).
    /// Returns the file's name: the photo's name in the queue.
    @discardableResult
    public func append(_ photo: Photo, at time: Date = .now) throws -> String {
        let name = String(format: "%013ld-%@.json", Int(time.timeIntervalSince1970 * 1000), UUID().uuidString)
        try JSONEncoder().encode(photo).write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return name
    }

    /// The waiting photos' names, oldest first.
    public func names() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
    }

    public func count() -> Int { names().count }

    /// nil for a file that cannot be read right now (before the phone's first unlock): it stays and is tried
    /// again. A file whose content is not a photo is removed, so it never blocks the queue.
    public func photo(_ name: String) -> Photo? {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent(name)) else { return nil }
        guard let photo = try? JSONDecoder().decode(Photo.self, from: data) else {
            try? remove(name)
            return nil
        }
        return photo
    }

    public func remove(_ name: String) throws {
        try FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
}
