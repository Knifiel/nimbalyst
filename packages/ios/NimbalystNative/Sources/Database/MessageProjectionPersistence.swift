import GRDB
import os

private let logger = Logger(subsystem: "com.nimbalyst.app", category: "MessageProjection")

/// Same-ID repair replaces only a newer projection, preserving logical ordering.
/// A row whose identity moved is skipped, never thrown: one bad row must not
/// roll back the batch and stall the session's transcript.
func persistMessageProjections(_ messages: [Message], in db: Database) throws {
    var existing: [String: Message] = [:]
    for start in stride(from: 0, to: messages.count, by: 256) {
        let ids = messages[start..<min(start + 256, messages.count)].map(\.id)
        for message in try Message.filter(ids.contains(Column("id"))).fetchAll(db) { existing[message.id] = message }
    }
    for message in messages {
        if let old = existing[message.id] {
            guard old.sessionId == message.sessionId, old.sequence == message.sequence else {
                logger.error("Skipping projection \(message.id, privacy: .public): stored identity differs (seq \(old.sequence) vs \(message.sequence))")
                continue
            }
            if SyncProjectionStamp(message.projectionJson).isNewer(than: SyncProjectionStamp(old.projectionJson)) {
                try message.update(db)
                existing[message.id] = message
            }
        } else {
            try message.insert(db, onConflict: .ignore)
            existing[message.id] = message
        }
    }
}
