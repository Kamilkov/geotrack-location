import Foundation
import GeoTrackKit
import Security

/// The package's settings. Named here because SwiftUI has a `Settings` of its own, which would win in a file
/// that does not import the package.
typealias Settings = GeoTrackKit.Settings

enum Keychain {
    /// The item exists but cannot be read now (before the phone's first unlock), or the Keychain refused.
    struct Unreadable: Error {
        let status: OSStatus
    }

    private static var query: [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: "app.machros.geotrack", kSecAttrAccount: "settings"]
    }

    /// The saved settings, or the defaults when nothing was saved yet or the saved item is damaged (`damaged` says
    /// which). Throws when the Keychain cannot be read now, so that "not readable yet" is never taken for "not set up".
    static func load() throws -> Settings.Read {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query.merging([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]) { $1 } as CFDictionary, &item)
        if status == errSecItemNotFound { return Settings.read(nil) }
        guard status == errSecSuccess, let data = item as? Data else { throw Unreadable(status: status) }
        return Settings.read(data)
    }

    /// Readable after the first unlock and on this device only: with the Keychain's default the app
    /// could not upload while the phone is locked. The item is updated in place, so a save that fails
    /// leaves the settings that were there.
    static func save(_ settings: Settings) -> Bool {
        guard let data = try? JSONEncoder().encode(settings) else { return false }
        let values: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound { return SecItemAdd(query.merging(values) { $1 } as CFDictionary, nil) == errSecSuccess }
        return status == errSecSuccess
    }
}
