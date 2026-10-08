import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
@testable import GeoTrackKit

/// Synthetic coordinates near 42.50/1.50, as everywhere in the repo.
let origin = Date(timeIntervalSince1970: 1_790_000_000)

func fix(_ seconds: Double, north metres: Double = 0) -> Fix {
    Fix(time: origin.addingTimeInterval(seconds), lat: 42.5 + metres / 111_195, lon: 1.5)
}

func sample(_ seconds: Double, north metres: Double = 0, accuracy: Double = 5) -> Sample {
    let f = fix(seconds, north: metres)
    return Sample(time: f.time, lat: f.lat, lon: f.lon, horizontalAccuracy: accuracy)
}

/// test/fixtures of the repo: the sample file the Node parser test reads too.
func repoFixture(_ name: String, file: String = #filePath) throws -> Data {
    var url = URL(fileURLWithPath: file)
    for _ in 0..<5 { url.deleteLastPathComponent() } // GeoTrackKitTests, Tests, GeoTrackKit, ios → the repo
    return try Data(contentsOf: url.appendingPathComponent("test/fixtures/\(name)"))
}

struct NotAnObject: Error {}

/// A JSON object from a request body or an encoded value.
func object(_ data: Data?) throws -> [String: Any] {
    guard let data, let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NotAnObject() }
    return object
}

/// A fresh empty folder per test.
func scratch() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("geotrack-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// 2026-09-22T15:43:46Z, the start of the workout in test/fixtures/ios-workout.json.
let workoutStart = Date(timeIntervalSince1970: 1_790_091_826)

/// A route point `seconds` after the workout's start, `metres` north of 42.5003/1.5002, with every value known.
func routePoint(_ seconds: Double, north metres: Double = 0) -> Workout.RoutePoint {
    Workout.RoutePoint(time: workoutStart.addingTimeInterval(seconds), lat: 42.5003 + metres / 111_195, lon: 1.5002, horizontalAccuracy: 4,
                       altitude: 1000, verticalAccuracy: 3, speed: 1.3, speedAccuracy: 0.3, course: 10, courseAccuracy: 9)!
}

/// A five-minute walk with every summary value, `heartRate` samples, `recovery` samples and `route` points.
func walk(_ id: String = "0A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C4D", endedAgo: Double = 0, now: Date = workoutStart.addingTimeInterval(300),
          heartRate: Int = 3, recovery: Int = 2, route: Int = 3) -> Workout {
    let end = now.addingTimeInterval(-endedAgo), start = end.addingTimeInterval(-300)
    return Workout(id: id, activityType: 52, start: start, end: end, duration: 300, isIndoor: false, distanceM: 620.4, activeEnergyKcal: 32.44,
                   elevationUpM: 12.34, temperatureC: 18.46, humidityPct: 61, hrMin: 92, hrAvg: 108.4, hrMax: 121, steps: 313,
                   heartRate: (0..<heartRate).map { .init(time: start.addingTimeInterval(Double($0) * 5), bpm: 100, source: "Apple Watch") },
                   recovery: (0..<recovery).map { .init(time: end.addingTimeInterval(30 + Double($0) * 5), bpm: 95, source: "Apple Watch") },
                   route: (0..<route).map { routePoint(Double($0), north: Double($0)) })
}

/// The metadata of a synthetic iPhone photo near 42.51/1.52, as ImageIO gives it for a file.
func photoProperties(subSeconds: String? = "345", offset: String? = "+02:00", model: String? = "iPhone 17 Pro",
                     gps: [String: Any]? = ["Latitude": 42.51, "LatitudeRef": "N", "Longitude": 1.52, "LongitudeRef": "E", "Altitude": 1012.4,
                                            "AltitudeRef": 0, "HPositioningError": 4.7, "ImgDirection": 271.6],
                     orientation: Int? = nil) -> [String: Any] {
    var exif: [String: Any] = ["DateTimeOriginal": "2026:09:22 17:50:12"]
    exif["SubsecTimeOriginal"] = subSeconds
    exif["OffsetTimeOriginal"] = offset
    var properties: [String: Any] = ["{Exif}": exif]
    if let model { properties["{TIFF}"] = ["Make": "Synthetic Make", "Model": model] }
    properties["{GPS}"] = gps
    properties["Orientation"] = orientation
    return properties
}

struct NoImage: Error {}

/// Writes an image file whose left half is red and whose right half is blue, in `space`, with `properties`
/// as its metadata. `red`: the left half's colour components in `space`.
func imageFile(_ name: String = "IMG_0001.jpg", width: Int = 1600, height: Int = 1200, properties: [String: Any] = photoProperties(),
               space: CFString = CGColorSpace.sRGB, red: [CGFloat] = [1, 0, 0, 1], type: UTType = .jpeg) throws -> URL {
    guard let colorSpace = CGColorSpace(name: space),
          let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw NoImage() }
    context.setFillColor(CGColor(colorSpace: colorSpace, components: red)!)
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    context.setFillColor(CGColor(colorSpace: colorSpace, components: [0, 0, 1, 1])!)
    context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    let url = try scratch().appendingPathComponent(name)
    guard let image = context.makeImage(), let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else { throw NoImage() }
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw NoImage() }
    return url
}

/// A decoded image's size and its pixels as the file's own numbers, not converted to any colour space: what a
/// viewer shows once the server has stripped the colour profile. `at` counts from the top left.
struct Pixels {
    let width: Int, height: Int
    private let bytes: [UInt8]

    init(_ jpeg: Data) throws {
        guard let source = CGImageSourceCreateWithData(jpeg as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                      space: image.colorSpace ?? CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw NoImage() }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        (width, height) = (image.width, image.height)
        bytes = Array(UnsafeBufferPointer(start: context.data!.assumingMemoryBound(to: UInt8.self), count: image.width * image.height * 4))
    }

    var size: [Int] { [width, height] }
    func at(_ x: Int, _ y: Int) -> [Int] { (0..<3).map { Int(bytes[(y * width + x) * 4 + $0]) } }
    func isRed(_ x: Int, _ y: Int) -> Bool { at(x, y)[0] > 200 && at(x, y)[2] < 60 }
    func isBlue(_ x: Int, _ y: Int) -> Bool { at(x, y)[2] > 200 && at(x, y)[0] < 60 }
}

/// An image's metadata as ImageIO reads it.
func imageProperties(_ source: CGImageSource?) throws -> [String: Any] {
    guard let source, let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { throw NoImage() }
    return properties
}

/// A PNG of `side` × `side` random pixels. Seeded, so every run compresses the same bytes.
func noiseFile(side: Int = 1600) throws -> URL {
    var state: UInt64 = 0x9E37_79B9_7F4A_7C15
    var bytes = [UInt8](repeating: 255, count: side * side * 4)
    for i in bytes.indices where i % 4 != 3 {
        state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
        bytes[i] = UInt8(truncatingIfNeeded: state >> 33)
    }
    let url = try scratch().appendingPathComponent("noise.png")
    guard let provider = CGDataProvider(data: Data(bytes) as CFData),
          let image = CGImage(width: side, height: side, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: side * 4,
                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                              provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
          let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw NoImage() }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw NoImage() }
    return url
}

/// A photo as it waits in the queue; `thumbnail` stands in for a JPEG.
func photo(_ fileName: String = "IMG_0001.HEIC", lat: Double? = 42.51, lon: Double? = 1.52) -> Photo {
    Photo(fileName: fileName, cameraModel: "iPhone 17 Pro", takenAt: "2026-09-22T17:50:12.345+02:00", lat: lat, lon: lon, altitudeM: lat == nil ? nil : 1012.4,
          accuracyM: lat == nil ? nil : 4.7, directionDeg: 272, thumbnail: Data([0xff, 0xd8, 0xff, 0xd9]))
}
