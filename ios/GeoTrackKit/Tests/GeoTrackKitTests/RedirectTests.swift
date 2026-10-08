import Foundation
import Testing
@testable import GeoTrackKit

/// Answers a request to example.invalid with a 307 to a plain-HTTP LAN address, and that address with a 200.
final class Redirecting: URLProtocol, @unchecked Sendable {
    static let target = URL(string: "http://192.168.1.2/positions")!

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}

    override func startLoading() {
        guard let url = request.url, let client else { return }
        if url.host == "example.invalid" {
            let response = HTTPURLResponse(url: url, statusCode: 307, httpVersion: "HTTP/1.1", headerFields: ["Location": Redirecting.target.absoluteString])!
            client.urlProtocol(self, wasRedirectedTo: URLRequest(url: Redirecting.target), redirectResponse: response)
            client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client.urlProtocolDidFinishLoading(self)
        } else {
            client.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!,
                               cacheStoragePolicy: .notAllowed)
            client.urlProtocol(self, didLoad: Data("followed".utf8))
            client.urlProtocolDidFinishLoading(self)
        }
    }
}

@Suite struct RedirectTests {
    func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [Redirecting.self]
        return configuration
    }

    var request: URLRequest {
        var request = URLRequest(url: URL(string: "https://example.invalid/positions")!)
        request.httpMethod = "POST"
        request.httpBody = Data("batch".utf8)
        return request
    }

    /// The stand-in really redirects: without this, the test below would pass for a session that follows.
    @Test func aPlainSessionFollowsTheStandInsRedirect() async throws {
        let (_, response) = try await URLSession(configuration: configuration()).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(response.url == Redirecting.target)
    }

    /// Breaks if the uploads' session follows a redirect: the batch and the token would go where Setup does not say.
    @Test func theUploadsSessionNeverFollowsARedirect() async throws {
        let (_, response) = try await Uploader.session(configuration()).data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 307)
        #expect(response.url?.host == "example.invalid")
    }
}
