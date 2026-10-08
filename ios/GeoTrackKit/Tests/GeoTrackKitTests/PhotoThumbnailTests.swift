import CoreGraphics
import Foundation
import ImageIO
import Testing
@testable import GeoTrackKit

@Suite struct PhotoThumbnailTests {
    func thumbnail(_ file: URL) throws -> Data {
        try PhotoThumbnail.make(from: #require(CGImageSourceCreateWithURL(file as CFURL, nil)))
    }

    @Test func theLongSideIs800ForLandscapeAndForPortrait() throws {
        let landscape = try Pixels(thumbnail(imageFile()))
        #expect(landscape.size == [800, 600])
        let portrait = try Pixels(thumbnail(imageFile(width: 1200, height: 1600)))
        #expect(portrait.size == [600, 800])
    }

    @Test func aSmallImageIsNotEnlarged() throws {
        let small = try Pixels(thumbnail(imageFile(width: 400, height: 300)))
        #expect(small.size == [400, 300])
    }

    /// The stored pixels have red on the left. What the photo shows upright depends on its orientation.
    @Test func itIsUprightForEachOrientation() throws {
        let plain = try Pixels(thumbnail(imageFile(properties: photoProperties(orientation: 1))))
        #expect(plain.isRed(100, 300) && plain.isBlue(700, 300))
        let upsideDown = try Pixels(thumbnail(imageFile(properties: photoProperties(orientation: 3))))
        #expect(upsideDown.isBlue(100, 300) && upsideDown.isRed(700, 300))
        let onItsSide = try Pixels(thumbnail(imageFile(properties: photoProperties(orientation: 6)))) // the usual portrait photo
        try #require(onItsSide.size == [600, 800])
        #expect(onItsSide.isRed(300, 100) && onItsSide.isBlue(300, 700))
        let onItsOtherSide = try Pixels(thumbnail(imageFile(properties: photoProperties(orientation: 8))))
        try #require(onItsOtherSide.size == [600, 800])
        #expect(onItsOtherSide.isBlue(300, 100) && onItsOtherSide.isRed(300, 700))
    }

    @Test func nothingOfTheOriginalsMetadataIsLeft() throws {
        let file = try imageFile(properties: photoProperties(orientation: 6))
        // The original does carry them: otherwise this test would prove nothing.
        let original = try imageProperties(CGImageSourceCreateWithURL(file as CFURL, nil))
        #expect(original["{GPS}"] != nil && (original["{TIFF}"] as? [String: Any])?["Model"] != nil)
        #expect((original["{TIFF}"] as? [String: Any])?["Make"] != nil)

        let data = try thumbnail(file)
        let properties = try imageProperties(CGImageSourceCreateWithData(data as CFData, nil))
        #expect(properties["{GPS}"] == nil)
        #expect(properties["{TIFF}"] == nil || (properties["{TIFF}"] as? [String: Any])?["Model"] == nil)
        #expect((properties["{TIFF}"] as? [String: Any])?["Make"] == nil)
        #expect((properties["{Exif}"] as? [String: Any])?["DateTimeOriginal"] == nil)
        #expect((properties["Orientation"] as? Int ?? 1) == 1)
        for needle in ["iPhone 17 Pro", "Synthetic Make", "2026:09:22"] { #expect(data.range(of: Data(needle.utf8)) == nil) }
    }

    @Test func aWideGamutImageComesOutAsSRGB() throws {
        // A colour inside sRGB, written in Display P3: its numbers differ between the two spaces.
        let p3: [CGFloat] = [0.6, 0.3, 0.3, 1]
        let expected = try #require(CGColor(colorSpace: CGColorSpace(name: CGColorSpace.displayP3)!, components: p3)?
            .converted(to: CGColorSpace(name: CGColorSpace.sRGB)!, intent: .defaultIntent, options: nil)?.components).prefix(3).map { Int(($0 * 255).rounded()) }
        #expect(abs(expected[0] - 153) > 4) // 0.6 × 255: unconverted numbers would be told apart

        let pixels = try Pixels(thumbnail(imageFile(space: CGColorSpace.displayP3, red: p3)))
        for (got, want) in zip(pixels.at(100, 300), expected) { #expect(abs(got - want) <= 4) }
    }

    /// Noise is the hardest picture for JPEG: if it fits the server's 500 KB, every photo does.
    @Test func theHardestPictureStillFitsTheServersLimitAndIsAJPEG() throws {
        let data = try thumbnail(noiseFile())
        #expect(data.count < 500 * 1024)
        #expect(data.count > 200 * 1024) // the input really is hard: a flat picture would prove nothing
        #expect(data.prefix(2) == Data([0xff, 0xd8]))
    }

    @Test func aFileThatIsNoImageIsRefused() throws {
        let file = try scratch().appendingPathComponent("notes.jpg")
        try Data("not an image".utf8).write(to: file)
        let source = try #require(CGImageSourceCreateWithURL(file as CFURL, nil))
        #expect(throws: PhotoThumbnail.NotAnImage.self) { try PhotoThumbnail.make(from: source) }
    }
}
