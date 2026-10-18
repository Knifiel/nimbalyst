import XCTest
@testable import NimbalystNative

final class SyncDiagnosticsFileTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sync-diagnostics-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func read(_ url: URL?) throws -> String {
        try String(contentsOf: XCTUnwrap(url), encoding: .utf8)
    }

    func testRotatesAtTheLimitAndKeepsOnePreviousFile() throws {
        let file = SyncDiagnosticsFile(directory: directory, maxBytes: 400, header: "# header app=1.0 build=7")
        for i in 0..<30 {
            file.log("sessionSyncPage", ["rows": .int(i), "hasMore": .bool(true)])
        }
        file.flush()

        let current = try read(file.currentFileURL)
        let previous = try read(file.previousFileURL)
        XCTAssertLessThanOrEqual(current.utf8.count, 400)
        XCTAssertLessThanOrEqual(previous.utf8.count, 400)
        XCTAssertTrue(current.hasPrefix("# header app=1.0 build=7\n"), "Every file starts with the version header")
        XCTAssertTrue(previous.hasPrefix("# header app=1.0 build=7\n"))
        XCTAssertTrue(current.contains("rows=29 "), "The newest line is in the current file")
        XCTAssertFalse(current.contains("rows=0 "), "The oldest lines rotated out")
        let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
        XCTAssertEqual(Set(files), ["sync.log", "sync.1.log"], "Only one previous file is kept")
    }

    func testContentNeverReachesTheFile() throws {
        let file = SyncDiagnosticsFile(directory: directory, header: "# header")
        let prompt = "Please refactor the billing module"
        let sessionId = UUID().uuidString
        file.log(prompt, [
            "sessionId": .id(sessionId),
            "reason": .text(prompt),
            "code": .label("Fix login bug"),
        ])
        file.flush()

        let written = try read(file.currentFileURL)
        XCTAssertFalse(written.contains("refactor"))
        XCTAssertFalse(written.contains("login"))
        XCTAssertTrue(written.contains("sessionId=\(sessionId)"), "Session ids are kept")
        XCTAssertTrue(written.contains("reason=<present len=\(prompt.count)>"), "Free text is presence and length only")
    }

    /// Token-shaped values were the gap in a shape-based filter: a single short
    /// token is exactly what a key or bearer token looks like.
    func testSecretShapedValuesNeverReachTheFile() throws {
        let file = SyncDiagnosticsFile(directory: directory, header: "# header")
        let bearer = "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"
        let rawJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl"
        let apiKey = "sk-ant-api03-AbCdEf0123456789_xyz"
        for secret in [bearer, rawJwt, apiKey] {
            file.log("socketClose", ["reason": .text(secret), "code": .label(secret), "sessionId": .id(secret)])
            file.log(secret)
        }
        file.flush()

        let written = try read(file.currentFileURL)
        XCTAssertFalse(written.contains("eyJ"), "No JWT segment is written")
        XCTAssertFalse(written.contains("sk-ant"), "No API key is written")
        XCTAssertFalse(written.contains("Bearer"))
    }

    func testRoomFieldsNeverCarryOrgOrUserIds() {
        let session = SyncDiagnosticsFile.roomFields("org:org-1:user:user-9:session:sess-42")
        XCTAssertEqual(session.kind, "session")
        XCTAssertEqual(session.sessionId, "sess-42")
        let index = SyncDiagnosticsFile.roomFields("org:org-1:user:user-9:index")
        XCTAssertEqual(index.kind, "index")
        XCTAssertNil(index.sessionId)
    }
}
