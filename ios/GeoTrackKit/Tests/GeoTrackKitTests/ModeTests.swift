import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct ModeTests {
    @Test func isAutoUntilChosenAndThenSurvivesARestart() throws {
        let name = "geotrack-test-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        #expect(Mode.stored(in: defaults) == .auto)
        Mode.paused.store(in: defaults)
        #expect(Mode.stored(in: try #require(UserDefaults(suiteName: name))) == .paused)
    }

    @Test func onlyPausedStopsRecording() {
        #expect(Mode.allCases.filter(\.records) == [.auto, .manual])
    }
}
