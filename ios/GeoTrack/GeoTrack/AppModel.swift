import CoreLocation
import GeoTrackKit
import PhotosUI
import SwiftUI
import UIKit

/// The app's state: mode, queue, uploads. Lives from launch, also when iOS starts the app in the background.
@MainActor
@Observable
final class AppModel {
    struct Kept: Equatable {
        let time: Date
        let accuracy: Int?
    }

    /// What the last upload of positions did. Kept across relaunches, so that Status can say when.
    struct UploadReport: Codable, Equatable {
        var time: Date
        /// Counts and reasons only: never a place or the token. A reason iOS words can name the server's host.
        var text: String
        /// Why the server refused the settings, when it did: the line goes when Setup is saved with others, and
        /// until then Status lists the stop among the problems, after a relaunch too.
        var stopReason: String?
        var stopped: Bool { stopReason != nil }
    }

    var mode: Mode {
        didSet {
            mode.store()
            apply()
        }
    }
    var settings: Settings
    private(set) var waiting = 0
    private(set) var rejected = 0
    private(set) var lastKept: Kept?
    /// Asleep at Home since then (GPS off, iOS watches the zone edge); nil while awake.
    private(set) var asleepSince: Date?
    private(set) var lastUpload: UploadReport? {
        didSet { UserDefaults.standard.set(try? JSONEncoder().encode(lastUpload), forKey: AppModel.uploadReportKey) }
    }
    private(set) var storageProblem: String?
    /// The Keychain did not take the last save of Setup; nil after one that worked.
    private(set) var settingsProblem: String?
    private(set) var location = StatusSummary.Location.notAsked
    private(set) var precise = true
    private(set) var backgroundRefresh = StatusSummary.BackgroundRefresh.on
    private(set) var workouts = WorkoutSync.Status()
    private(set) var healthProblem: String?
    private(set) var photos = PhotoReport()
    private(set) var photosWaiting = 0
    /// Photos without a location that wait for the owner's answer.
    private(set) var photosHeld = 0
    /// The owner has answered, and the intake has not yet said that nothing is held: the question is not asked again.
    private var photosAnswered = false
    /// iOS ended the time of a round or of a pick that was still being read (or granted none). In Manual and
    /// Paused what waits then goes out on the owner's word ("Send now", a new pick), not by the rest of that
    /// pick; in Auto it goes out by itself.
    private var photosInterrupted = false
    /// "Reading 3 of 12" while a pick is read.
    private(set) var photosReading: String?
    /// The background time of the pick that is being read; nil when none is.
    private var pickTime: BackgroundTask?
    private(set) var photosProblem: String?
    /// Why the photo uploads are stopped, while they are.
    private(set) var photosStop: String?

    private let queue: PositionQueue
    private let keeper: Keeper
    private let uploader: Uploader
    private let recorder = Recorder()
    private let health = HealthReader()
    private let workoutSync: WorkoutSync
    private let photoQueue: PhotoQueue
    private let photoIntake: PhotoIntake
    private let photoUploader: PhotoUploader
    private static let photoReportKey = "photoReport"
    private static let uploadReportKey = "uploadReport"
    /// The reason of the stop Status already shows from this launch; nil when the last outcome was no stop.
    private var standingStop: String?

    init() throws {
        // First, and throwing: before the phone's first unlock neither the Keychain nor the app's files can be
        // read, and a model built on defaults would record in the wrong mode and upload nothing.
        settings = try Keychain.load()
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let folder = support.appendingPathComponent("queue", isDirectory: true)
        queue = try PositionQueue(directory: folder)
        // Inside the queue's folder, which is kept out of backups: the last kept position is a precise place,
        // usually home. Its name does not end in .json, so the queue never takes it for a position.
        keeper = Keeper(queue: queue, lastKeptURL: folder.appendingPathComponent("last-kept"))
        uploader = Uploader(queue: queue)
        // The ledger holds IDs and counts only; it lies beside the queue's folder, not in it.
        let relay = StatusRelay()
        workoutSync = WorkoutSync(ledger: WorkoutLedger(url: support.appendingPathComponent("workouts-ledger.json")),
                                  list: { [health] in try await health.list(since: $0) }, background: AppModel.inBackground(relay),
                                  onStatus: { status in Task { @MainActor in relay.deliver?(status) } })
        // Beside the position queue: the waiting photos hold precise places too.
        photoQueue = try PhotoQueue(directory: support.appendingPathComponent("photos", isDirectory: true))
        try? FileManager.default.removeItem(at: PickedFile.folder) // copies a launch before did not get to read
        let saved = UserDefaults.standard.data(forKey: AppModel.photoReportKey).flatMap { try? JSONDecoder().decode(PhotoReport.self, from: $0) } ?? PhotoReport()
        // The intake's reports go through a stream: read by one loop, they arrive in the order they were made.
        let (photoChanges, photoChanged) = AsyncStream.makeStream(of: (PhotoReport, Int).self)
        let intake = PhotoIntake(queue: photoQueue, report: saved, onChange: { photoChanged.yield(($0, $1)) })
        photoIntake = intake
        photoUploader = PhotoUploader(queue: photoQueue, onAnswer: { await intake.record($0) })
        photos = saved
        photosWaiting = photoQueue.count()
        mode = Mode.stored()
        // From before this launch; its accuracy is not kept on disk.
        lastKept = keeper.last.map { Kept(time: $0.time, accuracy: nil) }
        lastUpload = UserDefaults.standard.data(forKey: AppModel.uploadReportKey).flatMap { try? JSONDecoder().decode(UploadReport.self, from: $0) }
        recorder.onSample = { [weak self] sample, woke in self?.offer(sample, wokeFromHome: woke) }
        recorder.onSleep = { [weak self] in self?.asleepSince = $0 }
        recorder.home = HomeZone.stored()
        recorder.onAuthorization = { [weak self] in self?.readLocationAccess() }
        readLocationAccess()
        readBackgroundRefresh()
        let refreshChanges = [UIApplication.backgroundRefreshStatusDidChangeNotification, UIApplication.didBecomeActiveNotification,
                              Notification.Name.NSProcessInfoPowerStateDidChange]
        for name in refreshChanges {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.readBackgroundRefresh()
                    self?.readLocationAccess()
                }
            }
        }
        relay.deliver = { [weak self] in self?.workouts = $0 }
        relay.sendsByItself = { [weak self] in self?.mode == .auto }
        Task { [weak self] in
            for await (report, held) in photoChanges {
                guard let self else { return }
                photos = report
                photosHeld = held
                if held == 0 { photosAnswered = false }
                photosWaiting = photoQueue.count()
                forgetInterruptionIfNothingWaits()
                // Counts and reasons only: the lines are not encoded.
                UserDefaults.standard.set(try? JSONEncoder().encode(report), forKey: AppModel.photoReportKey)
            }
        }
        // Before anything else is asked of Health: iOS delivers in the background only to observers that
        // are registered on every launch.
        observeHealth()
        for name in [UIApplication.protectedDataDidBecomeAvailableNotification, UIApplication.didBecomeActiveNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.checkWorkouts()
                    if self?.mode == .auto { self?.sendPhotos(manual: false) }
                }
            }
        }
        refreshCounts()
        apply()
        checkWorkouts()
    }

    /// Asks iOS for read access to Health when it has not asked yet. Called when the app comes to the front,
    /// because iOS shows the sheet only then.
    func askForHealthAccess() {
        Task {
            guard await health.requestAccessIfNeeded() else { return }
            observeHealth() // an observer registered before the answer has ended with an error
            checkWorkouts()
        }
    }

    private func observeHealth() {
        healthProblem = nil
        health.observe({ [weak self] completion in
            Task { @MainActor in
                guard let self else { return completion() }
                self.checkWorkouts(completion: completion)
            }
        }, failed: { [weak self] reason in
            Task { @MainActor in self?.healthProblem = "Workouts are sent only while the app is open: \(reason)" }
        })
    }

    /// Asks for a check of the workouts. `completion` is Health's handler when Health asked for the check;
    /// the sync answers it.
    private func checkWorkouts(manual: Bool = false, completion: (@Sendable () -> Void)? = nil) {
        let job = WorkoutSync.Job(config: settings.workoutsConfig, device: settings.workoutsDevice, since: settings.workoutsSince,
                                  sends: mode == .auto || manual, manual: manual)
        Task { await workoutSync.request(job, completion: completion) }
    }

    /// Runs the workout uploads under a background task, so iOS grants the time it has also when location
    /// recording is not keeping the app running. When that time runs out in Manual or Paused, the round is
    /// stopped for good, as a photo round is: a round iOS put to sleep must not go on sending when the app is
    /// opened again. In Auto it may go on: Auto sends what is left by itself anyway, and while recording keeps
    /// the app running the round simply ends.
    private static func inBackground(_ relay: StatusRelay) -> WorkoutSync.Background {
        { work in
            // Both on the main actor: the round starts only after the time was asked for, so a round that gets
            // none is cancelled before its first request.
            let (round, task) = await MainActor.run {
                let round = Task { await work() }
                return (round, BackgroundTask(name: "workouts") { if relay.sendsByItself?() != true { round.cancel() } })
            }
            await round.value
            await MainActor.run { task.end() }
        }
    }

    #if targetEnvironment(simulator)
    /// Simulator only: one synthetic workout to test with.
    func addSyntheticWorkout() {
        Task {
            do {
                try await health.addSyntheticWalk()
                observeHealth()
                checkWorkouts()
            } catch { storageProblem = "The synthetic workout was not written: \(error.localizedDescription)" }
        }
    }
    #endif

    private func apply() {
        if mode.records { recorder.start() } else { recorder.stop() }
        if mode == .auto {
            upload(manual: false)
            checkWorkouts()
            sendPhotos(manual: false)
        }
    }

    /// Takes a pick: reads the photos one by one, so that memory holds one original at a time, and sends
    /// them while the rest is read. A pick is itself the order to send, in every mode.
    func addPhotos(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty, photosReading == nil else { return }
        photosReading = "Reading 1 of \(items.count)"
        photosInterrupted = false // a new pick is the owner's word; cleared here, before iOS's time can end
        holdPickTime()
        Task {
            await photoIntake.begin()
            for (index, item) in items.enumerated() {
                photosReading = "Reading \(index + 1) of \(items.count)"
                if let file = try? await item.loadTransferable(type: PickedFile.self) {
                    await photoIntake.add(file: file.url)
                    file.discard()
                } else {
                    await photoIntake.addNotReceived(fileName: "Photo \(index + 1)")
                }
                // The pick lifts a stop once, not with every photo. Once iOS's time has ended, also before the
                // first photo went out, the pick only queues, unless the mode sends by itself.
                if !photosInterrupted || mode == .auto { sendPhotos(manual: index == 0) }
            }
            photosReading = nil
            pickTime?.end()
            pickTime = nil
            photosWaiting = photoQueue.count()
            forgetInterruptionIfNothingWaits()
        }
    }

    /// Nothing waits and no pick is being read: an interruption has nothing left to hold back, and its line goes.
    private func forgetInterruptionIfNothingWaits() {
        guard photosInterrupted, photosWaiting == 0, photosReading == nil else { return }
        photosInterrupted = false
        photosProblem = nil
    }

    /// Asks iOS for background time for the pick that is being read. Held for the whole pick, also between two
    /// rounds and while a file is fetched: without it iOS could put the app to sleep unnoticed, and the rest of
    /// the pick would go out by itself when the app is opened again. Asked for anew when the owner's word lifts
    /// an interruption, because the time asked for before has ended by then.
    private func holdPickTime() {
        pickTime?.end()
        pickTime = BackgroundTask(name: "photo pick") { [weak self] in self?.photosWereInterrupted() }
    }

    /// iOS's time ran out, or none was granted. Called at the expiry itself, so that nothing starts between it and
    /// the cancelled round's outcome, and again when that outcome arrives.
    private func photosWereInterrupted() {
        photosInterrupted = true
        photosProblem = "Interrupted: iOS ended the time for sending"
    }

    /// Whether to ask about the picked photos without a location: once, when the pick is read.
    var asksAboutLocation: Bool { photosHeld > 0 && photosReading == nil && !photosAnswered }

    /// The owner's answer for the picked photos without a location.
    func answerNoLocation(send: Bool) {
        photosAnswered = true // at the tap: the question must not come up again while the intake works
        Task {
            await photoIntake.resolveHeld(send: send)
            if send { sendPhotos(manual: false) }
        }
    }

    private func sendPhotos(manual: Bool) {
        guard let config = settings.serverConfig else { return }
        let round = Task { [photoUploader] in await photoUploader.round(config: config, manual: manual) }
        // iOS's time for a round is limited. When it runs out the round is stopped for good, in every mode:
        // a round that iOS put to sleep must not go on sending when the app is opened again.
        let background = BackgroundTask(name: "photos") { [weak self] in
            round.cancel()
            self?.photosWereInterrupted()
        }
        Task {
            let outcome = await round.value
            background.end()
            photosWaiting = photoQueue.count()
            switch outcome {
            case .busy: break
            case .done:
                photosStop = nil
                // Everything that waited went out. While an interrupted pick is still being read the line
                // stays: in Manual and Paused the rest of it will wait.
                if !(photosInterrupted && photosReading != nil) {
                    photosProblem = nil
                    photosInterrupted = false
                }
            case let .retryLater(reason):
                photosStop = nil
                photosProblem = "Not sent: \(reason)"
            case let .stopped(reason):
                photosStop = reason
                photosProblem = "Stopped: \(reason)"
            case .interrupted:
                photosStop = nil // a stopped round ends as stopped before it can be interrupted
                photosWereInterrupted()
            }
        }
    }

    private func offer(_ sample: Sample, wokeFromHome: Bool) {
        do {
            guard let position = try keeper.offer(sample, wokeFromHome: wokeFromHome) else { return }
            storageProblem = keeper.saveProblem.map { "The last kept position was not saved: \($0)" }
            lastKept = Kept(time: sample.time, accuracy: position.acc)
            refreshCounts()
            if mode == .auto { upload(manual: false) }
        } catch {
            storageProblem = "Storage failed: \(error.localizedDescription)"
        }
    }

    /// What Status shows for the last upload of positions.
    var uploadStatus: String {
        guard let lastUpload else { return "never" }
        return "\(AppModel.short(lastUpload.time)): \(lastUpload.text)"
    }

    /// What Status says first, about positions, workouts and photos alike. Whether Setup is complete is read from
    /// the settings as they are now. A stop of the workouts or the photos counts only while it stands in
    /// memory; one of the positions is also taken from the last upload's report, which outlives a relaunch.
    var summary: StatusSummary {
        var stops: [StatusSummary.Stop] = []
        // After a relaunch no stop stands in memory, but the last upload still ended in one. It is listed until
        // the next try says otherwise (it works, or fails for another reason) or Setup is saved with other settings.
        if let stop = standingStop ?? lastUpload?.stopReason { stops.append(.init(.positions, stop)) }
        if let stop = workouts.stop { stops.append(.init(.workouts, stop)) }
        if let photosStop { stops.append(.init(.photos, photosStop)) }
        var more: [StatusSummary.Problem] = []
        if let storageProblem { more.append(.init(title: "Storage problem", detail: storageProblem)) }
        if let settingsProblem { more.append(.init(title: "Setup was not saved", detail: settingsProblem)) }
        if let healthProblem { more.append(.init(title: "Health does not deliver in the background", detail: healthProblem)) }
        return StatusSummary(mode: mode, setupComplete: settings.serverConfig != nil, workoutsSetupComplete: settings.workoutsConfig != nil,
                             location: location, precise: precise, backgroundRefresh: backgroundRefresh, stops: stops, more: more,
                             waiting: waiting + workouts.waiting + photosWaiting, asleep: asleepSince.map { "since \(AppModel.short($0))" })
    }

    /// A time of today as the time alone, an earlier one with its day: "21:13", "2 Oct, 21:59".
    static func short(_ date: Date) -> String {
        Calendar.current.isDateInToday(date) ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.day().month(.abbreviated).hour().minute())
    }

    func sendNow() {
        upload(manual: true)
        checkWorkouts(manual: true)
        photosInterrupted = false
        if photosReading != nil { holdPickTime() }
        sendPhotos(manual: true)
    }

    func saveSettings(_ new: Settings) {
        let changed = new.serverConfig != settings.serverConfig
        settings = new
        // Kept until a save works: the settings in use are the new ones, the Keychain still holds the old ones.
        settingsProblem = Keychain.save(new) ? nil : "The Keychain did not take the settings: after the app is started again the old ones are back. Save again."
        // A stop belongs to the settings that earned it. Saved with others, its line goes from Status in every
        // mode; the uploaders drop the stop itself at their next call. The workouts' line goes with the check below.
        if changed {
            if lastUpload?.stopped == true { lastUpload = UploadReport(time: .now, text: "Setup was saved, nothing sent since") }
            standingStop = nil
            if photosStop != nil { (photosStop, photosProblem) = (nil, nil) }
        }
        // In Auto every save tries again at once, also with the same settings.
        if mode == .auto {
            upload(manual: true)
            sendPhotos(manual: true)
        }
        // In Auto a save counts as "Send now" for the workouts too; a new workouts device name sends them all again.
        checkWorkouts(manual: mode == .auto)
    }

    private func upload(manual: Bool) {
        guard let config = settings.serverConfig else { return }
        // iOS's time to finish when the app is left meanwhile: in Paused nothing else keeps it running, and the
        // server's answer would wait until the app is opened again. When the time runs out the upload is not
        // stopped: what has no answer yet stays in the queue.
        let background = BackgroundTask(name: "positions")
        Task {
            let outcome = await uploader.drain(config: config, manual: manual)
            background.end()
            switch outcome {
            case .idle, .busy, .paused: break
            case let .sent(stored, duplicates, skipped):
                standingStop = nil
                // The base zone the server names is where the recorder may sleep; an answer that names none ends that.
                let home = await uploader.home
                if home != recorder.home { HomeZone.store(home); recorder.home = home }
                lastUpload = UploadReport(time: .now, text: "\(stored) stored" + (duplicates > 0 ? ", \(duplicates) known" : "")
                    + (skipped > 0 ? ", \(skipped) skipped by the server" : ""))
                // A server that just answered is the moment to retry a workout that waits or failed.
                if workouts.waiting > 0 || workouts.problem != nil { checkWorkouts() }
                if mode == .auto, photosWaiting > 0 { sendPhotos(manual: false) }
            case let .retryLater(reason):
                standingStop = nil
                lastUpload = UploadReport(time: .now, text: "failed, will retry (\(reason))")
            case let .stopped(reason):
                // A stop that stands answers every kept position: the line keeps the time of the try that earned it.
                // After a relaunch no stop stands, so the first try's stop is written with its own time.
                if manual || standingStop != reason {
                    lastUpload = UploadReport(time: .now, text: "stopped: \(reason)", stopReason: reason)
                }
                standingStop = reason
            }
            refreshCounts()
        }
    }

    private func refreshCounts() {
        waiting = queue.count()
        rejected = queue.rejectedCount()
    }

    /// The phone-wide setting: GeoTrack has no switch of its own under Background App Refresh, because it
    /// declares no background fetch. While it is off, iOS may not start the app again after ending it.
    private func readBackgroundRefresh() {
        let lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
        backgroundRefresh = switch UIApplication.shared.backgroundRefreshStatus {
        case .restricted: .restricted
        case .denied where !lowPower: .off
        default: lowPower ? .lowPower : .on
        }
    }

    private func readLocationAccess() {
        location = switch recorder.authorization {
        case .authorizedAlways: .always
        case .authorizedWhenInUse: .whenInUse
        case .denied, .restricted: .denied
        default: .notAsked
        }
        precise = recorder.precise
    }
}

/// Links the sync and the model, which does not exist yet when the sync is created.
@MainActor
private final class StatusRelay {
    var deliver: ((WorkoutSync.Status) -> Void)?
    /// Whether the mode is Auto, asked when a round's background time runs out.
    var sendsByItself: (() -> Bool)?
}

/// A background task that ends itself when iOS's time for it runs out. `onExpiry` runs first: the place to
/// stop the work the time was asked for.
@MainActor
private final class BackgroundTask {
    private var id = UIBackgroundTaskIdentifier.invalid

    init(name: String, onExpiry: (@MainActor () -> Void)? = nil) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated {
                onExpiry?()
                self?.end()
            }
        }
        // iOS grants no time (the app is about to be suspended): the work is stopped now, not left to go on later.
        if id == .invalid, UIApplication.shared.applicationState != .active { onExpiry?() }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
