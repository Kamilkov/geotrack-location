import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct WorkoutRuleTests {
    let now = workoutStart.addingTimeInterval(300)
    let full = walk().content
    func entry(_ device: String = "trial-iphone", floor: WorkoutContent?, sent: WorkoutContent, rejected: Bool = false) -> LedgerEntry {
        LedgerEntry(device: device, floor: floor, sent: sent, rejected: rejected, sentAt: workoutStart)
    }
    func decide(_ content: WorkoutContent, _ entry: LedgerEntry?, device: String = "trial-iphone", manual: Bool = false) -> WorkoutRule.Decision {
        WorkoutRule.decide(content: content, entry: entry, device: device, manual: manual)
    }

    @Test func aWorkoutThatWasNeverSentGoesOut() {
        #expect(decide(full, nil) == .send)
        #expect(WorkoutRule.worthReading(end: now.addingTimeInterval(-90 * 86400), entry: nil, device: "trial-iphone", now: now, manual: false))
    }

    @Test func aWorkoutSentUnderAnotherDeviceNameGoesOutAgainWhateverItsAge() {
        let old = entry("trial-iphone", floor: full, sent: full)
        #expect(decide(full, old, device: "iphone") == .send)
        #expect(WorkoutRule.worthReading(end: now.addingTimeInterval(-90 * 86400), entry: old, device: "iphone", now: now, manual: false))
    }

    @Test func anUnchangedWorkoutStaysAndAGrownOneGoesOutAgain() {
        let sent = entry(floor: full, sent: full)
        #expect(decide(full, sent) == .nothing)
        #expect(decide(walk(heartRate: 4).content, sent) == .send)
        #expect(decide(walk(recovery: 3).content, sent) == .send)
        #expect(decide(walk(route: 4).content, sent) == .send)
        var noSteps = walk()
        noSteps.steps = nil
        #expect(decide(full, entry(floor: noSteps.content, sent: noSteps.content)) == .send) // a summary value arrived
    }

    @Test func aSentWorkoutIsReadAgainOnlyInside48HoursOrOnSendNow() {
        let sent = entry(floor: full, sent: full)
        let recent = now.addingTimeInterval(-47 * 3600), old = now.addingTimeInterval(-49 * 3600)
        #expect(WorkoutRule.worthReading(end: recent, entry: sent, device: "trial-iphone", now: now, manual: false))
        #expect(!WorkoutRule.worthReading(end: old, entry: sent, device: "trial-iphone", now: now, manual: false))
        #expect(WorkoutRule.worthReading(end: old, entry: sent, device: "trial-iphone", now: now, manual: true))
        #expect(!WorkoutRule.worthReading(end: now.addingTimeInterval(-48 * 3600), entry: sent, device: "trial-iphone", now: now, manual: false)) // to the second
    }

    @Test(arguments: ["heartRate", "recovery", "route", "steps"])
    func aCopyWithLessThanTheFloorIsHeldAlsoWhenSomethingElseGrew(lost: String) {
        var w = walk(heartRate: lost == "heartRate" ? 2 : 3, recovery: lost == "recovery" ? 1 : 2, route: lost == "route" ? 2 : 9)
        if lost == "steps" { w.steps = nil }
        let grownElsewhere = lost == "route" ? { () -> WorkoutContent in var c = w.content; c.heartRate = 99; return c }() : w.content
        #expect(decide(grownElsewhere, entry(floor: full, sent: full)) == .held)
    }

    @Test func theFloorHoldsUnderANewDeviceName() {
        var w = walk()
        w.steps = nil
        #expect(decide(w.content, entry("trial-iphone", floor: full, sent: full), device: "iphone") == .held)
    }

    @Test func aRejectedCopyGoesOutAgainOnlyWhenItHasGrownAndNeverMovesTheFloor() {
        let rejectedFirst = entry(floor: nil, sent: full, rejected: true)
        #expect(decide(full, rejectedFirst) == .nothing)
        #expect(decide(walk(route: 4).content, rejectedFirst) == .send)
        #expect(decide(walk(route: 2).content, rejectedFirst) == .nothing) // less than the rejected copy, but nothing was acknowledged: not held

        // Acknowledged with 3 route points, then a copy with 9 was rejected: the floor is still 3.
        let rejectedLater = entry(floor: full, sent: walk(route: 9).content, rejected: true)
        #expect(decide(walk(route: 5).content, rejectedLater) == .nothing)
        #expect(decide(walk(route: 2).content, rejectedLater) == .held)
    }

    @Test func sendNowSendsARejectedCopyAgainButNeverOneWithLessThanTheFloor() {
        let rejected = entry(floor: nil, sent: full, rejected: true)
        #expect(decide(full, rejected) == .nothing)
        #expect(decide(full, rejected, manual: true) == .send)
        #expect(decide(full, entry(floor: full, sent: full), manual: true) == .nothing) // only a rejected copy: a stored one is not sent again unchanged

        let rejectedLater = entry(floor: full, sent: walk(route: 9).content, rejected: true)
        #expect(decide(walk(route: 2).content, rejectedLater, manual: true) == .held)
    }
}

@Suite struct WorkoutLedgerTests {
    let entry = LedgerEntry(device: "trial-iphone", floor: walk().content, sent: walk().content, rejected: false, sentAt: workoutStart)

    @Test func noFileYetIsAnEmptyLedger() throws {
        #expect(try WorkoutLedger(url: scratch().appendingPathComponent("ledger.json")).load() == [:])
    }

    @Test func whatIsSavedIsReadBack() throws {
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        try ledger.save(["A": entry])
        #expect(try ledger.load() == ["A": entry])
    }

    @Test func aFileThatCannotBeReadIsNotTakenForAnEmptyLedger() throws {
        let url = try scratch().appendingPathComponent("ledger.json")
        try Data("not a ledger".utf8).write(to: url)
        #expect(throws: (any Error).self) { try WorkoutLedger(url: url).load() }
    }

    @Test func holdsNoRouteNoHeartRateAndNoWorkoutTime() throws {
        let ledger = WorkoutLedger(url: try scratch().appendingPathComponent("ledger.json"))
        try ledger.save(["A": entry])
        let text = try String(contentsOf: ledger.url, encoding: .utf8)
        for forbidden in ["42.5", "1.5002", "bpm", "Apple Watch"] { #expect(!text.contains(forbidden)) }
        // Its fields, by name: a new one has to be added here, and so is looked at. `sentAt` is the time of sending.
        let saved = try #require(try object(Data(contentsOf: ledger.url))["A"] as? [String: Any])
        #expect(saved.keys.sorted() == ["device", "floor", "rejected", "sent", "sentAt"])
        for content in ["floor", "sent"] { #expect((saved[content] as? [String: Any])?.keys.sorted() == ["heartRate", "recovery", "route", "summary"]) }
    }
}
