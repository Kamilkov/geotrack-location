import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct SettingsTests {
    /// Settings saved by an earlier version: the trips app's login is ignored, workouts take their defaults.
    @Test func settingsSavedByAnEarlierVersionKeepTheirValuesAndGetTheDefaults() throws {
        let old = #"{"server":"https://example.invalid","token":"test-token-not-a-secret","device":"iphone","tripsURL":"https://trips.example.invalid/","tripsUser":"u","tripsPassword":"p"}"#
        let settings = try JSONDecoder().decode(Settings.self, from: Data(old.utf8))
        #expect(settings.server == "https://example.invalid")
        #expect(settings.token == "test-token-not-a-secret")
        #expect(settings.device == "iphone")
        #expect(settings.workoutsDevice == "trial-iphone")
        #expect(settings.workoutsSince == Date(timeIntervalSince1970: 1_790_035_200))
        #expect(settings.serverConfig != nil)
    }

    @Test func survivesTheKeychainRoundTrip() throws {
        var settings = Settings()
        settings.server = "https://example.invalid"
        settings.token = "t"
        settings.device = "iphone"
        settings.workoutsDevice = "watch"
        settings.workoutsSince = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(try JSONDecoder().decode(Settings.self, from: JSONEncoder().encode(settings)) == settings)
    }

    @Test func theWorkoutsConfigCarriesTheWorkoutsDeviceName() {
        var settings = Settings()
        settings.server = "https://example.invalid"
        settings.token = "t"
        settings.device = "iphone"
        #expect(settings.serverConfig?.device == "iphone")
        #expect(settings.workoutsConfig?.device == "trial-iphone")
        settings.workoutsDevice = "Trial iPhone"
        #expect(settings.workoutsConfig == nil)
    }
}
