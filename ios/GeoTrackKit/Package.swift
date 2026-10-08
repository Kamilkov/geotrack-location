// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GeoTrackKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "GeoTrackKit", targets: ["GeoTrackKit"])],
    targets: [
        .target(name: "GeoTrackKit"),
        .testTarget(name: "GeoTrackKitTests", dependencies: ["GeoTrackKit"]),
    ]
)
