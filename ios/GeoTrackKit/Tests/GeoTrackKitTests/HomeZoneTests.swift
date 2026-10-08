import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct HomeZoneTests {
    let home = HomeZone(lat: 42.5, lon: 1.5, radiusM: 300)

    @Test func containsAFixInsideTheCircleAndNotOneBeyondItsEdge() {
        // ~0.001 deg of latitude is 111 m.
        #expect(home.contains(Fix(time: .now, lat: 42.5, lon: 1.5)))
        #expect(home.contains(Fix(time: .now, lat: 42.5026, lon: 1.5)))      // 289 m north
        #expect(!home.contains(Fix(time: .now, lat: 42.5028, lon: 1.5)))     // 311 m north
    }

    @Test func isReadFromTheServersAnswerAndSurvivesTheDefaults() throws {
        let answer = #"{"stored":1,"duplicates":0,"skipped":[],"home":{"lat":42.5,"lon":1.5,"radiusM":300}}"#
        struct Answer: Decodable { let home: HomeZone? }
        #expect(try JSONDecoder().decode(Answer.self, from: Data(answer.utf8)).home == home)
        #expect(try JSONDecoder().decode(Answer.self, from: Data(#"{"stored":1,"duplicates":0,"skipped":[]}"#.utf8)).home == nil)

        let defaults = UserDefaults(suiteName: "HomeZoneTests-\(UUID().uuidString)")!
        #expect(HomeZone.stored(in: defaults) == nil)
        home.store(in: defaults)
        #expect(HomeZone.stored(in: defaults) == home)
        HomeZone.store(nil, in: defaults)
        #expect(HomeZone.stored(in: defaults) == nil)
    }
}

@Suite struct HomeSleepTests {
    let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    @Test func sleepsOnceThePhoneHasBeenOfflineAtHomeForTheGrace() {
        #expect(!HomeSleep.shouldSleep(offlineSince: nil, now: t0, insideHome: true), "online: awake")
        #expect(!HomeSleep.shouldSleep(offlineSince: t0, now: t0 + 59, insideHome: true), "offline for less than the grace: awake")
        #expect(HomeSleep.shouldSleep(offlineSince: t0, now: t0 + 60, insideHome: true))
        #expect(!HomeSleep.shouldSleep(offlineSince: t0, now: t0 + 600, insideHome: false), "offline in a dead zone on a hike: awake")
        #expect(HomeSleep.offlineGrace == 60)
    }
}
