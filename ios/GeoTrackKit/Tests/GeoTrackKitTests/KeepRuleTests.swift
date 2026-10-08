import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct KeepRuleTests {
    @Test func theFirstFixIsKept() {
        #expect(KeepRule.decide(last: nil, candidate: fix(0), horizontalAccuracy: 5) == .keepForDistance)
    }

    @Test func fiftyMetresAreEnoughWithoutWaiting() {
        #expect(KeepRule.decide(last: fix(0), candidate: fix(10, north: 50.5), horizontalAccuracy: 5) == .keepForDistance)
        #expect(KeepRule.decide(last: fix(0), candidate: fix(10, north: 49), horizontalAccuracy: 5) == .thin)
    }

    @Test func threeHundredSecondsAreEnoughWithoutMoving() {
        #expect(KeepRule.decide(last: fix(0), candidate: fix(300), horizontalAccuracy: 5) == .keepForTime)
        #expect(KeepRule.decide(last: fix(0), candidate: fix(299), horizontalAccuracy: 5) == .thin)
    }

    @Test func distanceWinsWhenBothLimitsAreReached() {
        #expect(KeepRule.decide(last: fix(0), candidate: fix(400, north: 80), horizontalAccuracy: 5) == .keepForDistance)
    }

    @Test func anInvalidFixIsRefusedEvenWhenItIsTheFirst() {
        #expect(KeepRule.decide(last: nil, candidate: fix(0), horizontalAccuracy: -1) == .refuse)
        #expect(KeepRule.decide(last: fix(0), candidate: fix(400, north: 80), horizontalAccuracy: -1) == .refuse)
        #expect(KeepRule.decide(last: nil, candidate: fix(0), horizontalAccuracy: 0) == .keepForDistance) // 0 is valid
    }

    @Test func aFixThatIsNotNewerIsRefused() {
        #expect(KeepRule.decide(last: fix(100), candidate: fix(100, north: 80), horizontalAccuracy: 5) == .refuse)
        #expect(KeepRule.decide(last: fix(100), candidate: fix(40, north: 80), horizontalAccuracy: 5) == .refuse)
        // Within the same whole second: the server would see one row.
        #expect(KeepRule.decide(last: fix(100.1), candidate: fix(100.9, north: 80), horizontalAccuracy: 5) == .refuse)
    }

    @Test func aPoorButValidFixIsJudgedLikeAnyOther() {
        #expect(KeepRule.decide(last: fix(0), candidate: fix(300), horizontalAccuracy: 900) == .keepForTime)
    }

    @Test func metresMatchesTheServersHaversine() {
        #expect(abs(KeepRule.metres(fix(0), fix(0, north: 100)) - 100) < 0.1)
        // East: a degree of longitude is shorter by the cosine of the latitude.
        let east = Fix(time: origin, lat: 42.5, lon: 1.5 + 100 / (111_195 * cos(42.5 * .pi / 180)))
        #expect(abs(KeepRule.metres(fix(0), east) - 100) < 0.1)
    }
}
