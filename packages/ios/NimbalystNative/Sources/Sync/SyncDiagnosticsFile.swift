import Foundation

/// One field value in a sync diagnostics line. Only values the app produces
/// itself are ever written verbatim; see `SyncDiagnosticsRedactor`.
public enum SyncDiagnosticValue: Sendable, Equatable {
    case int(Int)
    case bool(Bool)
    case ints([Int])
    /// A session id. Written only when it has the UUID shape the desktop mints.
    case id(String?)
    /// A label the app or the sync protocol defines: a cause, a room kind, an
    /// enum state, a known server error code. Written only when allowlisted.
    case label(String)
    /// Free text from the server or the OS (close reasons, error messages).
    /// Never written; only whether it was present and how long it was.
    case text(String?)
}

/// Decides what reaches the diagnostics file. It is an allowlist: event names,
/// labels and ids must be ones the app itself produces, and everything else is
/// reduced to its length. A token-shaped string (an API key, a bearer token, an
/// org or user id) is not a reason to write it.
public enum SyncDiagnosticsRedactor {
    static let events: Set<String> = [
        "socketConnect", "socketOpen", "socketClose",
        "sessionSyncRequest", "sessionSyncPage", "sessionSyncCommit", "sessionSyncEmpty", "sessionSyncFailed",
        "decryptFailed", "serverError", "indexServerError",
        "indexLoadFailed", "indexPageFailed", "indexPageRequestFailed",
        "requestTimeout", "requestFailed",
    ]

    static let labels: Set<String> = {
        var labels: Set<String> = [
            // Room kinds and socket close causes from WebSocketClient.
            "session", "index", "other", "unknown",
            "readinessTimeout", "handshakeFailed", "sendFailed", "handshakeBufferExceeded",
            "receiveFailed", "pingFailed", "intentional", "indexPage",
            // Error codes the session and index rooms send (collabv3 SessionRoom/IndexRoom).
            "index_page_failed", "invalid_index_patch", "invalid_message", "invalid_session_context",
            "parse_error", "session_expired", "session_not_found", "target_device_unavailable",
            "unknown_message_type", "write_rate_limited", "forbidden", "unauthorized",
        ]
        labels.formUnion(SyncRequestKind.allCases.map(\.rawValue))
        labels.formUnion(SyncError.Kind.allCases.map(\.rawValue))
        labels.formUnion(IndexReplicationMode.allCases.map(\.rawValue))
        return labels
    }()

    static func event(_ name: String) -> String {
        events.contains(name) ? name : "unlistedEvent len=\(name.count)"
    }

    static func render(_ value: SyncDiagnosticValue) -> String {
        switch value {
        case .int(let n): return String(n)
        case .bool(let b): return b ? "true" : "false"
        case .ints(let list):
            return "[" + list.prefix(20).map(String.init).joined(separator: ",") + (list.count > 20 ? ",..." : "") + "]"
        case .id(let id):
            guard let id else { return "none" }
            return isUUID(id) ? id : "<id len=\(id.count)>"
        case .label(let label):
            return labels.contains(label) ? label : "<unlisted len=\(label.count)>"
        case .text(let text):
            guard let text, !text.isEmpty else { return "<absent>" }
            return "<present len=\(text.count)>"
        }
    }

    /// Keys are literals at call sites; this only keeps a malformed one out.
    static func key(_ key: String) -> String? {
        guard !key.isEmpty, key.count <= 32,
              key.unicodeScalars.allSatisfy({ CharacterSet.letters.contains($0) && $0.isASCII }) else { return nil }
        return key
    }

    /// App version and build come from our own bundle, but the header still
    /// writes only digits and dots.
    static func version(_ text: String) -> String {
        let ok = !text.isEmpty && text.count <= 32 && text.unicodeScalars.allSatisfy { $0 == "." || ("0"..."9").contains($0) }
        return ok ? text : "<len=\(text.count)>"
    }

    static func isUUID(_ text: String) -> Bool {
        UUID(uuidString: text) != nil
    }
}

/// Session-sync diagnostics written to a rotating file in Application Support,
/// so they can be copied off a device with
/// `xcrun devicectl device copy from --domain-type appDataContainer --domain-identifier com.nimbalyst.app`.
/// os_log is unreachable on a device that is not cabled to a Mac while the
/// problem happens.
///
/// Lines carry ids, codes, counts and timestamps only; see
/// `SyncDiagnosticsRedactor`. Writes run on a private serial queue so the main
/// thread never waits on the disk.
public final class SyncDiagnosticsFile: @unchecked Sendable {
    public static let shared = SyncDiagnosticsFile(directory: defaultDirectory)

    static let fileName = "sync.log"
    static let previousFileName = "sync.1.log"
    static let defaultMaxBytes = 1_000_000

    /// `Library/Application Support/NimbalystNative/diagnostics`.
    static var defaultDirectory: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("NimbalystNative", isDirectory: true)
            .appendingPathComponent("diagnostics", isDirectory: true)
    }

    private let directory: URL?
    private let maxBytes: Int
    private let header: String
    private let queue = DispatchQueue(label: "com.nimbalyst.sync-diagnostics", qos: .utility)
    private var handle: FileHandle?
    private var size = 0
    private let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    init(directory: URL?, maxBytes: Int = defaultMaxBytes, header: String = SyncDiagnosticsFile.defaultHeader()) {
        self.directory = directory
        self.maxBytes = maxBytes
        self.header = header
    }

    var currentFileURL: URL? { directory?.appendingPathComponent(Self.fileName) }
    var previousFileURL: URL? { directory?.appendingPathComponent(Self.previousFileName) }

    static func defaultHeader(bundle: Bundle = .main) -> String {
        let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        let build = bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
        return "# Nimbalyst sync diagnostics app=\(SyncDiagnosticsRedactor.version(version)) build=\(SyncDiagnosticsRedactor.version(build))"
    }

    /// Append one event. Never blocks the caller.
    public func log(_ event: String, _ fields: KeyValuePairs<String, SyncDiagnosticValue> = [:], at date: Date = Date()) {
        log(event, fields: fields.map { ($0.key, $0.value) }, at: date)
    }

    public func log(_ event: String, fields: [(String, SyncDiagnosticValue)], at date: Date = Date()) {
        let line = format(event: event, fields: fields, at: date)
        queue.async { [weak self] in self?.append(line) }
    }

    /// Wait for queued writes. Tests only; production code never waits.
    func flush() {
        queue.sync {}
    }

    func format(event: String, fields: [(String, SyncDiagnosticValue)], at date: Date) -> String {
        var parts = [formatter.string(from: date), SyncDiagnosticsRedactor.event(event)]
        for (key, value) in fields {
            guard let key = SyncDiagnosticsRedactor.key(key) else { continue }
            parts.append("\(key)=\(SyncDiagnosticsRedactor.render(value))")
        }
        return parts.joined(separator: " ") + "\n"
    }

    // MARK: - Queue-confined file work

    private func append(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        guard let handle = openIfNeeded() else { return }
        if size > 0, size + data.count > maxBytes {
            rotate()
            guard let fresh = openIfNeeded() else { return }
            write(data, to: fresh)
            return
        }
        write(data, to: handle)
    }

    private func write(_ data: Data, to handle: FileHandle) {
        do {
            try handle.write(contentsOf: data)
            size += data.count
        } catch {
            // Diagnostics must never take sync down with them. Drop the handle
            // so the next line reopens (the file may have been removed).
            try? handle.close()
            self.handle = nil
        }
    }

    private func openIfNeeded() -> FileHandle? {
        if let handle { return handle }
        guard let directory, let url = currentFileURL else { return nil }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: Self.protectionAttributes)
            if !fm.fileExists(atPath: url.path) {
                fm.createFile(atPath: url.path, contents: Data((header + "\n").utf8), attributes: Self.protectionAttributes)
            }
            let handle = try FileHandle(forWritingTo: url)
            size = Int(try handle.seekToEnd())
            self.handle = handle
            return handle
        } catch {
            return nil
        }
    }

    private func rotate() {
        try? handle?.close()
        handle = nil
        size = 0
        guard let current = currentFileURL, let previous = previousFileURL else { return }
        let fm = FileManager.default
        try? fm.removeItem(at: previous)
        try? fm.moveItem(at: current, to: previous)
    }

    /// Readable after first unlock, so background sync can still write.
    private static var protectionAttributes: [FileAttributeKey: Any]? {
        #if os(iOS)
        [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        #else
        nil
        #endif
    }
}

extension SyncDiagnosticsFile {
    /// The room kind and, for a session room, the session id. Never the org or
    /// user id the room name also carries.
    static func roomFields(_ roomId: String?) -> (kind: String, sessionId: String?) {
        guard let roomId else { return ("unknown", nil) }
        if let range = roomId.range(of: ":session:") {
            return ("session", String(roomId[range.upperBound...]))
        }
        if roomId.hasSuffix(":index") { return ("index", nil) }
        return ("other", nil)
    }
}

extension SyncDiagnosticsFile {
    /// The outcome of committing a session sync: counts and failed sequences.
    /// A sync that returned no rows at all gets its own event, because it is the
    /// signature of a transcript the desktop never published.
    func log(commit diagnostic: SyncManager.SessionSyncDiagnostic, sessionId: String) {
        let event: String
        if diagnostic.error != nil {
            event = "sessionSyncFailed"
        } else if diagnostic.totalServerMessages == 0 {
            event = "sessionSyncEmpty"
        } else {
            event = "sessionSyncCommit"
        }
        log(event, [
            "sessionId": .id(sessionId),
            "total": .int(diagnostic.totalServerMessages),
            "stored": .int(diagnostic.storedCount),
            "failed": .int(diagnostic.failedSequences.count),
            "failedSeqs": .ints(diagnostic.failedSequences),
        ])
    }
}
