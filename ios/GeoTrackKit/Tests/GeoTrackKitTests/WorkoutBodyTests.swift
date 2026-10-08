import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct WorkoutBodyTests {
    /// The values behind test/fixtures/ios-workout.json, as Health gives them.
    var fixtureWalk: Workout {
        let s = workoutStart
        func rate(_ seconds: Double, _ bpm: Double) -> Workout.HeartRate { .init(time: s.addingTimeInterval(seconds), bpm: bpm, source: "Apple Watch") }
        func point(_ seconds: Double, _ lat: Double, _ lon: Double, _ h: Double, alt: Double, v: Double, speed: Double, sAcc: Double, course: Double, cAcc: Double) -> Workout.RoutePoint? {
            Workout.RoutePoint(time: s.addingTimeInterval(seconds), lat: lat, lon: lon, horizontalAccuracy: h, altitude: alt, verticalAccuracy: v,
                               speed: speed, speedAccuracy: sAcc, course: course, courseAccuracy: cAcc)
        }
        return Workout(
            id: "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D", activityType: 52, start: s.addingTimeInterval(0.4), end: s.addingTimeInterval(300.9), duration: 300,
            isIndoor: false, distanceM: 620.4, activeEnergyKcal: 32.44, elevationUpM: 12.34, temperatureC: 18.46, humidityPct: 61,
            hrMin: 92, hrAvg: 108.4, hrMax: 121, steps: 313,
            heartRate: [rate(5.7, 92), rate(150, 108), rate(295, 121)], recovery: [rate(330, 104), rate(420, 97)],
            route: [
                point(0.2, 42.5003, 1.5002, 4.2, alt: 1001.26, v: 3.1, speed: 1.21, sAcc: 0.3, course: 12.4, cAcc: 9.8),
                point(150, 42.5025, 1.501, 3.9, alt: 1008.8, v: 3, speed: 1.41, sAcc: 0.2, course: 359.7, cAcc: 8.9),
                // iOS marks the vertical accuracy, the speed and the course as not available.
                point(300, 42.5045, 1.5014, 4, alt: 1013.6, v: -1, speed: -1, sAcc: -1, course: -1, cAcc: -1),
                // iOS marks the fix itself invalid: no point.
                point(301, 42.5046, 1.5014, -1, alt: 1013.6, v: 3, speed: 1.3, sAcc: 0.3, course: 8, cAcc: 9),
            ].compactMap { $0 })
    }

    @Test func encodesTheSampleFileTheServersParserIsTestedWith() throws {
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(WorkoutBody(device: "trial-iphone", workout: fixtureWalk))) as? NSDictionary
        let expected = try JSONSerialization.jsonObject(with: repoFixture("ios-workout.json")) as? NSDictionary
        #expect(encoded != nil)
        #expect(encoded == expected)
    }

    @Test func leavesOutWhatHealthDoesNotHave() throws {
        let bare = Workout(id: "A", activityType: 52, start: workoutStart, end: workoutStart.addingTimeInterval(60), duration: 60)
        let body = try object(JSONEncoder().encode(WorkoutBody(device: "trial-iphone", workout: bare)))
        let item = try #require(((body["data"] as? [String: Any])?["workouts"] as? [[String: Any]])?.first)
        #expect(item.keys.sorted() == ["duration", "end", "heartRateData", "heartRateRecovery", "id", "name", "route", "start"])
    }

    @Test func aRoutePointIosMarksInvalidIsNoPoint() {
        #expect(Workout.RoutePoint(time: workoutStart, lat: 42.5, lon: 1.5, horizontalAccuracy: -1, altitude: 1000, verticalAccuracy: 3,
                                   speed: 1, speedAccuracy: 0.3, course: 10, courseAccuracy: 9) == nil)
    }

    @Test func anAltitudeWithoutAValidVerticalAccuracyIsNotKnownAndOneBelowSeaLevelIs() throws {
        let unknown = try #require(Workout.RoutePoint(time: workoutStart, lat: 42.5, lon: 1.5, horizontalAccuracy: 0, altitude: 1000, verticalAccuracy: -1,
                                                      speed: 0, speedAccuracy: 0, course: 0, courseAccuracy: 0))
        #expect(unknown.altitude == nil)
        #expect(unknown.verticalAccuracy == nil)
        #expect(unknown.horizontalAccuracy == 0)
        #expect(unknown.speed == 0)
        #expect(unknown.course == 0)
        let below = try #require(Workout.RoutePoint(time: workoutStart, lat: 42.5, lon: 1.5, horizontalAccuracy: 4, altitude: -12.4, verticalAccuracy: 3,
                                                    speed: 1, speedAccuracy: 0.3, course: 10, courseAccuracy: 9))
        #expect(below.altitude == -12.4)
    }

    @Test func aRoutePointWithACoordinateThatIsNotANumberIsNoPointAndAnyOtherSuchValueIsNotKnown() throws {
        func point(lat: Double = 42.5, lon: Double = 1.5, altitude: Double = 1000, speed: Double = 1) -> Workout.RoutePoint? {
            Workout.RoutePoint(time: workoutStart, lat: lat, lon: lon, horizontalAccuracy: 4, altitude: altitude, verticalAccuracy: 3,
                               speed: speed, speedAccuracy: 0.3, course: 10, courseAccuracy: 9)
        }
        #expect(point(lat: .nan) == nil)
        #expect(point(lon: .infinity) == nil)
        let rest = try #require(point(altitude: .infinity, speed: .nan))
        #expect(rest.altitude == nil)
        #expect(rest.speed == nil)
        #expect(rest.verticalAccuracy == 3)
    }

    @Test func namesTheActivityTypesAsHealthAutoExportDoes() {
        #expect(WorkoutNames.name(activityType: 24, isIndoor: nil) == "Hiking")
        #expect(WorkoutNames.name(activityType: 52, isIndoor: false) == "Outdoor Walk")
        #expect(WorkoutNames.name(activityType: 52, isIndoor: nil) == "Outdoor Walk")
        #expect(WorkoutNames.name(activityType: 52, isIndoor: true) == "Indoor Walk")
        #expect(WorkoutNames.name(activityType: 37, isIndoor: true) == "Indoor Run")
        #expect(WorkoutNames.name(activityType: 13, isIndoor: false) == "Outdoor Cycling")
        #expect(WorkoutNames.name(activityType: 9999, isIndoor: nil) == "Other (9999)")
    }

    @Test func theContentCountsAndNamesWhatIsThereNeverAValue() {
        let content = walk(heartRate: 3, recovery: 2, route: 4).content
        #expect(content == WorkoutContent(heartRate: 3, recovery: 2, route: 4,
                                          summary: ["distance", "energy", "elevation", "temperature", "humidity", "indoor", "hrMin", "hrAvg", "hrMax", "steps"]))
        var bare = walk()
        bare.steps = nil
        bare.isIndoor = nil
        #expect(bare.content.summary == ["distance", "energy", "elevation", "temperature", "humidity", "hrMin", "hrAvg", "hrMax"])
    }
}
