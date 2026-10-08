import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct KeeperTests {
    @Test func keepsByTheRuleAndMarksTimeKeeps() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir.appendingPathComponent("queue"))
        let keeper = Keeper(queue: queue, lastKeptURL: dir.appendingPathComponent("last-kept.json"))
        #expect(try keeper.offer(sample(0))?.t == nil)            // first fix
        #expect(try keeper.offer(sample(10, north: 20)) == nil)   // thinned out
        #expect(try keeper.offer(sample(20, north: 60))?.t == nil) // 50 m
        #expect(try keeper.offer(sample(320, north: 60))?.t == "t") // 300 s
        #expect(try keeper.offer(sample(330, north: 200, accuracy: -1)) == nil) // invalid
        #expect(queue.count() == 3)
    }

    @Test func theLastKeptPositionSurvivesARestartWithAnEmptyQueue() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir.appendingPathComponent("queue"))
        let url = dir.appendingPathComponent("last-kept.json")
        _ = try Keeper(queue: queue, lastKeptURL: url).offer(sample(100))
        try queue.remove(try queue.oldest(10).map(\.name)) // uploaded: the queue is empty

        let restarted = Keeper(queue: queue, lastKeptURL: url)
        #expect(restarted.last == sample(100).fix)
        #expect(try restarted.offer(sample(90, north: 80)) == nil)  // a cached fix from before
        #expect(try restarted.offer(sample(150, north: 10)) == nil) // neither limit reached
        #expect(try restarted.offer(sample(400)) != nil)
    }

    @Test func aLastKeptPositionLaterThanTheClockDoesNotStopTheRecording() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir.appendingPathComponent("queue"))
        let url = dir.appendingPathComponent("last-kept.json")
        _ = try Keeper(queue: queue, lastKeptURL: url).offer(sample(3600)) // kept while the clock ran an hour ahead

        let corrected = Keeper(queue: queue, lastKeptURL: url, now: { origin.addingTimeInterval(100) })
        #expect(try corrected.offer(sample(100, north: 10)) != nil) // kept, though it is "not newer"
        #expect(try corrected.offer(sample(110, north: 20)) == nil)    // and the rule goes on from it
        #expect(Keeper(queue: queue, lastKeptURL: url).last == sample(100, north: 10).fix)

        // A last kept position that is not later than the clock is trusted, to the second.
        _ = try Keeper(queue: queue, lastKeptURL: url).offer(sample(3600))
        let onTime = Keeper(queue: queue, lastKeptURL: url, now: { origin.addingTimeInterval(3600) })
        #expect(try onTime.offer(sample(3500, north: 80)) == nil) // a cached fix from before
    }

    @Test func aLastKeptFileThatIsNotOneIsTakenForNone() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir.appendingPathComponent("queue"))
        let url = dir.appendingPathComponent("last-kept.json")
        try Data("not a position".utf8).write(to: url)
        let keeper = Keeper(queue: queue, lastKeptURL: url)
        #expect(keeper.last == nil)
        #expect(try keeper.offer(sample(0)) != nil) // the recording goes on, and the file is written anew
        #expect(Keeper(queue: queue, lastKeptURL: url).last == sample(0).fix)
    }

    @Test func aFailedWriteKeepsNothingAndDoesNotAdvance() throws {
        let dir = try scratch()
        let queueDir = dir.appendingPathComponent("queue")
        let queue = try PositionQueue(directory: queueDir)
        let keeper = Keeper(queue: queue, lastKeptURL: dir.appendingPathComponent("last-kept.json"))
        _ = try keeper.offer(sample(0))
        try FileManager.default.removeItem(at: queueDir)
        #expect(throws: (any Error).self) { try keeper.offer(sample(400)) }
        #expect(keeper.last == sample(0).fix)
    }

    @Test func aPositionIsKeptEvenWhenTheLastKeptPositionCannotBeSaved() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir.appendingPathComponent("queue"))
        let keeper = Keeper(queue: queue, lastKeptURL: dir.appendingPathComponent("missing-folder/last-kept.json"))
        #expect(try keeper.offer(sample(0)) != nil)
        #expect(queue.count() == 1)
        #expect(keeper.last == sample(0).fix)
        #expect(keeper.saveProblem != nil)
        // The rule goes on from the position in memory.
        #expect(try keeper.offer(sample(10, north: 10)) == nil)

        let working = Keeper(queue: queue, lastKeptURL: dir.appendingPathComponent("last-kept.json"))
        #expect(try working.offer(sample(400)) != nil)
        #expect(working.saveProblem == nil)
    }
}

@Suite struct KeeperWakeTests {
    @Test func theFirstFixAfterHomeSleepIsKeptAndTaggedEvenWhenTheRuleWouldThinIt() throws {
        let dir = try scratch()
        let queue = try PositionQueue(directory: dir.appendingPathComponent("queue"))
        let keeper = Keeper(queue: queue, lastKeptURL: dir.appendingPathComponent("last-kept.json"))
        #expect(try keeper.offer(sample(0)) != nil)
        // 10 s and 20 m later: thinned out as a plain fix, kept and tagged as the wake-up fix.
        #expect(try keeper.offer(sample(10, north: 20)) == nil)
        #expect(try keeper.offer(sample(11, north: 20), wokeFromHome: true)?.t == "c")
        // Not newer than the last kept position: refused, wake-up or not.
        #expect(try keeper.offer(sample(11, north: 40), wokeFromHome: true) == nil)
        #expect(queue.count() == 2)
    }
}
