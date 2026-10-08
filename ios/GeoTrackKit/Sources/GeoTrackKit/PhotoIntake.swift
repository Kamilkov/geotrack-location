import Foundation
import ImageIO

/// What became of the photos since the last pick. The counts and the time are kept across a relaunch;
/// the lines are held in memory only.
public struct PhotoReport: Codable, Equatable, Sendable {
    public enum Outcome: Equatable, Sendable {
        case waiting
        case stored(borrowed: Bool)
        case dropped(String)
        case failed(String)
        case skipped(String)
    }

    /// One photo of the last pick.
    public struct Line: Equatable, Sendable, Identifiable {
        public let id: String
        /// Its name in the queue; nil for a photo that is not in it (skipped, or held for the owner's answer).
        public var queueName: String?
        public var fileName: String
        public var outcome: Outcome
        /// The ID the server returned.
        public var serverID: String?

        /// "IMG_0001.HEIC: stored, 3F9A12C4".
        public var text: String {
            let what = switch outcome {
            case .waiting: "waiting"
            case .stored(borrowed: false): "stored"
            case .stored(borrowed: true): "stored by a borrowed position"
            case let .dropped(reason): "dropped: \(reason)"
            case let .failed(reason): "failed: \(reason)"
            case let .skipped(reason): "skipped: \(reason)"
            }
            return "\(fileName): \(what)" + (serverID.map { ", \($0.prefix(8))" } ?? "")
        }
    }

    /// When the last photo was answered or skipped.
    public var time: Date?
    public var stored = 0
    /// Of the stored: placed by a borrowed position.
    public var borrowed = 0
    /// Reason → number of photos.
    public var dropped: [String: Int] = [:]
    public var failed: [String: Int] = [:]
    public var skipped: [String: Int] = [:]
    public var lines: [Line] = []

    private enum CodingKeys: String, CodingKey { case time, stored, borrowed, dropped, failed, skipped }

    public init() {}

    /// "5 stored (1 by a borrowed position), 1 dropped: private zone"; nil while nothing was counted.
    public var summary: String? {
        func parts(_ label: String, _ counts: [String: Int]) -> [String] { counts.sorted { $0.key < $1.key }.map { "\($0.value) \(label): \($0.key)" } }
        var all = stored > 0 ? ["\(stored) stored" + (borrowed > 0 ? " (\(borrowed) by a borrowed position)" : "")] : []
        all += parts("dropped", dropped) + parts("failed", failed) + parts("skipped", skipped)
        return all.isEmpty ? nil : all.joined(separator: ", ")
    }
}

/// Takes a pick: reads each file, queues it or skips it, holds the photos without a location for the
/// owner's answer, and keeps the report.
public actor PhotoIntake {
    private let queue: PhotoQueue
    private let now: @Sendable () -> Date
    /// What ImageIO does not give for a RAW file, read from the file itself.
    private let exifInFile: @Sendable (URL) -> TIFFExif
    /// The report, and how many photos wait for the owner's answer. Called on the intake, once per change and in
    /// the order of the changes. It must not hop before it hands the values on: a hop of its own lets a later
    /// report overtake an earlier one. The app yields them into a stream it reads in order.
    private let onChange: @Sendable (PhotoReport, Int) -> Void
    private var report: PhotoReport
    private var held: [(line: String, photo: Photo)] = []

    public init(queue: PhotoQueue, report: PhotoReport = PhotoReport(), now: @escaping @Sendable () -> Date = { .now },
                exifInFile: @escaping @Sendable (URL) -> TIFFExif = { TIFFExif(file: $0) },
                onChange: @escaping @Sendable (PhotoReport, Int) -> Void = { _, _ in }) {
        self.queue = queue
        self.report = report
        self.now = now
        self.exifInFile = exifInFile
        self.onChange = onChange
    }

    /// A new pick: the report starts anew. Photos still held from the pick before are let go.
    public func begin() {
        report = PhotoReport()
        held = []
        onChange(report, 0)
    }

    /// One picked file, named as the picker named it. Reads it, then queues, holds or skips the photo.
    /// The file itself is left alone: the caller deletes its copy.
    public func add(file: URL) {
        let fileName = file.lastPathComponent
        guard let source = CGImageSourceCreateWithURL(file as CFURL, nil),
              var properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
              let thumbnail = try? PhotoThumbnail.make(from: source) else { return skip(fileName, "not readable") }
        // A ProRAW file: ImageIO gives neither the UTC offset of the time taken nor the position's accuracy,
        // though the camera wrote both. What ImageIO does give stands.
        let own = exifInFile(file)
        var exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        if exif[kCGImagePropertyExifOffsetTimeOriginal as String] == nil, let offset = own.offsetTimeOriginal {
            exif[kCGImagePropertyExifOffsetTimeOriginal as String] = offset
            properties[kCGImagePropertyExifDictionary as String] = exif
        }
        if var gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any],
           gps[kCGImagePropertyGPSHPositioningError as String] == nil, let accuracy = own.hPositioningError {
            gps[kCGImagePropertyGPSHPositioningError as String] = accuracy
            properties[kCGImagePropertyGPSDictionary as String] = gps
        }
        let photo: Photo
        do { photo = try PhotoMeta.photo(fileName: fileName, properties: properties, thumbnail: thumbnail) } catch { return skip(fileName, error.reason) }

        let line = UUID().uuidString
        if photo.hasLocation {
            guard let name = enqueue(photo) else { return skip(fileName, "not saved") }
            report.lines.append(.init(id: line, queueName: name, fileName: fileName, outcome: .waiting))
        } else {
            held.append((line, photo))
            report.lines.append(.init(id: line, queueName: nil, fileName: fileName, outcome: .waiting))
        }
        onChange(report, held.count)
    }

    /// A picked photo whose file did not arrive, named by its place in the pick: typically an original that
    /// is only in iCloud and could not be fetched, or no room on the phone for the app's copy of it.
    public func addNotReceived(fileName: String) { skip(fileName, "not received from Photos") }

    /// The owner's answer for the photos without a location: queue them all, or let them go.
    public func resolveHeld(send: Bool) {
        for (line, photo) in held {
            guard let index = report.lines.firstIndex(where: { $0.id == line }) else { continue }
            if send, let name = enqueue(photo) {
                report.lines[index].queueName = name
            } else {
                report.lines[index].outcome = .skipped(send ? "not saved" : "no location")
                count(\.skipped, send ? "not saved" : "no location")
            }
        }
        held = []
        onChange(report, 0)
    }

    /// An answer of the server. It counts also when its photo is of an earlier pick and has no line.
    public func record(_ result: PhotoResult) {
        let outcome: PhotoReport.Outcome, id: String?
        switch result.answer {
        case let .stored(borrowed, serverID):
            report.stored += 1
            if borrowed { report.borrowed += 1 }
            report.time = now()
            (outcome, id) = (.stored(borrowed: borrowed), serverID)
        case let .dropped(reason, serverID):
            count(\.dropped, reason)
            (outcome, id) = (.dropped(reason), serverID)
        case let .failed(reason):
            count(\.failed, reason)
            (outcome, id) = (.failed(reason), nil)
        }
        if let index = report.lines.firstIndex(where: { $0.queueName == result.name }) {
            report.lines[index].outcome = outcome
            report.lines[index].serverID = id
        }
        onChange(report, held.count)
    }

    private func enqueue(_ photo: Photo) -> String? { try? queue.append(photo, at: now()) }

    private func skip(_ fileName: String, _ reason: String) {
        report.lines.append(.init(id: UUID().uuidString, queueName: nil, fileName: fileName, outcome: .skipped(reason)))
        count(\.skipped, reason)
        onChange(report, held.count)
    }

    private func count(_ counts: WritableKeyPath<PhotoReport, [String: Int]>, _ reason: String) {
        report[keyPath: counts][reason, default: 0] += 1
        report.time = now()
    }
}
