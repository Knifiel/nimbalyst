import XCTest
import CryptoKit
@testable import NimbalystNative

final class SessionPayloadTests: XCTestCase {
    private struct Fixture: Decodable {
        let key: String
        let content: String
        let entry: ServerMessageEntry
        let parts: [SessionPayloadPart]
    }
    func testEncryptedFixtureSurvivesRestartReorderAndRejectsMissingOrCorruptParts() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: root.appendingPathComponent("collab-protocol/fixtures/payload/encrypted-form.json")))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(data: Data(base64Encoded: fixture.key)!)
        let decrypt: (String, String) throws -> String = { encrypted, iv in
            let box = try AES.GCM.SealedBox(combined: Data(base64Encoded: iv)! + Data(base64Encoded: encrypted)!)
            return String(data: try AES.GCM.open(box, using: key), encoding: .utf8)!
        }
        let first = SessionPayloadStore(directory: directory)
        try first.accept(fixture.parts[1], sessionId: "s")
        XCTAssertThrowsError(try first.decrypt(fixture.entry, sessionId: "s", decrypt: decrypt))
        let resumed = SessionPayloadStore(directory: directory)
        try resumed.accept(fixture.parts[1], sessionId: "s") // idempotent retry
        try resumed.accept(fixture.parts[0], sessionId: "s")
        XCTAssertEqual(try resumed.decrypt(fixture.entry, sessionId: "s", decrypt: decrypt), fixture.content)
        XCTAssertThrowsError(try resumed.decrypt(fixture.entry, sessionId: "other", decrypt: decrypt))
        let original = fixture.parts[0]
        let corrupt = SessionPayloadPart(transferId: original.transferId, count: original.count, messageId: original.messageId, index: original.index, encryptedContent: "AAAA" + original.encryptedContent.dropFirst(4), iv: original.iv)
        XCTAssertThrowsError(try resumed.accept(corrupt, sessionId: "s"))
        let corruptDirectory = directory.appendingPathComponent("corrupt")
        let corrupted = SessionPayloadStore(directory: corruptDirectory)
        try corrupted.accept(corrupt, sessionId: "s")
        try corrupted.accept(fixture.parts[1], sessionId: "s")
        XCTAssertThrowsError(try corrupted.decrypt(fixture.entry, sessionId: "s", decrypt: decrypt))
    }

    @MainActor
    func testRepairBelowSequenceWatermarkCommitsRevisionAndIgnoresDelayedReplay() throws {
        let crypto = CryptoManager(seed: "dGVzdC1lbmNyeXB0aW9uLWtleS1zZWVkLWZvci10ZXN0cw==", userId: "github-1711")
        let database = try DatabaseManager()
        try database.upsertProject(Project(id: "p", name: "p"))
        try database.upsertSession(Session(id: "s", projectId: "p", createdAt: 1, updatedAt: 1))
        let old = Message(id: "m", sessionId: "s", sequence: 1, source: "assistant", direction: "output", encryptedContent: "old", iv: "iv", contentDecrypted: "elided", createdAt: 1)
        try database.appendMessage(old)
        try database.updateSyncState(SyncState(roomId: "s", lastCursor: "r:30", lastSequence: 30, lastSyncedAt: 1))
        let sync = SyncManager(crypto: crypto, database: database, serverUrl: "https://invalid.example", userId: "github-1711", registerDeviceCallbacks: false)
        func receive(_ text: String, revision: Int) throws {
            let encrypted = try crypto.encrypt(plaintext: text)
            let row: [String: Any] = ["id": "m", "sequence": 1, "createdAt": 1, "source": "assistant", "direction": "output", "encryptedContent": encrypted.encrypted, "iv": encrypted.iv, "projectionVersion": 1, "revision": revision]
            sync.handleSessionMessage(try JSONSerialization.data(withJSONObject: ["type": "syncResponse", "messages": [row], "hasMore": false, "revisionCursor": revision]), sessionId: "s")
        }
        try receive("full question", revision: 31)
        try receive("delayed old projection", revision: 30)
        XCTAssertEqual(try database.messages(forSession: "s").first?.contentDecrypted, "full question")
        XCTAssertEqual(try database.syncState(forRoom: "s")?.lastSequence, 30)
        XCTAssertEqual(try database.syncState(forRoom: "s")?.lastCursor, "r:31")
    }

    func testSameIdentityRepairsReplaceAndStaleReplayCannotDowngrade() throws {
        let database = try DatabaseManager() // isolated in-memory database
        try database.upsertProject(Project(id: "p", name: "p"))
        try database.upsertSession(Session(id: "s", projectId: "p", createdAt: 1, updatedAt: 1))
        let old = Message(id: "m", sessionId: "s", sequence: 1, source: "assistant", direction: "output", encryptedContent: "old", iv: "iv", contentDecrypted: "elided", createdAt: 1)
        try database.appendMessage(old)
        var repaired = old
        repaired.contentDecrypted = "complete question with original schema"
        repaired.projectionJson = SyncProjectionStamp(version: 1, revision: 10).json
        try database.appendMessage(repaired)
        try database.appendMessages([old, repaired])
        XCTAssertEqual(try database.messages(forSession: "s"), [repaired])
        var invalid = repaired
        invalid.sequence = 2
        invalid.projectionJson = SyncProjectionStamp(version: 1, revision: 11).json
        // A moved identity is skipped, and must not roll back the rest of the batch.
        let next = Message(id: "n", sessionId: "s", sequence: 3, source: "assistant", direction: "output", encryptedContent: "c", iv: "iv", contentDecrypted: "next", createdAt: 2)
        try database.appendMessages([invalid, next])
        XCTAssertEqual(try database.messages(forSession: "s"), [repaired, next])
    }
}
