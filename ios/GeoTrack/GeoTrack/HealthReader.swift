import CoreLocation
import GeoTrackKit
import HealthKit
import UIKit

/// Reads workouts from Health and hands them on as GeoTrackKit's plain values. It decides nothing:
/// what goes out is the package's rule.
final class HealthReader: Sendable {
    private let store = HKHealthStore()
    @MainActor private var observers: [HKObserverQuery] = []

    static let readTypes: Set<HKObjectType> = [
        HKObjectType.workoutType(), HKSeriesType.workoutRoute(), HKQuantityType(.heartRate), HKQuantityType(.stepCount),
        HKQuantityType(.distanceWalkingRunning), HKQuantityType(.distanceCycling), HKQuantityType(.activeEnergyBurned),
    ]

    /// Asks for read access when iOS has not asked yet; true when it asked. iOS shows its sheet only while the
    /// app is in front. It never says what was refused: a refused type just reads as empty.
    func requestAccessIfNeeded() async -> Bool {
        guard HKHealthStore.isHealthDataAvailable(),
              (try? await store.statusForAuthorizationRequest(toShare: [], read: Self.readTypes)) == .shouldRequest else { return false }
        try? await store.requestAuthorization(toShare: [], read: Self.readTypes)
        return true
    }

    /// Registers the observers for workouts and for workout routes and switches background delivery on for
    /// both. Called on every launch before anything else is asked of Health, and again after the owner
    /// answered the access sheet (an observer registered before that has ended with an error).
    /// `changed` gets iOS's completion handler and must see to it that it is called. `failed` gets the reason
    /// when iOS refuses background delivery: the workouts then arrive only while the app is open.
    @MainActor
    func observe(_ changed: @escaping @Sendable (@escaping @Sendable () -> Void) -> Void, failed: @escaping @Sendable (String) -> Void) {
        // The package names activity types by HealthKit's numbers. If Apple ever renumbers, a debug build stops here.
        assert(HKWorkoutActivityType.cycling.rawValue == 13 && HKWorkoutActivityType.hiking.rawValue == 24
            && HKWorkoutActivityType.running.rawValue == 37 && HKWorkoutActivityType.walking.rawValue == 52)
        guard HKHealthStore.isHealthDataAvailable() else { return }
        observers.forEach(store.stop)
        observers = [HKObjectType.workoutType(), HKSeriesType.workoutRoute()].map { type in
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, _ in
                // HealthKit's handler is not declared Sendable, but may be called from any thread.
                nonisolated(unsafe) let done = completion
                // Also on an error: a callback that stays unanswered counts against the app.
                changed { done() }
            }
            store.execute(query)
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { ok, error in
                if !ok { failed(error?.localizedDescription ?? "no reason given") }
            }
            return query
        }
    }

    /// The workouts that started at or after `since`, or nil while Health cannot be read (the phone is locked).
    func list(since: Date) async throws -> [WorkoutRef]? {
        guard HKHealthStore.isHealthDataAvailable(), await MainActor.run(body: { UIApplication.shared.isProtectedDataAvailable }) else { return nil }
        let workouts: [HKWorkout]
        do {
            workouts = try await HKSampleQueryDescriptor(
                predicates: [.workout(HKQuery.predicateForSamples(withStart: since, end: nil, options: .strictStartDate))],
                sortDescriptors: [SortDescriptor(\.endDate)]).result(for: store)
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            return nil
        }
        return workouts.map { workout in
            WorkoutRef(id: workout.uuid.uuidString, end: workout.endDate) { [store] in try await HealthReader.read(workout, from: store) }
        }
    }

    /// One workout whole. Throws when one of its queries fails; the check then leaves the workout out.
    private static func read(_ workout: HKWorkout, from store: HKHealthStore) async throws -> Workout {
        let bpm = HKUnit.count().unitDivided(by: .minute())
        let heartRate = HKQuantityType(.heartRate)
        let end = workout.endDate

        let window = HKQuery.predicateForSamples(withStart: workout.startDate, end: end.addingTimeInterval(Workout.recoverySeconds))
        let rates = try await HKSampleQueryDescriptor(predicates: [.quantitySample(type: heartRate, predicate: window)],
                                                      sortDescriptors: [SortDescriptor(\.startDate)]).result(for: store)
            .filter { $0.startDate >= workout.startDate }
            .map { Workout.HeartRate(time: $0.startDate, bpm: $0.quantity.doubleValue(for: bpm), source: $0.sourceRevision.source.name) }
        let during = rates.filter { $0.time <= end }

        var points: [Workout.RoutePoint] = []
        let routes = try await HKSampleQueryDescriptor(predicates: [.workoutRoute(HKQuery.predicateForObjects(from: workout))],
                                                       sortDescriptors: [SortDescriptor(\.startDate)]).result(for: store)
        for route in routes {
            for try await l in HKWorkoutRouteQueryDescriptor(route).results(for: store) {
                // The values as iOS gives them; RoutePoint leaves out what iOS marks as not available.
                if let point = Workout.RoutePoint(time: l.timestamp, lat: l.coordinate.latitude, lon: l.coordinate.longitude,
                                                  horizontalAccuracy: l.horizontalAccuracy, altitude: l.altitude, verticalAccuracy: l.verticalAccuracy,
                                                  speed: l.speed, speedAccuracy: l.speedAccuracy, course: l.course, courseAccuracy: l.courseAccuracy) {
                    points.append(point)
                }
            }
        }
        points.sort { $0.time < $1.time }

        func sum(_ id: HKQuantityTypeIdentifier, _ unit: HKUnit) -> Double? {
            workout.statistics(for: HKQuantityType(id))?.sumQuantity()?.doubleValue(for: unit)
        }
        func metadata(_ key: String, _ unit: HKUnit) -> Double? { (workout.metadata?[key] as? HKQuantity)?.doubleValue(for: unit) }
        var steps = sum(.stepCount, .count())
        if steps == nil {
            // The workout carries no step total of its own: the steps Health has for its time.
            let during = HKQuery.predicateForSamples(withStart: workout.startDate, end: end)
            steps = try await HKStatisticsQueryDescriptor(predicate: .quantitySample(type: HKQuantityType(.stepCount), predicate: during),
                                                          options: .cumulativeSum).result(for: store)?.sumQuantity()?.doubleValue(for: .count())
        }
        let statistics = workout.statistics(for: heartRate)
        let values = during.map(\.bpm)
        // Apple writes the humidity as 61 for 61 %, where the unit's own scale would be 0.61.
        let humidity = metadata(HKMetadataKeyWeatherHumidity, .percent()).map { $0 <= 1 ? $0 * 100 : $0 }

        return Workout(
            id: workout.uuid.uuidString, activityType: workout.workoutActivityType.rawValue, start: workout.startDate, end: end,
            duration: workout.duration, isIndoor: workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool,
            distanceM: sum(.distanceWalkingRunning, .meter()) ?? sum(.distanceCycling, .meter()),
            activeEnergyKcal: sum(.activeEnergyBurned, .kilocalorie()),
            elevationUpM: metadata(HKMetadataKeyElevationAscended, .meter()),
            temperatureC: metadata(HKMetadataKeyWeatherTemperature, .degreeCelsius()), humidityPct: humidity,
            hrMin: statistics?.minimumQuantity()?.doubleValue(for: bpm) ?? values.min(),
            hrAvg: statistics?.averageQuantity()?.doubleValue(for: bpm) ?? (values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)),
            hrMax: statistics?.maximumQuantity()?.doubleValue(for: bpm) ?? values.max(),
            steps: steps, heartRate: during, recovery: rates.filter { $0.time > end }, route: points)
    }
}

#if targetEnvironment(simulator)
extension HealthReader {
    /// Simulator only: writes one synthetic ten-minute walk near 42.50/1.50 with heart rate and a route.
    /// The code is not compiled into a build for a phone: the app never writes to Health there.
    func addSyntheticWalk() async throws {
        let share: Set<HKSampleType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute(), HKQuantityType(.heartRate)]
        try await store.requestAuthorization(toShare: share, read: Self.readTypes)
        let end = Date.now.addingTimeInterval(-300), start = end.addingTimeInterval(-600)
        let configuration = HKWorkoutConfiguration()
        configuration.activityType = .walking
        configuration.locationType = .outdoor
        let builder = HKWorkoutBuilder(healthStore: store, configuration: configuration, device: .local())
        try await builder.beginCollection(at: start)
        let bpm = HKUnit.count().unitDivided(by: .minute())
        // Every 5 s, to three minutes after the end: what follows the end is the recovery.
        let rates = stride(from: 0.0, to: 780, by: 5).map { t in
            HKQuantitySample(type: HKQuantityType(.heartRate), quantity: HKQuantity(unit: bpm, doubleValue: 95 + (t / 30).rounded()),
                             start: start.addingTimeInterval(t), end: start.addingTimeInterval(t))
        }
        try await builder.addSamples(rates.filter { $0.startDate < end })
        try await store.save(rates.filter { $0.startDate >= end })
        try await builder.addMetadata([HKMetadataKeyIndoorWorkout: false])
        try await builder.endCollection(at: end)
        guard let workout = try await builder.finishWorkout() else { return }
        let route = HKWorkoutRouteBuilder(healthStore: store, device: .local())
        // Starts 55 m south of 42.50/1.50, inside the stand-in server's private zone, and walks 670 m north.
        let locations = stride(from: 0.0, through: 600, by: 2).map { t in
            CLLocation(coordinate: CLLocationCoordinate2D(latitude: 42.4995 + t * 0.00001, longitude: 1.5), altitude: 1000 + t / 60,
                       horizontalAccuracy: 4, verticalAccuracy: 3, course: 0, speed: 1.1, timestamp: start.addingTimeInterval(t))
        }
        try await route.insertRouteData(locations)
        try await route.finishRoute(with: workout, metadata: nil)
    }
}
#endif
