import Foundation
import Testing
@testable import GeoTrackKit

/// The reports an intake published, in order, each with the number of photos held for the owner's answer.
final class Reports: @unchecked Sendable {
    private let lock = NSLock()
    private var all: [(PhotoReport, Int)] = []
    var last: PhotoReport { lock.withLock { all.last?.0 ?? PhotoReport() } }
    var held: Int { lock.withLock { all.last?.1 ?? 0 } }
    var record: @Sendable (PhotoReport, Int) -> Void { { report, held in self.lock.withLock { self.all.append((report, held)) } } }
}

@Suite struct PhotoIntakeTests {
    let now = origin
    let noLocation = photoProperties(gps: nil)

    func make(report: PhotoReport = PhotoReport()) throws -> (PhotoIntake, PhotoQueue, Reports) {
        let queue = try PhotoQueue(directory: scratch())
        let reports = Reports()
        return (PhotoIntake(queue: queue, report: report, now: { [now] in now }, onChange: reports.record), queue, reports)
    }

    func lines(_ reports: Reports) -> [String] { reports.last.lines.map(\.text) }

    @Test func aPhotoWithALocationIsQueuedWithItsOwnNameFieldsAndThumbnail() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg"))
        let queued = try #require(queue.names().compactMap(queue.photo).first)
        #expect(queued.fileName == "IMG_0001.jpg")
        #expect(queued.takenAt == "2026-09-22T17:50:12.345+02:00")
        #expect(queued.cameraModel == "iPhone 17 Pro")
        #expect([queued.lat, queued.lon, queued.altitudeM, queued.accuracyM] == [42.51, 1.52, 1012.4, 4.7])
        #expect(queued.directionDeg == 272)
        #expect(try Pixels(queued.thumbnail).size == [800, 600])
        #expect(lines(reports) == ["IMG_0001.jpg: waiting"])
    }

    /// Each entry must hold its own file's name, time and picture: a mix-up would land a photo on another photo's row.
    @Test func inAPickOfSeveralPhotosEachEntryHoldsItsOwnFile() async throws {
        let (intake, queue, _) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg", properties: photoProperties(subSeconds: "111")))
        await intake.add(file: try imageFile("IMG_0002.jpg", width: 1200, height: 1600, properties: photoProperties(subSeconds: "222")))
        let photos = queue.names().compactMap(queue.photo).sorted { $0.fileName < $1.fileName } // both were queued in the test's one instant
        #expect(photos.map(\.fileName) == ["IMG_0001.jpg", "IMG_0002.jpg"])
        #expect(photos.map(\.takenAt) == ["2026-09-22T17:50:12.111+02:00", "2026-09-22T17:50:12.222+02:00"])
        #expect(try photos.map { try Pixels($0.thumbnail).size } == [[800, 600], [600, 800]])
    }

    @Test func whatCannotBeSentIsSkippedWithItsReasonAndNotQueued() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        let notes = try scratch().appendingPathComponent("notes.jpg")
        try Data("not an image".utf8).write(to: notes)
        await intake.add(file: notes)
        await intake.add(file: try imageFile("IMG_0002.jpg", properties: photoProperties(offset: nil)))
        await intake.add(file: try imageFile("Screenshot.jpg", properties: photoProperties(model: nil)))
        await intake.addNotReceived(fileName: "Photo 4")
        #expect(queue.count() == 0)
        #expect(lines(reports) == ["notes.jpg: skipped: not readable", "IMG_0002.jpg: skipped: no time with UTC offset",
                                   "Screenshot.jpg: skipped: no camera model", "Photo 4: skipped: not received from Photos"])
        #expect(reports.last.skipped == ["not readable": 1, "no time with UTC offset": 1, "no camera model": 1, "not received from Photos": 1])
        #expect(reports.last.time == now)
    }

    /// A ProRAW file: ImageIO gives neither the UTC offset of its time taken nor its position's accuracy.
    @Test func whatImageIODoesNotGiveIsTakenFromTheFileItselfAndWhatItGivesStands() async throws {
        let queue = try PhotoQueue(directory: scratch())
        let reports = Reports()
        let intake = PhotoIntake(queue: queue, now: { [now] in now }, exifInFile: { _ in TIFFExif(offsetTimeOriginal: "-03:30", hPositioningError: 9.5) }, onChange: reports.record)
        await intake.begin()
        let bare: [String: Any] = ["Latitude": 42.51, "LatitudeRef": "N", "Longitude": 1.52, "LongitudeRef": "E"]
        await intake.add(file: try imageFile("IMG_0001.jpg", properties: photoProperties(offset: nil, gps: bare)))
        await intake.add(file: try imageFile("IMG_0002.jpg")) // ImageIO gives both
        await intake.add(file: try imageFile("IMG_0003.jpg", properties: photoProperties(gps: nil))) // no place: no accuracy either
        await intake.resolveHeld(send: true)
        let queued = queue.names().compactMap(queue.photo).sorted { $0.fileName < $1.fileName }
        #expect(queued.map(\.takenAt) == ["2026-09-22T17:50:12.345-03:30", "2026-09-22T17:50:12.345+02:00", "2026-09-22T17:50:12.345+02:00"])
        #expect(queued.map(\.accuracyM) == [9.5, 4.7, nil])
        #expect(reports.last.skipped == [:])
    }

    @Test func aPhotoWithoutALocationIsHeldUntilTheOwnerAnswersAndSendAllQueuesIt() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg", properties: noLocation))
        await intake.add(file: try imageFile("IMG_0002.jpg"))
        #expect(queue.count() == 1) // the one with a location did not wait for the answer
        #expect(reports.held == 1)
        await intake.resolveHeld(send: true)
        #expect(queue.names().compactMap(queue.photo).map(\.fileName).sorted() == ["IMG_0001.jpg", "IMG_0002.jpg"])
        #expect(reports.held == 0)
        #expect(reports.last.skipped == [:])

        // Its line follows it into the queue: the server's answer is written to it.
        let sent = try #require(queue.names().first { queue.photo($0)?.fileName == "IMG_0001.jpg" })
        await intake.record(PhotoResult(name: sent, fileName: "IMG_0001.jpg", answer: .stored(borrowed: true, id: "A0087579-0000-5000-8000-000000000001")))
        #expect(lines(reports).contains("IMG_0001.jpg: stored by a borrowed position, A0087579"))
    }

    @Test func aStoredAnswerAloneSetsTheReportsTime() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg"))
        #expect(reports.last.time == nil)
        await intake.record(PhotoResult(name: try #require(queue.names().first), fileName: "IMG_0001.jpg", answer: .stored(borrowed: false, id: "x")))
        #expect(reports.last.time == now)
    }

    /// Every change is published once, after it was made. One task drives the intake here: the order under
    /// calls from several tasks is the actor's, and not what this test shows.
    @Test func everyChangeIsPublishedOnceAfterItWasMade() async throws {
        let queue = try PhotoQueue(directory: scratch())
        let (stream, continuation) = AsyncStream.makeStream(of: Int.self)
        let intake = PhotoIntake(queue: queue, now: { [now] in now }, onChange: { report, _ in continuation.yield(report.lines.count) })
        await intake.begin()
        for name in ["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg"] { await intake.add(file: try imageFile(name)) }
        continuation.finish()
        var seen: [Int] = []
        for await count in stream { seen.append(count) }
        #expect(seen == [0, 1, 2, 3])
    }

    @Test func onlyThoseWithLocationLetsTheOthersGoAsSkipped() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg", properties: noLocation))
        await intake.add(file: try imageFile("IMG_0002.jpg", properties: noLocation))
        await intake.resolveHeld(send: false)
        #expect(queue.count() == 0)
        #expect(reports.held == 0)
        #expect(lines(reports) == ["IMG_0001.jpg: skipped: no location", "IMG_0002.jpg: skipped: no location"])
        #expect(reports.last.skipped == ["no location": 2])
        await intake.resolveHeld(send: true) // a second answer finds nothing held
        #expect(queue.count() == 0)
    }

    @Test func aPhotoThatCannotBeWrittenToTheQueueIsSkippedAsNotSaved() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg", properties: noLocation)) // held for the owner's answer
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: queue.directory.path) // readable, not writable
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: queue.directory.path) }
        await intake.add(file: try imageFile("IMG_0002.jpg"))
        await intake.resolveHeld(send: true)
        #expect(queue.count() == 0)
        #expect(lines(reports) == ["IMG_0001.jpg: skipped: not saved", "IMG_0002.jpg: skipped: not saved"])
        #expect(reports.last.skipped == ["not saved": 2])
        #expect(reports.held == 0)
    }

    @Test func anAnswerIsCountedAndWrittenToItsPhotosLineWithTheID() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        for name in ["IMG_0001.jpg", "IMG_0002.jpg", "IMG_0003.jpg", "IMG_0004.jpg"] { await intake.add(file: try imageFile(name)) }
        let names = queue.names()
        let photos = names.compactMap(queue.photo)
        let id = "3F9A12C4-0000-5000-8000-000000000001"
        let answers: [PhotoAnswer] = [.stored(borrowed: false, id: id), .stored(borrowed: true, id: id), .dropped(reason: "private zone", id: id), .failed(reason: "thumbnail: not a JPEG")]
        // Answered out of order: each answer finds its own line by the queue's name.
        for i in [2, 0, 3, 1] { await intake.record(PhotoResult(name: names[i], fileName: photos[i].fileName, answer: answers[i])) }
        #expect(Set(lines(reports)) == Set(["\(photos[0].fileName): stored, 3F9A12C4", "\(photos[1].fileName): stored by a borrowed position, 3F9A12C4",
                                            "\(photos[2].fileName): dropped: private zone, 3F9A12C4", "\(photos[3].fileName): failed: thumbnail: not a JPEG"]))
        #expect(reports.last.summary == "2 stored (1 by a borrowed position), 1 dropped: private zone, 1 failed: thumbnail: not a JPEG")
        #expect(reports.last.time == now)
    }

    @Test func aNewPickStartsTheReportAnewAndALaterAnswerForAnEarlierPhotoStillCounts() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg"))
        await intake.add(file: try imageFile("IMG_0002.jpg", properties: noLocation)) // held, never answered
        let earlier = try #require(queue.names().first)
        await intake.begin()
        #expect(reports.last == PhotoReport())
        #expect(reports.held == 0)
        await intake.record(PhotoResult(name: earlier, fileName: "IMG_0001.jpg", answer: .stored(borrowed: false, id: "x")))
        #expect(reports.last.stored == 1)
        #expect(reports.last.lines.isEmpty) // it has no line in this pick
        await intake.resolveHeld(send: true)
        #expect(queue.count() == 1) // the held photo of the pick before was let go
    }

    @Test func theReportIsKeptAcrossARelaunchWithoutItsLines() async throws {
        let (intake, queue, reports) = try make()
        await intake.begin()
        await intake.add(file: try imageFile("IMG_0001.jpg"))
        await intake.add(file: try imageFile("IMG_0002.jpg", properties: photoProperties(offset: nil)))
        await intake.record(PhotoResult(name: try #require(queue.names().first), fileName: "IMG_0001.jpg", answer: .dropped(reason: "private zone", id: "x")))

        let saved = try JSONEncoder().encode(reports.last)
        #expect(saved.range(of: Data("IMG_0001".utf8)) == nil) // counts and reasons only
        let restored = try JSONDecoder().decode(PhotoReport.self, from: saved)
        #expect(restored.lines.isEmpty)
        #expect(restored.summary == "1 dropped: private zone, 1 skipped: no time with UTC offset")
        #expect(restored.time == now)

        let (relaunched, _, later) = try make(report: restored)
        await relaunched.record(PhotoResult(name: "unknown", fileName: "IMG_0003.jpg", answer: .stored(borrowed: false, id: "x")))
        #expect(later.last.summary == "1 stored, 1 dropped: private zone, 1 skipped: no time with UTC offset")
    }

    @Test func nothingCountedHasNoSummary() {
        #expect(PhotoReport().summary == nil)
    }
}
