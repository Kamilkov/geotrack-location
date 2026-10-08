import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct PositionQueueTests {
    func position(_ seconds: Double) -> Position { Position(sample: sample(seconds), keptForTime: false) }

    @Test func givesTheOldestFirstWhateverTheOrderOfWriting() throws {
        let queue = try PositionQueue(directory: scratch())
        for s in [600.0, 0, 300] { try queue.append(position(s)) }
        #expect(queue.count() == 3)
        #expect(try queue.oldest(2).map(\.position.tst) == [1_790_000_000, 1_790_000_300])
    }

    @Test func survivesARestart() throws {
        let dir = try scratch()
        try PositionQueue(directory: dir).append(position(0))
        #expect(try PositionQueue(directory: dir).oldest(10).map(\.position) == [position(0)])
    }

    @Test func removesOnlyWhatItIsTold() throws {
        let queue = try PositionQueue(directory: scratch())
        for s in [0.0, 300, 600] { try queue.append(position(s)) }
        try queue.remove(try queue.oldest(2).map(\.name))
        #expect(try queue.oldest(10).map(\.position.tst) == [1_790_000_600])
    }

    @Test func setsRejectedPositionsAsideInsteadOfDeletingThem() throws {
        let queue = try PositionQueue(directory: scratch())
        for s in [0.0, 300] { try queue.append(position(s)) }
        try queue.reject([try queue.oldest(1)[0].name])
        #expect(queue.count() == 1)
        #expect(queue.rejectedCount() == 1)
    }

    @Test func putsRejectedPositionsBackIntoTheQueueInTheirOrder() throws {
        let queue = try PositionQueue(directory: scratch())
        for s in [0.0, 300, 600] { try queue.append(position(s)) }
        try queue.reject(try queue.oldest(2).map(\.name))
        queue.restoreRejected()
        #expect(queue.rejectedCount() == 0)
        #expect(try queue.oldest(10).map(\.position.tst) == [1_790_000_000, 1_790_000_300, 1_790_000_600])
        queue.restoreRejected() // nothing set aside: nothing happens
        #expect(queue.count() == 3)

        try queue.reject(try queue.oldest(1).map(\.name))
        try queue.append(position(0)) // the same second, kept again
        queue.restoreRejected()
        #expect(queue.count() == 3)
        #expect(queue.rejectedCount() == 1) // its place is taken: it stays set aside, nothing is deleted
    }

    @Test func aFileThatIsNotAPositionIsSetAsideAndDoesNotBlock() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir)
        try Data("not json".utf8).write(to: dir.appendingPathComponent("000000000001.json"))
        try queue.append(position(0))
        #expect(try queue.oldest(10).map(\.position.tst) == [1_790_000_000])
        #expect(queue.rejectedCount() == 1)
    }

    /// The app keeps its last kept position in the queue's folder, under a name that does not end in .json.
    @Test func aFileWhoseNameDoesNotEndInJSONIsLeftAlone() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir)
        let other = dir.appendingPathComponent("last-kept")
        try Data("not a position".utf8).write(to: other)
        #expect(queue.count() == 0)
        #expect(try queue.oldest(10).isEmpty)
        #expect(FileManager.default.fileExists(atPath: other.path)) // not set aside as "no position"
    }

    @Test func aFailedWriteThrows() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir)
        try FileManager.default.removeItem(at: dir)
        #expect(throws: (any Error).self) { try queue.append(position(0)) }
    }

    @Test func aFileThatCannotBeReadRightNowStaysInTheQueueAndIsTriedAgain() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir)
        for s in [0.0, 300] { try queue.append(position(s)) }
        let locked = dir.appendingPathComponent("001790000000.json").path
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: locked)
        #expect(try queue.oldest(10).map(\.position.tst) == [1_790_000_300])
        #expect(queue.count() == 2)
        #expect(queue.rejectedCount() == 0)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: locked)
        #expect(try queue.oldest(10).map(\.position.tst) == [1_790_000_000, 1_790_000_300])
    }

    @Test func keepsTheOrderBeyondTheYear2038() throws {
        let queue = try PositionQueue(directory: scratch())
        let late = Date(timeIntervalSince1970: 2_147_483_700), later = Date(timeIntervalSince1970: 2_147_483_800)
        for time in [later, late, origin] { try queue.append(Position(sample: Sample(time: time, lat: 42.5, lon: 1.5, horizontalAccuracy: 5), keptForTime: false)) }
        #expect(try queue.oldest(10).map(\.position.tst) == [1_790_000_000, 2_147_483_700, 2_147_483_800])
    }

    @Test func anUnreadableQueueFolderThrowsInsteadOfLookingEmpty() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir)
        try FileManager.default.removeItem(at: dir)
        #expect(throws: (any Error).self) { try queue.oldest(10) }
    }
}
