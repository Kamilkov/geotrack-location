import Foundation
import ImageIO

/// One photo as `POST /photos` takes it. Encoded, it is the request's body and the queue's file:
/// a value that is not there is left out, and the thumbnail goes as base64.
public struct Photo: Codable, Equatable, Sendable {
    public var fileName: String
    public var cameraModel: String
    /// The time taken with its UTC offset, "2026-09-22T17:50:12.345+02:00". With the camera model it makes
    /// the photo's ID on the server.
    public var takenAt: String
    public var lat: Double?
    public var lon: Double?
    public var altitudeM: Double?
    public var accuracyM: Double?
    public var directionDeg: Int?
    /// An 800 px JPEG without metadata.
    public var thumbnail: Data

    public init(fileName: String, cameraModel: String, takenAt: String, lat: Double? = nil, lon: Double? = nil, altitudeM: Double? = nil,
                accuracyM: Double? = nil, directionDeg: Int? = nil, thumbnail: Data) {
        self.fileName = fileName
        self.cameraModel = cameraModel
        self.takenAt = takenAt
        self.lat = lat
        self.lon = lon
        self.altitudeM = altitudeM
        self.accuracyM = accuracyM
        self.directionDeg = directionDeg
        self.thumbnail = thumbnail
    }

    public var hasLocation: Bool { lat != nil }
}

/// Maps an image's metadata, as ImageIO gives it, to the fields of `Photo`. The same rules as `fromExif`
/// in srv/lib/photo-meta.js, which reads the Mac's exiftool record: both must name the same photo alike.
public enum PhotoMeta {
    public enum Refusal: Error, Equatable, Sendable {
        case noTime, noCameraModel

        public var reason: String {
            switch self {
            case .noTime: "no time with UTC offset"
            case .noCameraModel: "no camera model"
            }
        }
    }

    /// `properties`: the dictionary of `CGImageSourceCopyPropertiesAtIndex`.
    public static func photo(fileName: String, properties: [String: Any], thumbnail: Data) throws(Refusal) -> Photo {
        let exif = properties[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        let tiff = properties[kCGImagePropertyTIFFDictionary as String] as? [String: Any] ?? [:]
        let gps = properties[kCGImagePropertyGPSDictionary as String] as? [String: Any] ?? [:]

        guard let takenAt = time(exif, gps: gps) else { throw .noTime }
        let model = String((tiff[kCGImagePropertyTIFFModel as String] as? String ?? "").prefix(60)).trimmingCharacters(in: .whitespaces)
        guard !model.isEmpty else { throw .noCameraModel }

        var photo = Photo(fileName: fileName, cameraModel: model, takenAt: takenAt, thumbnail: thumbnail)
        if let lat = number(gps[kCGImagePropertyGPSLatitude as String]), let lon = number(gps[kCGImagePropertyGPSLongitude as String]) {
            photo.lat = gps[kCGImagePropertyGPSLatitudeRef as String] as? String == "S" ? -lat : lat
            photo.lon = gps[kCGImagePropertyGPSLongitudeRef as String] as? String == "W" ? -lon : lon
            if let altitude = number(gps[kCGImagePropertyGPSAltitude as String]) {
                // Reference 1: below sea level.
                photo.altitudeM = number(gps[kCGImagePropertyGPSAltitudeRef as String]) == 1 ? -altitude : altitude
            }
            photo.accuracyM = number(gps[kCGImagePropertyGPSHPositioningError as String])
        }
        if let direction = number(gps[kCGImagePropertyGPSImgDirection as String]) {
            // The remainder first: any finite number then fits an Int.
            photo.directionDeg = ((Int(direction.truncatingRemainder(dividingBy: 360).rounded()) % 360) + 360) % 360
        }
        return photo
    }

    /// "2026:09:22 17:50:12", "345" and "+02:00" → "2026-09-22T17:50:12.345+02:00". nil without an offset:
    /// such a photo cannot be placed on the timeline. The offset is the one the file names, else the one its
    /// own GPS time gives.
    private static func time(_ exif: [String: Any], gps: [String: Any]) -> String? {
        guard let original = (exif[kCGImagePropertyExifDateTimeOriginal as String] as? String)?.trimmingCharacters(in: .whitespaces),
              let t = original.wholeMatch(of: /(\d{4}):(\d\d):(\d\d) (\d\d:\d\d:\d\d)/) else { return nil }
        let named = (exif[kCGImagePropertyExifOffsetTimeOriginal as String] as? String)?.trimmingCharacters(in: .whitespaces)
        guard let offset = named.flatMap({ $0.wholeMatch(of: /Z|[+-]\d\d:\d\d/) != nil ? $0 : nil }) ?? offset(of: original, gps: gps) else { return nil }
        let subSeconds = (exif[kCGImagePropertyExifSubsecTimeOriginal as String]).map { "\($0)".trimmingCharacters(in: .whitespaces) } ?? ""
        let fraction = subSeconds.wholeMatch(of: /\d+/) != nil ? ".\(subSeconds)" : ""
        return "\(t.1)-\(t.2)-\(t.3)T\(t.4)\(fraction)\(offset)"
    }

    /// The UTC offset a photo's own GPS time gives, for a file that names none (a ProRAW photo edited in
    /// Photos is rendered without it). The GPS time is UTC, so the time taken minus it is the offset plus the
    /// age of the fix. Taken only when the two fit a quarter hour within a minute: an older fix would give a
    /// wrong time, and no offset is better than a wrong one.
    private static func offset(of taken: String, gps: [String: Any]) -> String? {
        guard let date = (gps[kCGImagePropertyGPSDateStamp as String] as? String)?.trimmingCharacters(in: .whitespaces),
              let time = (gps[kCGImagePropertyGPSTimeStamp as String] as? String)?.trimmingCharacters(in: .whitespaces),
              let local = seconds(taken), let utc = seconds("\(date) \(time)") else { return nil }
        let quarters = ((local - utc) / 900).rounded()
        // -12:00 to +14:00: the widest offsets there are.
        guard abs(local - utc - quarters * 900) <= 60, (-48...56).contains(quarters) else { return nil }
        let minutes = abs(Int(quarters)) * 15
        return (quarters < 0 ? "-" : "+") + String(format: "%02d:%02d", minutes / 60, minutes % 60)
    }

    /// "2026:09:22 17:50:12" read as UTC, in seconds since 1970; a fraction of a second after it is left out.
    /// nil for a text that is no date and time.
    private static func seconds(_ text: String) -> Double? {
        guard let m = text.wholeMatch(of: /(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)(\.\d+)?/) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        let parts = DateComponents(calendar: calendar, timeZone: .gmt, year: Int(m.1), month: Int(m.2), day: Int(m.3), hour: Int(m.4), minute: Int(m.5), second: Int(m.6))
        return parts.isValidDate ? parts.date?.timeIntervalSince1970 : nil
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber else { return nil }
        return number.doubleValue.isFinite ? number.doubleValue : nil
    }
}
