import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct PositionTests {
    /// The values behind test/fixtures/ios-position.json, in iOS's units.
    let full = Sample(time: Date(timeIntervalSince1970: 1_790_000_000.6), lat: 42.50210004, lon: 1.50339996, horizontalAccuracy: 6.2,
                      altitude: 1012.4, verticalAccuracy: 3.6, speed: 1.4, speedAccuracy: 0.42, course: 87.3, courseAccuracy: 11.52,
                      batteryLevel: 0.81, batteryState: 1, connection: "w", pressureKPa: 89.87412, activities: ["walking"], motionConfidence: "high")

    @Test func encodesTheSampleFileTheServersParserIsTestedWith() throws {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(Position(sample: full, keptForTime: true))) as? NSDictionary
        let expected = try JSONSerialization.jsonObject(with: repoFixture("ios-position.json")) as? NSDictionary
        #expect(encoded != nil)
        #expect(encoded == expected)
    }

    @Test func leavesOutWhatThePhoneDoesNotHave() throws {
        let bare = Position(sample: sample(0), keptForTime: false)
        let keys = try object(JSONEncoder().encode(bare)).keys.sorted()
        #expect(keys == ["_type", "acc", "lat", "lon", "tst"])
    }

    @Test func survivesTheQueueFileRoundTrip() throws {
        let position = Position(sample: full, keptForTime: true)
        #expect(try JSONDecoder().decode(Position.self, from: JSONEncoder().encode(position)) == position)
    }

    @Test func leavesOutWhatIosMarksAsNotAvailable() throws {
        // iOS reports "not available" as a negative number: speed, course, their accuracies, vertical accuracy, battery level.
        let s = Sample(time: origin, lat: 42.5, lon: 1.5, horizontalAccuracy: 5, altitude: 0, verticalAccuracy: -1, speed: -1,
                       speedAccuracy: -1, course: -1, courseAccuracy: -1, batteryLevel: -1, batteryState: 0)
        let keys = try object(JSONEncoder().encode(Position(sample: s, keptForTime: false))).keys.sorted()
        #expect(keys == ["_type", "acc", "bs", "lat", "lon", "tst"])
    }

    @Test func roundsTheCoordinatesToSixDecimals() {
        let p = Position(sample: Sample(time: origin, lat: 42.5000016, lon: 1.5000014, horizontalAccuracy: 5), keptForTime: false)
        #expect(p.lat == 42.500002) // rounded, not cut off
        #expect(p.lon == 1.500001)
    }

    @Test func leavesOutWhatIsNotANumberAndANegativePressure() throws {
        let s = Sample(time: origin, lat: 42.5, lon: 1.5, horizontalAccuracy: 5, altitude: .infinity, speed: .nan, speedAccuracy: .infinity,
                       course: .nan, courseAccuracy: .nan, batteryLevel: .infinity, pressureKPa: -1)
        let keys = try object(JSONEncoder().encode(Position(sample: s, keptForTime: false))).keys.sorted()
        #expect(keys == ["_type", "acc", "lat", "lon", "tst"])
    }

    @Test func keepsZeroAndAnAltitudeBelowSeaLevel() {
        let s = Sample(time: origin, lat: 42.5, lon: 1.5, horizontalAccuracy: 0, altitude: -12.4, speed: 0, course: 0, batteryLevel: 0)
        let p = Position(sample: s, keptForTime: false)
        #expect(p.acc == 0)
        #expect(p.alt == -12)
        #expect(p.vel == 0)
        #expect(p.cog == 0)
        #expect(p.batt == 0)
    }
}

@Suite struct PositionWakeTests {
    @Test func theFirstFixAfterHomeSleepCarriesTheRegionTrigger() throws {
        let s = Sample(time: Date(timeIntervalSince1970: 1_790_000_000), lat: 42.51, lon: 1.5, horizontalAccuracy: 5)
        #expect(Position(sample: s, keptForTime: false, wokeFromHome: true).t == "c")
        #expect(Position(sample: s, keptForTime: true, wokeFromHome: true).t == "c", "the region trigger outranks the time trigger")
        #expect(Position(sample: s, keptForTime: true).t == "t")
        #expect(Position(sample: s, keptForTime: false).t == nil)
    }
}
