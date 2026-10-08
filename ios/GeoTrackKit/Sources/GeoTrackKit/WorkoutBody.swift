import Foundation

/// The request body of `POST /health/workouts`: one workout in the JSON shape Health Auto Export sends
/// (export version 2), which is the shape the server's parser reads. A value the phone does not have is left out.
public struct WorkoutBody: Encodable, Sendable {
    struct Quantity: Encodable { let qty: Double; let units: String }
    struct MinAvgMax: Encodable { let min: Quantity?; let avg: Quantity?; let max: Quantity? }
    struct Rate: Encodable {
        let date: String, min: Double, avg: Double, max: Double, units = "bpm", source: String?
        enum CodingKeys: String, CodingKey { case date, min = "Min", avg = "Avg", max = "Max", units, source }
    }
    struct Steps: Encodable { let date: String, qty: Double, units = "count" }
    struct Point: Encodable {
        let latitude: Double, longitude: Double, altitude: Double?, timestamp: String, speed: Double?, course: Double?
        let horizontalAccuracy: Double, verticalAccuracy: Double?, speedAccuracy: Double?, courseAccuracy: Double?
    }
    struct Item: Encodable {
        let id: String, name: String, start: String, end: String, duration: Double, isIndoor: Bool?
        let distance: Quantity?, activeEnergyBurned: Quantity?, elevationUp: Quantity?, temperature: Quantity?, humidity: Quantity?
        let heartRate: MinAvgMax?
        let heartRateData: [Rate], heartRateRecovery: [Rate], stepCount: [Steps]?, route: [Point]
    }
    struct Workouts: Encodable { let workouts: [Item] }

    let device: String
    let data: Workouts

    public init(device: String, workout w: Workout) {
        func quantity(_ v: Double?, _ units: String) -> Quantity? { v.map { Quantity(qty: $0, units: units) } }
        func rates(_ samples: [Workout.HeartRate]) -> [Rate] {
            samples.map { Rate(date: WorkoutBody.time($0.time), min: $0.bpm, avg: $0.bpm, max: $0.bpm, source: $0.source) }
        }
        let range = MinAvgMax(min: quantity(w.hrMin, "bpm"), avg: quantity(w.hrAvg, "bpm"), max: quantity(w.hrMax, "bpm"))
        self.device = device
        data = Workouts(workouts: [Item(
            id: w.id, name: WorkoutNames.name(activityType: w.activityType, isIndoor: w.isIndoor),
            start: WorkoutBody.time(w.start), end: WorkoutBody.time(w.end), duration: w.duration, isIndoor: w.isIndoor,
            distance: quantity(w.distanceM, "m"), activeEnergyBurned: quantity(w.activeEnergyKcal, "kcal"),
            elevationUp: quantity(w.elevationUpM, "m"), temperature: quantity(w.temperatureC, "degC"), humidity: quantity(w.humidityPct, "%"),
            heartRate: range.min == nil && range.avg == nil && range.max == nil ? nil : range,
            heartRateData: rates(w.heartRate), heartRateRecovery: rates(w.recovery),
            stepCount: w.steps.map { [Steps(date: WorkoutBody.time(w.start), qty: $0)] },
            route: w.route.map {
                Point(latitude: $0.lat, longitude: $0.lon, altitude: $0.altitude, timestamp: WorkoutBody.time($0.time), speed: $0.speed,
                      course: $0.course, horizontalAccuracy: $0.horizontalAccuracy, verticalAccuracy: $0.verticalAccuracy,
                      speedAccuracy: $0.speedAccuracy, courseAccuracy: $0.courseAccuracy)
            })])
    }

    /// Whole seconds, UTC: "2026-09-22T15:43:46Z".
    static func time(_ date: Date) -> String {
        Date(timeIntervalSince1970: date.timeIntervalSince1970.rounded(.down)).formatted(.iso8601)
    }
}

/// The names Health Auto Export gives the activity types. A type that is not in the table is "Other (<number>)":
/// the comparison shows it, and the table is extended then.
public enum WorkoutNames {
    /// HKWorkoutActivityType's number → the name, or the outdoor and the indoor name.
    private static let both: [UInt: (outdoor: String, indoor: String)] = [
        13: ("Outdoor Cycling", "Indoor Cycling"), 37: ("Outdoor Run", "Indoor Run"), 52: ("Outdoor Walk", "Indoor Walk"),
    ]
    private static let one: [UInt: String] = [
        16: "Elliptical", 20: "Functional Strength Training", 24: "Hiking", 35: "Rowing", 44: "Stair Stepper", 46: "Swimming",
        50: "Traditional Strength Training", 57: "Yoga", 59: "Core Training", 63: "High Intensity Interval Training",
        66: "Pilates", 73: "Mixed Cardio", 80: "Cooldown", 3000: "Other",
    ]

    public static func name(activityType: UInt, isIndoor: Bool?) -> String {
        if let pair = both[activityType] { return isIndoor == true ? pair.indoor : pair.outdoor }
        return one[activityType] ?? "Other (\(activityType))"
    }
}
