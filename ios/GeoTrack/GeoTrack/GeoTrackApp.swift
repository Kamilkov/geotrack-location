import SwiftUI
import UIKit

/// Creates the app's state, and tries again when that was not possible yet: iOS can start the process before
/// the phone's first unlock, when neither the Keychain nor the app's files can be read.
@MainActor
@Observable
final class AppHost {
    private(set) var model: AppModel?
    /// Why there is no model yet; shown on the screen that stands in for the app.
    private(set) var problem: String?

    init() {
        start()
        let retryOn = [UIApplication.didFinishLaunchingNotification, UIApplication.protectedDataDidBecomeAvailableNotification,
                       UIApplication.didBecomeActiveNotification]
        for name in retryOn {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.start() }
            }
        }
        // A process iOS put to sleep gets none of these notifications: also try again whenever it runs.
        Task {
            while model == nil {
                try? await Task.sleep(for: .seconds(15))
                start()
            }
        }
    }

    private func start() {
        guard model == nil else { return }
        do {
            model = try AppModel()
            problem = nil
        } catch {
            problem = String(describing: error)
        }
    }
}

@main
struct GeoTrackApp: App {
    /// Created at launch, not when a screen appears: iOS can start the app in the background, without any screen.
    @State private var host = AppHost()

    var body: some Scene {
        WindowGroup {
            if let model = host.model {
                TabView {
                    Tab("Status", systemImage: "location") { StatusView(model: model) }
                    Tab("Setup", systemImage: "gearshape") { SetupView(model: model) }
                }
            } else {
                ContentUnavailableView("Storage is not available yet", systemImage: "externaldrive.badge.xmark",
                                       description: Text("Before the phone's first unlock this is expected: the app starts by itself as soon as its storage can be read. If the phone is unlocked and this stays, the cause is: \(host.problem ?? "unknown")"))
            }
        }
    }
}
