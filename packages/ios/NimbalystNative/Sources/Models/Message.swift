import Foundation
import GRDB

/// An individual message within a session.
public struct Message: Codable, Identifiable, Hashable, Sendable {
    public var id: String
    public var sessionId: String
    public var sequence: Int
    public var source: String         // "user" | "assistant" | "tool" | "system"
    public var direction: String      // "input" | "output"
    public var encryptedContent: String
    public var iv: String
    public var contentDecrypted: String?
    public var metadataJson: String?  // tool_name, has_attachments, content_length
    /// Sync projection version + server revision (#1711); orders same-ID repairs.
    public var projectionJson: String?
    public var createdAt: Int

    public init(
        id: String, sessionId: String, sequence: Int,
        source: String, direction: String,
        encryptedContent: String, iv: String,
        contentDecrypted: String? = nil, metadataJson: String? = nil,
        projectionJson: String? = nil,
        createdAt: Int
    ) {
        self.id = id
        self.sessionId = sessionId
        self.sequence = sequence
        self.source = source
        self.direction = direction
        self.encryptedContent = encryptedContent
        self.iv = iv
        self.contentDecrypted = contentDecrypted
        self.metadataJson = metadataJson
        self.projectionJson = projectionJson
        self.createdAt = createdAt
    }
}

// MARK: - GRDB Conformance

extension Message: FetchableRecord, PersistableRecord {
    public static let databaseTableName = "messages"

    public enum Columns: String, ColumnExpression {
        case id, sessionId, sequence, source, direction
        case encryptedContent, iv, contentDecrypted, metadataJson, projectionJson, createdAt
    }

    /// Association to parent session.
    static let session = belongsTo(Session.self)
}
