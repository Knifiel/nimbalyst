import XCTest
@testable import NimbalystNative

/// A session-room socket outlives the five-minute JWT. Every connect attempt,
/// including the client's own backed-off retries, must use a token read at that
/// moment; reusing the one from the first connect is a 401 the phone reports as
/// "bad response from the server" forever.
@MainActor
final class WebSocketClientTokenTests: XCTestCase {
    func testEveryConnectAttemptReadsAFreshToken() async throws {
        let client = WebSocketClient(readinessTimeout: 0.2)
        var issued: [String] = []
        client.freshToken = {
            issued.append("token-\(issued.count + 1)")
            return issued.last
        }
        defer { client.disconnect() }
        // Nothing listens on port 9, so each attempt fails at once and the
        // client schedules its own retry.
        client.connect(serverUrl: "http://127.0.0.1:9", roomId: "session", authToken: "expired-at-join")
        let deadline = Date().addingTimeInterval(6)
        while issued.count < 2 && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertGreaterThanOrEqual(issued.count, 2, "The retry must ask for a token instead of reusing the first one")
        XCTAssertEqual(client.currentAuthToken, issued.last)
    }
}
