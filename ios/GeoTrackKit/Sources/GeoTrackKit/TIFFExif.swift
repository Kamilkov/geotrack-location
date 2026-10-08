import Foundation

/// The two values ImageIO does not hand out for a RAW file such as a ProRAW photo (DNG), though the camera
/// wrote them: tags that EXIF gained with version 2.31. Read straight from the TIFF-based file.
public struct TIFFExif: Equatable, Sendable {
    /// EXIF's OffsetTimeOriginal: the UTC offset of the time taken, such as "+02:00".
    public var offsetTimeOriginal: String?
    /// GPS's HPositioningError: the position's accuracy in metres.
    public var hPositioningError: Double?

    public init(offsetTimeOriginal: String? = nil, hPositioningError: Double? = nil) {
        self.offsetTimeOriginal = offsetTimeOriginal
        self.hPositioningError = hPositioningError
    }

    /// Both nil when the file is no TIFF or cannot be read; each nil when the file does not name it. Only the
    /// few bytes that lead to the values are read: a ProRAW file has tens of megabytes.
    public init(file url: URL) {
        guard let file = try? FileHandle(forReadingFrom: url) else { return }
        defer { try? file.close() }
        func bytes(_ offset: UInt64, _ count: Int) -> [UInt8]? {
            guard (try? file.seek(toOffset: offset)) != nil, let data = try? file.read(upToCount: count), data.count == count else { return nil }
            return [UInt8](data)
        }
        // "II": the lowest byte of a number comes first; "MM": the highest. Then 42, then where the first directory lies.
        guard let header = bytes(0, 8), header[0] == header[1], header[0] == 0x49 || header[0] == 0x4D else { return }
        let lowFirst = header[0] == 0x49
        func number(_ b: ArraySlice<UInt8>) -> UInt64 { (lowFirst ? b.reversed() : Array(b)).reduce(0) { $0 << 8 | UInt64($1) } }
        guard number(header[2..<4]) == 42 else { return }

        /// The entry of `tag` in the directory at `offset`: the type and number of its values, and its value field.
        func entry(_ tag: UInt64, in offset: UInt64) -> (type: UInt64, count: UInt64, value: ArraySlice<UInt8>)? {
            guard let count = bytes(offset, 2).map({ number($0[...]) }), let entries = bytes(offset + 2, Int(count) * 12) else { return nil }
            for start in stride(from: 0, to: entries.count, by: 12) where number(entries[start..<start + 2]) == tag {
                return (number(entries[start + 2..<start + 4]), number(entries[start + 4..<start + 8]), entries[start + 8..<start + 12])
            }
            return nil
        }
        let first = number(header[4..<8])
        // The first directory points to the Exif directory (0x8769); there OffsetTimeOriginal (0x9011) is a text
        // (type 2) such as "+02:00" with a closing NUL. A text of up to four bytes lies in the entry itself.
        if let exif = entry(0x8769, in: first), let offset = entry(0x9011, in: number(exif.value)), offset.type == 2, (1...16).contains(offset.count),
           let text = offset.count <= 4 ? Array(offset.value) : bytes(number(offset.value), Int(offset.count)) {
            offsetTimeOriginal = String(bytes: text.prefix(Int(offset.count)).prefix { $0 != 0 }, encoding: .ascii)
        }
        // It points to the GPS directory too (0x8825); there HPositioningError (0x001F) is one fraction (type 5):
        // two numbers of four bytes where the entry points, the first divided by the second.
        if let gps = entry(0x8825, in: first), let error = entry(0x001F, in: number(gps.value)), error.type == 5, error.count == 1,
           let fraction = bytes(number(error.value), 8), number(fraction[4..<8]) != 0 {
            hPositioningError = Double(number(fraction[0..<4])) / Double(number(fraction[4..<8]))
        }
    }
}
