import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct PhotoMetaTests {
    func photo(_ properties: [String: Any]) throws -> Photo {
        try PhotoMeta.photo(fileName: "IMG_0001.HEIC", properties: properties, thumbnail: Data())
    }

    @Test func readsEveryFieldTheMacReads() throws {
        #expect(try photo(photoProperties()) == Photo(fileName: "IMG_0001.HEIC", cameraModel: "iPhone 17 Pro", takenAt: "2026-09-22T17:50:12.345+02:00",
                                                      lat: 42.51, lon: 1.52, altitudeM: 1012.4, accuracyM: 4.7, directionDeg: 272, thumbnail: Data()))
    }

    @Test func theTimeIsWrittenWithItsSubSecondsWhenItHasThemAndAlwaysWithItsOffset() throws {
        #expect(try photo(photoProperties(subSeconds: nil)).takenAt == "2026-09-22T17:50:12+02:00")
        #expect(try photo(photoProperties(subSeconds: "007", offset: "-03:30")).takenAt == "2026-09-22T17:50:12.007-03:30")
        #expect(try photo(photoProperties(offset: "Z")).takenAt == "2026-09-22T17:50:12.345Z")
    }

    @Test(arguments: [nil, "", "0200", "+2:00"])
    func aPhotoWithoutAUTCOffsetIsRefused(offset: String?) {
        #expect(throws: PhotoMeta.Refusal.noTime) { try photo(photoProperties(offset: offset)) }
    }

    /// A ProRAW photo edited in Photos reaches the app as a rendering without a UTC offset, but with the GPS
    /// time of its position, which is UTC. The time taken here is 17:50:12.
    func edited(gpsDate: String?, gpsTime: String?, offset: String? = nil) -> [String: Any] {
        var gps: [String: Any] = ["Latitude": 42.51, "LatitudeRef": "N", "Longitude": 1.52, "LongitudeRef": "E"]
        gps["DateStamp"] = gpsDate
        gps["TimeStamp"] = gpsTime
        return photoProperties(offset: offset, gps: gps)
    }

    @Test(arguments: [
        ("2026:09:22", "15:50:11", "+02:00"), // the fix a second old
        ("2026:09:22", "15:50:12.50", "+02:00"), // a GPS time with a fraction
        ("2026:09:22", "21:20:12", "-03:30"),
        ("2026:09:22", "12:05:10", "+05:45"),
        ("2026:09:22", "17:50:12", "+00:00"),
        ("2026:09:23", "03:50:12", "-10:00"), // UTC is a day ahead
        ("2026:09:22", "03:50:12", "+14:00"), ("2026:09:23", "05:50:12", "-12:00"), // the widest offsets there are
        ("2026:09:22", "15:49:12", "+02:00"), ("2026:09:22", "15:51:12", "+02:00"), // the fix a minute off, either way
    ])
    func aPhotoWithoutAnOffsetGetsItFromItsOwnGPSTime(gpsDate: String, gpsTime: String, offset: String) throws {
        #expect(try photo(edited(gpsDate: gpsDate, gpsTime: gpsTime)).takenAt == "2026-09-22T17:50:12.345\(offset)")
    }

    @Test func theOffsetFromTheGPSTimeNamesThePhotoAsItsUneditedOriginal() throws {
        #expect(try photo(edited(gpsDate: "2026:09:22", gpsTime: "15:50:11")).takenAt == photo(photoProperties()).takenAt)
    }

    @Test(arguments: [
        ("2026:09:22", "15:49:11"), ("2026:09:22", "15:51:13"), // more than a minute off a quarter hour
        ("2026:09:22", "15:42:00"), // a fix eight minutes old
        ("2026:09:22", "03:35:12"), ("2026:09:23", "06:05:12"), // beyond the widest offsets
        ("2026-09-22", "15:50:11"), ("2026:13:45", "15:50:11"), ("2026:09:22", "25:61:61"), ("2026:09:22", "noon"), // no date, no time
        ("2026:09:22", "15:50:71"), // no time either: carried over it would be 15:51:11, and fit
    ])
    func aGPSTimeThatDoesNotFitGivesNoOffsetAndThePhotoIsRefused(gpsDate: String, gpsTime: String) {
        #expect(throws: PhotoMeta.Refusal.noTime) { try photo(edited(gpsDate: gpsDate, gpsTime: gpsTime)) }
    }

    @Test func withoutAGPSDateOrTimeThereIsNoOffset() {
        #expect(throws: PhotoMeta.Refusal.noTime) { try photo(edited(gpsDate: nil, gpsTime: "15:50:11")) }
        #expect(throws: PhotoMeta.Refusal.noTime) { try photo(edited(gpsDate: "2026:09:22", gpsTime: nil)) }
    }

    @Test func anOffsetTheFileNamesStandsAndOneThatIsNoOffsetCountsAsNone() throws {
        #expect(try photo(edited(gpsDate: "2026:09:22", gpsTime: "12:50:12", offset: "+02:00")).takenAt == "2026-09-22T17:50:12.345+02:00")
        #expect(try photo(edited(gpsDate: "2026:09:22", gpsTime: "12:50:12", offset: "0200")).takenAt == "2026-09-22T17:50:12.345+05:00")
    }

    @Test func aPhotoWithoutATimeTakenIsRefused() {
        #expect(throws: PhotoMeta.Refusal.noTime) { try photo(["{Exif}": ["OffsetTimeOriginal": "+02:00"], "{TIFF}": ["Model": "iPhone 17 Pro"]]) }
    }

    @Test(arguments: [nil, "", "  "])
    func aPhotoWithoutACameraModelIsRefused(model: String?) {
        #expect(throws: PhotoMeta.Refusal.noCameraModel) { try photo(photoProperties(model: model)) }
    }

    @Test func theCameraModelIsCutAt60CharactersAndTrimmed() throws {
        #expect(try photo(photoProperties(model: String(repeating: "x", count: 70))).cameraModel.count == 60)
        #expect(try photo(photoProperties(model: " iPhone 17 Pro ")).cameraModel == "iPhone 17 Pro")
    }

    @Test func southAndWestAreNegativeAndSoIsAnAltitudeBelowSeaLevel() throws {
        let p = try photo(photoProperties(gps: ["Latitude": 42.51, "LatitudeRef": "S", "Longitude": 1.52, "LongitudeRef": "W", "Altitude": 12.5, "AltitudeRef": 1]))
        #expect(p.lat == -42.51)
        #expect(p.lon == -1.52)
        #expect(p.altitudeM == -12.5)
        #expect(p.accuracyM == nil)
    }

    @Test func aLatitudeWithoutALongitudeIsNoLocationAndLeavesAltitudeAndAccuracyOut() throws {
        let p = try photo(photoProperties(gps: ["Latitude": 42.51, "LatitudeRef": "N", "Altitude": 1012.4, "HPositioningError": 4.7]))
        #expect(!p.hasLocation)
        #expect(p.lon == nil)
        #expect(p.altitudeM == nil)
        #expect(p.accuracyM == nil)
        #expect(try !photo(photoProperties(gps: nil)).hasLocation)
    }

    @Test func theDirectionIsRoundedInto0To359() throws {
        func direction(_ value: Double) throws -> Int? { try photo(photoProperties(gps: ["ImgDirection": value])).directionDeg }
        #expect(try direction(271.6) == 272)
        #expect(try direction(359.6) == 0)
        #expect(try direction(0.4) == 0)
        #expect(try direction(-90) == 270)
        #expect(try direction(-0.4) == 0)
        #expect(try direction(725.2) == 5)
        #expect((0..<360).contains(try #require(try direction(1e300)))) // a crafted file's number, too large for an Int
        #expect(try photo(photoProperties(gps: nil)).directionDeg == nil)
    }

    @Test func encodedItIsTheRequestBodyAndAValueThatIsNotThereIsLeftOut() throws {
        var p = try photo(photoProperties(gps: nil))
        p.thumbnail = Data([0xff, 0xd8, 0xff, 0xd9])
        let body = try object(JSONEncoder().encode(p))
        #expect(Set(body.keys) == ["fileName", "cameraModel", "takenAt", "thumbnail"])
        #expect(body["thumbnail"] as? String == "/9j/2Q==")
    }

    /// The contract with the server and with the Mac: test/photo-meta.test.js reads the same file and checks
    /// that the server takes it and that the Mac's exiftool record of this photo gives the same fields.
    @Test func theBodyIsTheSharedFixture() throws {
        let fixture = try repoFixture("ios-photo.json")
        let thumbnail = try JSONDecoder().decode(Photo.self, from: fixture).thumbnail
        let body = try JSONEncoder().encode(PhotoMeta.photo(fileName: "IMG_0001.HEIC", properties: photoProperties(), thumbnail: thumbnail))
        #expect(try object(body) as NSDictionary == object(fixture) as NSDictionary)
    }
}
