import Foundation
import os

/// Applies `sessionContextBroadcast` frames: live context-window usage the
/// desktop relays mid-turn and the server never stores. The index row still
/// receives the turn-boundary value through the normal index paths.
///
/// Works for both legacy-index and v2-replication clients; it touches only the
/// session row's context columns, never replication cursors.
@MainActor
final class LiveSessionContextApplier {
    enum Outcome: Equatable {
        case applied
        case undecodable
        /// Display-only data: a frame we cannot read is dropped, not reported.
        case undecryptable
        /// Older than or equal to the last frame applied for this session.
        case stale
        case unknownSession
        case databaseError
    }

    private let logger = Logger(subsystem: "com.nimbalyst.app", category: "LiveSessionContext")
    private let crypto: CryptoManager
    private let database: DatabaseManager
    /// Last applied `at` per session. In memory only: after a relaunch the
    /// index row is the baseline and the next live frame is newer than it.
    private var lastAppliedAt: [String: Int] = [:]

    init(crypto: CryptoManager, database: DatabaseManager) {
        self.crypto = crypto
        self.database = database
    }

    @discardableResult
    func apply(_ data: Data) -> Outcome {
        guard let broadcast = try? JSONDecoder().decode(SessionContextBroadcast.self, from: data) else {
            logger.warning("sessionContextBroadcast could not be decoded")
            return .undecodable
        }
        let update = broadcast.update
        if let last = lastAppliedAt[update.sessionId], update.at <= last {
            return .stale
        }
        // The value is display-only and the next frame or the turn-boundary
        // index update replaces it, so a decrypt failure is logged and dropped
        // rather than surfaced as a sync error.
        guard let json = crypto.decryptOrNil(encryptedBase64: update.encryptedContext, ivBase64: update.contextIv),
              let meta = try? JSONDecoder().decode(ClientMetadata.self, from: Data(json.utf8)),
              let context = meta.currentContext else {
            logger.warning("sessionContextBroadcast for \(update.sessionId, privacy: .public) could not be decrypted")
            return .undecryptable
        }
        do {
            let updated = try database.updateSessionContext(
                sessionId: update.sessionId, tokens: context.tokens, contextWindow: context.contextWindow
            )
            guard updated else { return .unknownSession }
        } catch {
            logger.error("sessionContextBroadcast write failed: \(error.localizedDescription, privacy: .public)")
            return .databaseError
        }
        lastAppliedAt[update.sessionId] = update.at
        return .applied
    }
}
