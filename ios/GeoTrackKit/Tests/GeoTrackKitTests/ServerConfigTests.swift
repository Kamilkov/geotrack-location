import Foundation
import Testing
@testable import GeoTrackKit

@Suite struct ServerConfigTests {
    @Test func takesHttpsAndLocalHttpOnly() {
        #expect(ServerConfig(server: "https://example.invalid", token: "t", device: "trial-iphone")?.baseURL.host == "example.invalid")
        #expect(ServerConfig(server: " http://localhost:4004 ", token: "t", device: "trial-iphone") != nil)
        #expect(ServerConfig(server: "http://example.invalid", token: "t", device: "trial-iphone") == nil)
        #expect(ServerConfig(server: "example.invalid", token: "t", device: "trial-iphone") == nil)
        #expect(ServerConfig(server: "", token: "t", device: "trial-iphone") == nil)
        #expect(ServerConfig(server: "https://", token: "t", device: "trial-iphone") == nil) // a scheme alone names no server
        #expect(ServerConfig(server: "http://127.0.0.1:4010", token: "t", device: "trial-iphone") != nil)
        // Plain HTTP only for the Mac itself: a host that merely begins like it is another host.
        for lookalike in ["http://localhost.example.invalid", "http://127.0.0.1.example.invalid", "http://localhost@example.invalid"] {
            #expect(ServerConfig(server: lookalike, token: "t", device: "trial-iphone") == nil)
        }
    }

    /// iOS's keyboard likes to begin with a capital, and a pasted address can end in a line break.
    @Test func takesSchemeAndHostInAnyCaseAndWritesThemLowerCase() {
        #expect(ServerConfig(server: "Https://Example.Invalid", token: "t", device: "trial-iphone")?.baseURL.absoluteString == "https://example.invalid")
        #expect(ServerConfig(server: "HTTP://LocalHost:4010", token: "t", device: "trial-iphone")?.baseURL.absoluteString == "http://localhost:4010")
        #expect(ServerConfig(server: "https://example.invalid\n", token: "t", device: "trial-iphone")?.baseURL.absoluteString == "https://example.invalid")
        #expect(ServerConfig(server: "HTTP://Example.Invalid", token: "t", device: "trial-iphone") == nil) // still no plain HTTP for another host
        #expect(ServerConfig.address("Https://Example.Invalid/Trips/")?.absoluteString == "https://example.invalid/Trips/") // the path as it was typed
        #expect(ServerConfig(server: "https://example.invalid", token: "t", device: "trial-iphone")
            == ServerConfig(server: " HTTPS://EXAMPLE.invalid ", token: "t", device: "trial-iphone")) // one server, one set of settings
    }

    @Test func needsATokenAndADeviceNameTheServerAccepts() {
        #expect(ServerConfig(server: "https://example.invalid", token: "", device: "trial-iphone") == nil)
        for device in ["", "Trial_iPhone", "trial iphone", String(repeating: "a", count: 41)] {
            #expect(ServerConfig(server: "https://example.invalid", token: "t", device: device) == nil)
        }
        #expect(ServerConfig(server: "https://example.invalid", token: "t", device: String(repeating: "a", count: 40)) != nil)
    }

    /// What Setup shows must be where the token goes: a user part makes the host another one, and a query or a
    /// fragment would ride on every request.
    @Test(arguments: ["https://example.invalid@attacker.example", "https://example.invalid\\@attacker.example", "https://user:pw@example.invalid",
                      "https://example.invalid/?a=b", "https://example.invalid/#x", "https://example.invalid?"])
    func refusesAnAddressWithAUserPartAQueryOrAFragment(address: String) {
        #expect(ServerConfig(server: address, token: "t", device: "trial-iphone") == nil)
    }
}
