import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// The thumbnail the server stores: at most 800 px on the long side, upright, sRGB, JPEG, and nothing of the
/// original's metadata. The server strips every metadata segment again; this strip is never trusted there.
public enum PhotoThumbnail {
    public struct NotAnImage: Error {}

    public static let longSide = 800
    public static let quality = 0.7

    public static func make(from source: CGImageSource) throws -> Data {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, // upright: the orientation is applied to the pixels
            kCGImageSourceThumbnailMaxPixelSize: longSide,
        ]
        guard let small = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let sRGB = CGColorSpace(name: CGColorSpace.sRGB),
              // Drawn anew: the pixels are converted to sRGB, and no metadata comes along.
              let context = CGContext(data: nil, width: small.width, height: small.height, bitsPerComponent: 8, bytesPerRow: 0, space: sRGB,
                                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw NotAnImage() }
        context.draw(small, in: CGRect(x: 0, y: 0, width: small.width, height: small.height))
        let data = NSMutableData()
        guard let image = context.makeImage(),
              let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { throw NotAnImage() }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw NotAnImage() }
        return data as Data
    }
}
