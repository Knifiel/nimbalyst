import Foundation
import CryptoKit

struct SessionPayloadReference: Codable {
    let transferId: String
    let count: Int
}

struct SessionPayloadPart: Codable {
    let transferId: String
    let count: Int
    let messageId: String
    let index: Int
    let encryptedContent: String
    let iv: String
}

private struct SessionPayloadManifest: Decodable {
    let format: String
    let transferId: String
    let count: Int
    let messageId: String
    let projectionVersion: Int
    let sha256: String
    let bytes: Int
}

private struct DecryptedSessionPayloadPart: Decodable {
    let transferId: String
    let count: Int
    let messageId: String
    let index: Int
    let data: String
}

enum SessionPayloadError: Error { case invalidPart, incomplete, integrity, quota }

/// Encrypted-only durable staging. Interrupted downloads can reuse already persisted parts.
final class SessionPayloadStore {
    private let directory: URL
    init(directory: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("SessionPayloads")) {
        self.directory = directory
    }

    private func url(sessionId: String, transferId: String, index: Int) throws -> URL {
        guard transferId.count == 32, transferId.allSatisfy({ "0123456789abcdef".contains($0) }), index >= 0, index < 128 else { throw SessionPayloadError.invalidPart }
        let session = SHA256.hash(data: Data(sessionId.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent("\(session)-\(transferId)-\(index).json")
    }

    func accept(_ part: SessionPayloadPart, sessionId: String) throws {
        guard part.count > 0, part.count <= 128, part.index < part.count,
              !part.messageId.isEmpty, part.messageId.count <= 256,
              part.encryptedContent.utf8.count <= 512 * 1024, part.iv.count == 16 else { throw SessionPayloadError.invalidPart }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = try url(sessionId: sessionId, transferId: part.transferId, index: part.index)
        let data = try JSONEncoder().encode(part)
        if FileManager.default.fileExists(atPath: path.path) {
            let previous = try JSONDecoder().decode(SessionPayloadPart.self, from: Data(contentsOf: path))
            guard previous.encryptedContent == part.encryptedContent, previous.iv == part.iv,
                  previous.messageId == part.messageId, previous.count == part.count else { throw SessionPayloadError.invalidPart }
            return
        }
        var bytes = 0
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey]) {
            let values = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            if let modified = values.contentModificationDate, modified < Date().addingTimeInterval(-86400) {
                try FileManager.default.removeItem(at: file)
            } else { bytes += values.fileSize ?? 0 }
        }
        guard bytes + data.count <= 25 * 1024 * 1024 else { throw SessionPayloadError.quota }
        try data.write(to: path, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func release(_ entry: ServerMessageEntry, sessionId: String) {
        guard let reference = entry.payload else { return }
        for index in 0..<min(reference.count, 128) {
            if let path = try? url(sessionId: sessionId, transferId: reference.transferId, index: index) {
                try? FileManager.default.removeItem(at: path)
            }
        }
    }

    func decrypt(_ entry: ServerMessageEntry, sessionId: String, decrypt: (String, String) throws -> String) throws -> String {
        let plaintext = try decrypt(entry.encryptedContent, entry.iv)
        guard let reference = entry.payload else { return plaintext }
        let manifest = try JSONDecoder().decode(SessionPayloadManifest.self, from: Data(plaintext.utf8))
        guard manifest.format == "session-payload-v1", manifest.projectionVersion == 1,
              manifest.messageId == entry.id, manifest.transferId == reference.transferId,
              manifest.count == reference.count, reference.count > 0, reference.count <= 128,
              manifest.bytes > 0, manifest.bytes <= 16 * 1024 * 1024 else { throw SessionPayloadError.integrity }
        var output = Data()
        for index in 0..<reference.count {
            let path = try url(sessionId: sessionId, transferId: reference.transferId, index: index)
            let part = try JSONDecoder().decode(SessionPayloadPart.self, from: Data(contentsOf: path))
            guard part.messageId == entry.id, part.transferId == reference.transferId, part.index == index, part.count == reference.count else { throw SessionPayloadError.integrity }
            let raw = try decrypt(part.encryptedContent, part.iv)
            let decoded = try JSONDecoder().decode(DecryptedSessionPayloadPart.self, from: Data(raw.utf8))
            guard decoded.messageId == entry.id, decoded.transferId == reference.transferId, decoded.index == index,
                  decoded.count == reference.count, let bytes = Data(base64Encoded: decoded.data), bytes.count <= 128 * 1024,
                  output.count + bytes.count <= manifest.bytes else { throw SessionPayloadError.integrity }
            output.append(bytes)
        }
        let hash = SHA256.hash(data: output).map { String(format: "%02x", $0) }.joined()
        guard output.count == manifest.bytes, hash == manifest.sha256, let result = String(data: output, encoding: .utf8) else { throw SessionPayloadError.integrity }
        return result
    }
}

struct SyncProjectionStamp: Codable {
    var version: Int = 0
    var revision: Int = 0

    init(version: Int = 0, revision: Int = 0) { self.version = version; self.revision = revision }
    init(_ json: String?) {
        self = json.flatMap { try? JSONDecoder().decode(Self.self, from: Data($0.utf8)) } ?? Self()
    }
    var json: String { "{\"version\":\(version),\"revision\":\(revision)}" }
    func isNewer(than other: Self) -> Bool {
        version > other.version || (version == other.version && revision > other.revision)
    }
}

@MainActor
func decodeSessionPayloadMessage(_ entry: ServerMessageEntry, sessionId: String, payloads: SessionPayloadStore, crypto: CryptoManager) throws -> Message {
    let plaintext = try payloads.decrypt(entry, sessionId: sessionId) { encrypted, iv in
        try crypto.decrypt(encryptedBase64: encrypted, ivBase64: iv)
    }
    return Message(id: entry.id, sessionId: sessionId, sequence: entry.sequence,
        source: entry.source, direction: entry.direction, encryptedContent: entry.encryptedContent,
        iv: entry.iv, contentDecrypted: plaintext,
        projectionJson: SyncProjectionStamp(version: entry.projectionVersion ?? 0, revision: entry.revision ?? 0).json,
        createdAt: entry.createdAt)
}

func transcriptRevisionCursor(_ cursor: String?) -> Int {
    guard let cursor, cursor.hasPrefix("r:"), let value = Int(cursor.dropFirst(2)), value >= 0 else { return 0 }
    return value
}

struct SessionPayloadAppendPart: Codable { let type: String; let part: SessionPayloadPart }
struct SessionPayloadGetParts: Codable { let type: String; let transferId: String; let indexes: [Int] }
struct SessionProjectionRequest: Codable { let type: String; let messageId: String }
struct SessionProjectionResponse: Codable { let type: String; let messageId: String; let revision: Int }
struct SessionPayloadReady: Codable { let type: String; let version: Int }
struct SessionPayloadPartMessage: Codable { let type: String; let part: SessionPayloadPart }
struct SessionPayloadPartAck: Codable { let type: String; let transferId: String; let index: Int }
struct SessionMessageAppendAck: Codable { let type: String; let messageId: String; let revision: Int }
