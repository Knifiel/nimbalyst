import Foundation
import GRDB
#if canImport(UIKit)
import UIKit
#endif

/// The text "Copy diagnostics" puts on the clipboard. Versions, database shape
/// and recent failures only: no session titles, messages or ids, so a user can
/// paste it into a public issue.
public enum DiagnosticsReport {
    public struct Facts {
        var appVersion: String
        var osVersion: String
        var device: String
        var sqliteVersion: String
        var migrations: [String]
        var connected: Bool
        var signedIn: Bool
        var sessionCount: Int?
        var errors: [DiagnosticEntry]
    }

    public static func render(_ facts: Facts, now: Date = Date()) -> String {
        let iso = ISO8601DateFormatter()
        var lines = [
            "Nimbalyst iOS diagnostics",
            "Generated: \(iso.string(from: now))",
            "App: \(facts.appVersion)",
            "OS: \(facts.osVersion) (\(facts.device))",
            "SQLite: \(facts.sqliteVersion)",
            "Connected: \(facts.connected ? "yes" : "no"), signed in: \(facts.signedIn ? "yes" : "no")",
            "Local sessions: \(facts.sessionCount.map(String.init) ?? "unreadable")",
            "Migrations (\(facts.migrations.count)): latest \(facts.migrations.last ?? "none")",
            "",
            "Recent errors (newest first):",
        ]
        if facts.errors.isEmpty { lines.append("  none recorded") }
        for entry in facts.errors.reversed() {
            let repeats = entry.count > 1 ? " (x\(entry.count))" : ""
            lines.append("  \(iso.string(from: entry.at)) [\(entry.area)] \(entry.summary)\(repeats)")
            if let detail = entry.detail { lines.append("    \(detail)") }
        }
        return lines.joined(separator: "\n")
    }

    /// Collects facts without throwing: a broken database is exactly when this
    /// report is needed, so every read degrades to "unreadable".
    @MainActor
    static func gather(appState: AppState, log: DiagnosticsLog = .shared) -> Facts {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        var sqlite = "unreadable"
        var migrations: [String] = []
        var sessionCount: Int?
        if let writer = appState.databaseManager?.writer {
            _ = try? writer.read { db in
                sqlite = try String.fetchOne(db, sql: "SELECT sqlite_version()") ?? sqlite
                migrations = (try? String.fetchAll(db, sql: "SELECT identifier FROM grdb_migrations")) ?? []
                sessionCount = try? Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sessions")
            }
        }
        #if canImport(UIKit)
        let os = "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
        let device = UIDevice.current.model
        #else
        let os = ProcessInfo.processInfo.operatingSystemVersionString
        let device = "mac"
        #endif
        return Facts(
            appVersion: "\(version) (\(build))", osVersion: os, device: device,
            sqliteVersion: sqlite, migrations: migrations,
            connected: appState.isConnected, signedIn: appState.authManager.isAuthenticated,
            sessionCount: sessionCount, errors: log.entries
        )
    }

    @MainActor
    public static func copyToClipboard(appState: AppState) {
        let text = render(gather(appState: appState))
        #if canImport(UIKit)
        UIPasteboard.general.string = text
        #endif
    }
}
