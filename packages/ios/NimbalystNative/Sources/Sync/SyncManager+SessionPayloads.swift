import Foundation

/// #1711 chunked-transcript handling, kept out of SyncManager.swift (which may
/// not grow; see .claude/rules/mobile-sync.md).
extension SyncManager {
    func acceptPayloadPart(_ data: Data, sessionId: String) {
        struct PartEnvelope: Decodable { let part: SessionPayloadPart }
        do {
            let part = try decoder.decode(PartEnvelope.self, from: data).part
            try sessionPayloads.accept(part, sessionId: sessionId)
        } catch {
            report(SyncError(kind: .storage, message: "Could not save part of a large message on this device.",
                             code: "payloadPartRejected", detail: "\(type(of: error)): \(error)"))
        }
    }

    func decryptServerMessage(_ entry: ServerMessageEntry, sessionId: String) -> Message? {
        do { return try decodeSessionPayloadMessage(entry, sessionId: sessionId, payloads: sessionPayloads, crypto: crypto) }
        catch {
            // An inline row that fails was written under an earlier key and never
            // becomes readable; history sync logs it and shows nothing, as before
            // #1711. Only an incomplete large message, which can heal on the next
            // sync, is worth a banner.
            if entry.payload != nil {
                report(SyncError(kind: .decrypt, message: "Part of a large message has not downloaded yet. It will retry on the next sync.",
                                 code: "payloadIncomplete", detail: "\(type(of: error)): \(error)"))
            }
            return nil
        }
    }

    /// Unreadable history rows go to "Copy diagnostics" only, never the banner.
    func recordUnreadableHistory(failed: Int, of total: Int) {
        DiagnosticsLog.shared.record(area: "sync.decrypt", summary: "Some synced messages could not be decrypted",
                                     detail: "\(failed) of \(total) in one session")
    }
}
