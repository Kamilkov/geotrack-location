import CoreLocation
import CoreMotion
import GeoTrackKit
import Network
import UIKit

/// Asks iOS for fixes and hands each one on with what the other sensors said. It judges nothing:
/// the keep rule lives in GeoTrackKit.
///
/// Home sleep: when the phone has had no network at all for a minute (airplane mode at night) while its last fix
/// lay inside the base zone the server names (`home`), the GPS goes off. The network coming back wakes it; so
/// does iOS at the zone's edge, also from a cold start. The first fix after a sleep is handed on as the wake-up fix.
@MainActor
final class Recorder: NSObject {
    /// A fix with what the sensors said, and whether it is the first after Home sleep.
    var onSample: ((Sample, Bool) -> Void)?
    /// The access to location changed, or its precision.
    var onAuthorization: (() -> Void)?
    /// Asleep at Home since then, or nil once awake.
    var onSleep: ((Date?) -> Void)?
    /// The base zone to sleep in; nil means never.
    var home: HomeZone? { didSet { if home != oldValue { monitorHome() } } }
    private(set) var asleepSince: Date? {
        didSet { UserDefaults.standard.set(asleepSince, forKey: Recorder.asleepKey); onSleep?(asleepSince) }
    }

    private let manager = CLLocationManager()
    private let motion = CMMotionActivityManager()
    private let altimeter = CMAltimeter()
    private let path = NWPathMonitor()
    private var activities: [String] = []
    private var confidence: String?
    private var pressureKPa: Double?
    private var connection: String?
    private var recording = false
    /// The next fix is the first after Home sleep.
    private var wokeFromHome = false
    /// Since when the phone has had no network at all; nil while it has one.
    private var offlineSince: Date?
    /// Whether the last fix lay inside `home`.
    private var lastFixInsideHome = false
    private var sleepCheck: Task<Void, Never>?
    private static let asleepKey = "asleepSince", regionID = "home"

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = kCLDistanceFilterNone
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.activityType = .other
        UIDevice.current.isBatteryMonitoringEnabled = true
        path.pathUpdateHandler = { [weak self] path in
            let connection = path.status != .satisfied ? "o" : path.usesInterfaceType(.wifi) ? "w" : "m"
            Task { @MainActor in self?.connectionChanged(connection) }
        }
        path.start(queue: .global(qos: .utility))
    }

    var authorization: CLAuthorizationStatus { manager.authorizationStatus }
    /// Whether iOS gives the app exact places ("Precise Location" in Settings).
    var precise: Bool { manager.accuracyAuthorization == .fullAccuracy }

    func start() {
        guard !recording else { return }
        recording = true
        requestAuthorization()
        // Asleep when the app ended, awake now: iOS started it again, at the zone's edge or elsewhere. The first
        // fix is the wake-up fix; inside Home it only puts the recorder back to sleep.
        if UserDefaults.standard.object(forKey: Recorder.asleepKey) != nil {
            UserDefaults.standard.removeObject(forKey: Recorder.asleepKey)
            wokeFromHome = true
        }
        manager.startUpdatingLocation()
        // Lets iOS relaunch the app after it ended it or after a restart.
        manager.startMonitoringSignificantLocationChanges()
        monitorHome()
        if CMMotionActivityManager.isActivityAvailable() {
            motion.startActivityUpdates(to: .main) { [weak self] activity in
                let names = Recorder.names(of: activity), confidence = Recorder.confidence(of: activity)
                MainActor.assumeIsolated {
                    self?.activities = names
                    self?.confidence = confidence
                }
            }
        }
        if CMAltimeter.isRelativeAltitudeAvailable() {
            altimeter.startRelativeAltitudeUpdates(to: .main) { [weak self] data, _ in
                guard let kPa = data?.pressure.doubleValue else { return }
                MainActor.assumeIsolated { self?.pressureKPa = kPa }
            }
        }
    }

    func stop() {
        recording = false
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        monitorHome()
        if asleepSince != nil { asleepSince = nil } // Paused is the owner's word; nothing wakes a paused recorder
        wokeFromHome = false
        lastFixInsideHome = false
        sleepCheck?.cancel()
        motion.stopActivityUpdates()
        altimeter.stopRelativeAltitudeUpdates()
        // What the sensors said before the pause must not ride on the first positions after it.
        activities = []
        confidence = nil
        pressureKPa = nil
    }

    /// Watches the edge of `home` while recording; nothing otherwise. iOS keeps the region across relaunches.
    private func monitorHome() {
        for region in manager.monitoredRegions where region.identifier == Recorder.regionID { manager.stopMonitoring(for: region) }
        guard recording, let home else { return }
        let region = CLCircularRegion(center: CLLocationCoordinate2D(latitude: home.lat, longitude: home.lon),
                                      radius: min(home.radiusM, manager.maximumRegionMonitoringDistance), identifier: Recorder.regionID)
        region.notifyOnEntry = false
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
    }

    /// Offline at Home for the grace puts the recorder to sleep; the network coming back wakes it.
    private func connectionChanged(_ connection: String) {
        self.connection = connection
        if connection == "o" {
            if offlineSince == nil { offlineSince = .now }
            sleepCheck?.cancel()
            sleepCheck = Task { [weak self] in
                try? await Task.sleep(for: .seconds(HomeSleep.offlineGrace))
                guard !Task.isCancelled else { return }
                self?.considerSleep()
            }
        } else {
            offlineSince = nil
            sleepCheck?.cancel()
            if recording { wake() }
        }
    }

    private func considerSleep() {
        guard recording, asleepSince == nil, home != nil else { return }
        if HomeSleep.shouldSleep(offlineSince: offlineSince, now: .now, insideHome: lastFixInsideHome) { sleep(at: .now) }
    }

    private func sleep(at time: Date) {
        guard asleepSince == nil else { return }
        asleepSince = time
        manager.stopUpdatingLocation()
    }

    private func wake() {
        guard asleepSince != nil else { return }
        asleepSince = nil
        wokeFromHome = true
        manager.startUpdatingLocation()
    }

    private func requestAuthorization() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse: manager.requestAlwaysAuthorization()
        default: break
        }
    }

    /// The sensors' values as iOS gives them. iOS reports "not available" as a negative number;
    /// `Position` leaves such a value out, so nothing is judged here.
    private func sample(_ l: CLLocation) -> Sample {
        let device = UIDevice.current
        return Sample(
            time: l.timestamp, lat: l.coordinate.latitude, lon: l.coordinate.longitude, horizontalAccuracy: l.horizontalAccuracy,
            altitude: l.altitude, verticalAccuracy: l.verticalAccuracy, speed: l.speed, speedAccuracy: l.speedAccuracy,
            course: l.course, courseAccuracy: l.courseAccuracy, batteryLevel: Double(device.batteryLevel),
            batteryState: device.batteryState.rawValue, connection: connection, pressureKPa: pressureKPa,
            activities: activities, motionConfidence: confidence)
    }

    /// The names OwnTracks uses in `motionactivities`.
    private nonisolated static func names(of activity: CMMotionActivity?) -> [String] {
        guard let a = activity else { return [] }
        return [(a.stationary, "stationary"), (a.walking, "walking"), (a.running, "running"), (a.automotive, "automotive"),
                (a.cycling, "cycling"), (a.unknown, "unknown")].filter(\.0).map(\.1)
    }

    private nonisolated static func confidence(of activity: CMMotionActivity?) -> String? {
        switch activity?.confidence {
        case .low: "low"
        case .medium: "medium"
        case .high: "high"
        default: nil
        }
    }
}

extension Recorder: @preconcurrency CLLocationManagerDelegate {
    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard recording else { return }
        for location in locations {
            let s = sample(location)
            if asleepSince != nil {
                // Asleep: a fix still arrives now and then (significant changes). It is dropped, unless it lies
                // outside Home beyond its own accuracy: then the edge was passed and iOS's region event missed.
                guard let home, KeepRule.metres(home.centre, s.fix) - max(s.horizontalAccuracy, 0) > home.radiusM else { continue }
                wake()
            }
            let woke = wokeFromHome
            wokeFromHome = false
            onSample?(s, woke)
            lastFixInsideHome = home?.contains(s.fix) ?? false
            considerSleep() // offline for the grace already, and now a fix inside Home
        }
    }

    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard recording, region.identifier == Recorder.regionID else { return }
        lastFixInsideHome = false
        wake()
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        onAuthorization?()
        guard recording else { return }
        requestAuthorization()
        // The services were started before the owner answered the prompt; start them again now that iOS may
        // deliver. Starting twice does no harm; a sleeping recorder stays asleep.
        if asleepSince == nil { manager.startUpdatingLocation() }
        manager.startMonitoringSignificantLocationChanges()
        monitorHome()
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        // Without the edge watch the recorder would sleep for good: stay awake instead.
        if region?.identifier == Recorder.regionID { wake() }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // A fix that failed is followed by the next one; there is nothing to store.
    }
}
