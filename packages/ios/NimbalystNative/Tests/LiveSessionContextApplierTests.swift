import XCTest
@testable import NimbalystNative

/// The desktop relays mid-turn context usage as `sessionContextBroadcast`
/// frames the server never stores. Late or duplicate frames must not regress
/// the stored value, and a frame for an unknown session must not create a row.
@MainActor
final class LiveSessionContextApplierTests: XCTestCase {
    private let crypto = CryptoManager(seed: "live-context-seed", userId: "user-1")

    private func makeDatabase() throws -> DatabaseManager {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: "proj", name: "p"))
        try db.upsertSession(Session(id: "s1", projectId: "proj", contextTokens: 10, contextWindow: 200_000))
        return db
    }

    private func frame(sessionId: String = "s1", tokens: Int, window: Int = 200_000, at: Int) throws -> Data {
        let plaintext = #"{"currentContext":{"tokens":\#(tokens),"contextWindow":\#(window)}}"#
        let encrypted = try crypto.encrypt(plaintext: plaintext)
        let broadcast = SessionContextBroadcast(
            type: "sessionContextBroadcast",
            update: LiveSessionContext(sessionId: sessionId, encryptedContext: encrypted.encrypted,
                                       contextIv: encrypted.iv, at: at),
            fromConnectionId: "desktop"
        )
        return try JSONEncoder().encode(broadcast)
    }

    private func context(_ db: DatabaseManager, _ id: String = "s1") throws -> (Int?, Int?) {
        let session = try db.session(byId: id)
        return (session?.contextTokens, session?.contextWindow)
    }

    func testAppliesNewerFramesAndIgnoresLateOrDuplicateOnes() throws {
        let db = try makeDatabase()
        let applier = LiveSessionContextApplier(crypto: crypto, database: db)

        XCTAssertEqual(applier.apply(try frame(tokens: 5_000, at: 2_000)), .applied)
        XCTAssertEqual(try context(db).0, 5_000)

        // A frame that arrives late (older `at`) or twice must not regress the value.
        XCTAssertEqual(applier.apply(try frame(tokens: 1_000, at: 1_000)), .stale)
        XCTAssertEqual(applier.apply(try frame(tokens: 1_000, at: 2_000)), .stale)
        XCTAssertEqual(try context(db).0, 5_000)

        XCTAssertEqual(applier.apply(try frame(tokens: 9_000, window: 1_000_000, at: 3_000)), .applied)
        let (tokens, window) = try context(db)
        XCTAssertEqual(tokens, 9_000)
        XCTAssertEqual(window, 1_000_000)
    }

    func testUnknownSessionAndUndecryptableFramesAreDropped() throws {
        let db = try makeDatabase()
        let applier = LiveSessionContextApplier(crypto: crypto, database: db)

        XCTAssertEqual(applier.apply(try frame(sessionId: "missing", tokens: 7, at: 1)), .unknownSession)
        XCTAssertNil(try db.session(byId: "missing"))

        let foreign = CryptoManager(seed: "other-seed", userId: "user-1")
        let encrypted = try foreign.encrypt(plaintext: #"{"currentContext":{"tokens":1,"contextWindow":2}}"#)
        let data = try JSONEncoder().encode(SessionContextBroadcast(
            type: "sessionContextBroadcast",
            update: LiveSessionContext(sessionId: "s1", encryptedContext: encrypted.encrypted,
                                       contextIv: encrypted.iv, at: 5),
            fromConnectionId: nil
        ))
        XCTAssertEqual(applier.apply(data), .undecryptable)
        XCTAssertEqual(try context(db).0, 10)

        // A dropped frame does not advance the ordering guard.
        XCTAssertEqual(applier.apply(try frame(tokens: 42, at: 5)), .applied)
        XCTAssertEqual(try context(db).0, 42)
    }
}
