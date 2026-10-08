import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct HomeZoneTests {
    let home = HomeZone(lat: 42.5, lon: 1.5, radiusM: 300)
    let config = ServerConfig(baseURL: URL(string: "https://example.invalid")!, token: "test-token-not-a-secret", device: "trial-iphone")

    @Test func containsAFixInsideTheCircleAndNotOneBeyondItsEdge() {
        // ~0.001 deg of latitude is 111 m.
        #expect(home.contains(Fix(time: .now, lat: 42.5, lon: 1.5)))
        #expect(home.contains(Fix(time: .now, lat: 42.5026, lon: 1.5)))      // 289 m north
        #expect(!home.contains(Fix(time: .now, lat: 42.5028, lon: 1.5)))     // 311 m north
    }

    @Test func isReadFromTheServersAnswer() throws {
        let answer = #"{"stored":1,"duplicates":0,"skipped":[],"home":{"lat":42.5,"lon":1.5,"radiusM":300}}"#
        struct Answer: Decodable { let home: HomeZone? }
        #expect(try JSONDecoder().decode(Answer.self, from: Data(answer.utf8)).home == home)
        #expect(try JSONDecoder().decode(Answer.self, from: Data(#"{"stored":1,"duplicates":0,"skipped":[]}"#.utf8)).home == nil)
    }

    /// Breaks if the circle goes back to UserDefaults, which iCloud and computer backups carry: its centre is home.
    @Test func isKeptInAFileOutOfBackupsAndNilRemovesIt() throws {
        let url = try scratch().appendingPathComponent("home-zone")
        #expect(HomeZone.stored(at: url) == nil)
        HomeZone.store(home, at: url)
        #expect(HomeZone.stored(at: url) == home)
        #expect(try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true)
        HomeZone.store(nil, at: url)
        #expect(HomeZone.stored(at: url) == nil)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    /// Versions up to 1.0 (1) kept the circle in UserDefaults: it must leave the backups too.
    @Test func theCircleAnEarlierVersionLeftInTheDefaultsIsRemoved() throws {
        let defaults = UserDefaults(suiteName: "HomeZoneTests-\(UUID().uuidString)")!
        defaults.set(try JSONEncoder().encode(home), forKey: "homeZone")
        HomeZone.removeLegacy(from: defaults)
        #expect(defaults.object(forKey: "homeZone") == nil)
    }

    /// A server's circle turns the GPS off inside it: one that is no place on Earth, or wider than a home, is ignored.
    @Test(arguments: [
        (HomeZone(lat: 42.5, lon: 1.5, radiusM: 300), true),
        (HomeZone(lat: 42.5, lon: 1.5, radiusM: 1000), true),
        (HomeZone(lat: 42.5, lon: 1.5, radiusM: 1001), false),
        (HomeZone(lat: 42.5, lon: 1.5, radiusM: 1e9), false),
        (HomeZone(lat: 42.5, lon: 1.5, radiusM: 0), false),
        (HomeZone(lat: 42.5, lon: 1.5, radiusM: -5), false),
        (HomeZone(lat: 90.5, lon: 1.5, radiusM: 300), false),
        (HomeZone(lat: -90.5, lon: 1.5, radiusM: 300), false),
        (HomeZone(lat: 42.5, lon: 180.5, radiusM: 300), false),
        (HomeZone(lat: 42.5, lon: -180.5, radiusM: 300), false),
    ])
    func aServersCircleIsTakenOnlyWhenItIsAPlaceAndAHomesSize(zone: HomeZone, taken: Bool) async throws {
        let body = #"{"stored":1,"duplicates":0,"skipped":[],"home":{"lat":\#(zone.lat),"lon":\#(zone.lon),"radiusM":\#(zone.radiusM)}}"#
        let server = FakeServer([.init(body: body)])
        let queue = try PositionQueue(directory: scratch())
        try queue.append(Position(sample: sample(0), keptForTime: false))
        let uploader = Uploader(queue: queue, send: server.send)
        #expect(await uploader.drain(config: config) == .sent(stored: 1, duplicates: 0, skipped: 0))
        #expect(await uploader.home == (taken ? zone : nil))
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
