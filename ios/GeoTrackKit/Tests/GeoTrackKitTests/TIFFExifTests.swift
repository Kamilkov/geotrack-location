import Foundation
import Testing
import UniformTypeIdentifiers
@testable import GeoTrackKit

@Suite struct TIFFExifTests {
    /// The smallest TIFF that names both values, written by hand: the header, a first directory that points to
    /// the Exif and the GPS directory, and in each one entry. `tag` of `type` holds the text `offset` and a
    /// NUL; `accuracyTag` of `accuracyType` holds `accuracy` as two numbers, the first divided by the second.
    func tiff(littleEndian: Bool, offset: String = "+02:00", tag: UInt16 = 0x9011, type: UInt16 = 2,
              accuracy: (UInt32, UInt32) = (47, 10), accuracyTag: UInt16 = 0x001f, accuracyType: UInt16 = 5) -> Data {
        func n16(_ v: UInt16) -> [UInt8] { littleEndian ? [UInt8(v & 0xff), UInt8(v >> 8)] : [UInt8(v >> 8), UInt8(v & 0xff)] }
        func n32(_ v: UInt32) -> [UInt8] { let b = [UInt8(v >> 24), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)]; return littleEndian ? b.reversed() : b }
        let text = Array(offset.utf8) + [0]
        // A text of up to four bytes lies in the entry itself; a longer one where the entry points.
        let value = text.count <= 4 ? text + [UInt8](repeating: 0, count: 4 - text.count) : n32(82)
        var bytes = Array((littleEndian ? "II" : "MM").utf8) + n16(42) + n32(8)
        bytes += n16(2) + n16(0x8769) + n16(4) + n32(1) + n32(38) + n16(0x8825) + n16(4) + n32(1) + n32(56) + n32(0) // the first directory, at 8
        bytes += n16(1) + n16(tag) + n16(type) + n32(UInt32(text.count)) + value + n32(0) // the Exif directory, at 38
        bytes += n16(1) + n16(accuracyTag) + n16(accuracyType) + n32(1) + n32(74) + n32(0) // the GPS directory, at 56
        bytes += n32(accuracy.0) + n32(accuracy.1) // the two numbers, at 74
        return Data(bytes + (text.count <= 4 ? [] : text)) // the text, at 82
    }

    func read(_ data: Data) throws -> TIFFExif {
        let url = try scratch().appendingPathComponent("IMG_0001.DNG")
        try data.write(to: url)
        return TIFFExif(file: url)
    }

    @Test(arguments: [true, false])
    func readsBothValuesInEitherByteOrder(littleEndian: Bool) throws {
        #expect(try read(tiff(littleEndian: littleEndian)) == TIFFExif(offsetTimeOriginal: "+02:00", hPositioningError: 4.7))
        #expect(try read(tiff(littleEndian: littleEndian, offset: "-03:30", accuracy: (1_000_000, 3))).offsetTimeOriginal == "-03:30")
        #expect(try abs(#require(read(tiff(littleEndian: littleEndian, accuracy: (1_000_000, 3))).hPositioningError) - 333_333.333) < 0.001)
        #expect(try read(tiff(littleEndian: littleEndian, offset: "Z")).offsetTimeOriginal == "Z") // short enough to lie in the entry
    }

    /// Not only the files of this test: a TIFF that ImageIO wrote, as the camera writes a ProRAW file's.
    @Test func readsBothValuesOfATIFFThatImageIOWrote() throws {
        let own = TIFFExif(file: try imageFile("IMG_0001.tiff", width: 64, height: 48, type: .tiff))
        #expect(own.offsetTimeOriginal == "+02:00")
        #expect(try abs(#require(own.hPositioningError) - 4.7) < 0.001)
        let west = try imageFile("IMG_0002.tiff", width: 64, height: 48, properties: photoProperties(offset: "-03:30"), type: .tiff)
        #expect(TIFFExif(file: west).offsetTimeOriginal == "-03:30")
    }

    @Test func aFileWithoutAValueGivesNoneForItAndStillTheOther() throws {
        let noOffset = TIFFExif(file: try imageFile("IMG_0001.tiff", width: 64, height: 48, properties: photoProperties(offset: nil), type: .tiff))
        #expect(noOffset.offsetTimeOriginal == nil)
        #expect(noOffset.hPositioningError != nil)
        let noPlace = TIFFExif(file: try imageFile("IMG_0002.tiff", width: 64, height: 48, properties: photoProperties(gps: nil), type: .tiff))
        #expect(noPlace == TIFFExif(offsetTimeOriginal: "+02:00"))
        #expect(try read(tiff(littleEndian: false, tag: 0x9010)) == TIFFExif(hPositioningError: 4.7)) // the time of the last change is another tag
        #expect(try read(tiff(littleEndian: false, type: 3)).offsetTimeOriginal == nil) // not a text
        #expect(try read(tiff(littleEndian: false, offset: "+02:00 and far more")).offsetTimeOriginal == nil) // no offset is that long
        #expect(try read(tiff(littleEndian: false, accuracyTag: 0x001e)) == TIFFExif(offsetTimeOriginal: "+02:00")) // another GPS tag
        #expect(try read(tiff(littleEndian: false, accuracyType: 4)).hPositioningError == nil) // not two numbers
        #expect(try read(tiff(littleEndian: false, accuracy: (47, 0))).hPositioningError == nil) // divided by nothing
    }

    @Test func aFileThatIsNoTIFFGivesNeither() throws {
        #expect(TIFFExif(file: try imageFile(width: 64, height: 48)) == TIFFExif()) // a JPEG
        #expect(TIFFExif(file: try scratch().appendingPathComponent("missing.dng")) == TIFFExif())
        #expect(try read(Data()) == TIFFExif())
        var other = [UInt8](tiff(littleEndian: false))
        other[3] = 43 // not a TIFF's number: a file of another kind that begins alike
        #expect(try read(Data(other)) == TIFFExif())
    }

    /// A file that ends too early, at every length: none of them may end the app, and none gives a value that
    /// is not wholly there.
    @Test func aFileThatIsCutOffGivesOnlyWhatIsWhollyThere() throws {
        let whole = tiff(littleEndian: false)
        for length in 0..<whole.count {
            let cut = try read(whole.prefix(length))
            #expect(cut.offsetTimeOriginal == nil) // the text is the file's last bytes
            #expect(cut.hPositioningError == (length >= 82 ? 4.7 : nil))
        }
        var astray = [UInt8](whole)
        astray.replaceSubrange(4..<8, with: [0xff, 0xff, 0xff, 0xf0]) // the first directory far beyond the file's end
        #expect(try read(Data(astray)) == TIFFExif())
    }
}
