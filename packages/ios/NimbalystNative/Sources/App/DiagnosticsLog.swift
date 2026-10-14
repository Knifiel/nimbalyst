import Foundation

/// One recorded failure. `detail` is the technical cause (a SQLite message, a
/// thrown error); it never carries transcript or session content.
public struct DiagnosticEntry: Codable, Equatable, Sendable {
    public var at: Date
    public var area: String
    public var summary: String
    public var detail: String?
    /// Consecutive repeats are folded into one entry so a failure that recurs on
    /// every sync cannot push everything else out of the buffer.
    public var count: Int
}

/// The last few failures the user saw (or that were only logged), persisted so
/// "Copy diagnostics" still has them after a relaunch. Before this, the only way
/// to see why the phone failed was the Mac Console app on a cabled device.
public final class DiagnosticsLog: @unchecked Sendable {
    public static let shared = DiagnosticsLog()
    static let capacity = 20
    private static let key = "nimbalyst.diagnostics.recentErrors"

    private let defaults: UserDefaults
    private let lock = NSLock()
    private var stored: [DiagnosticEntry]

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        stored = defaults.data(forKey: Self.key)
            .flatMap { try? JSONDecoder().decode([DiagnosticEntry].self, from: $0) } ?? []
    }

    public var entries: [DiagnosticEntry] {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    public func record(area: String, summary: String, detail: String? = nil, at: Date = Date()) {
        lock.lock(); defer { lock.unlock() }
        if var last = stored.last, last.area == area, last.summary == summary, last.detail == detail {
            last.count += 1
            last.at = at
            stored[stored.count - 1] = last
        } else {
            stored.append(DiagnosticEntry(at: at, area: area, summary: summary, detail: detail, count: 1))
            if stored.count > Self.capacity { stored.removeFirst(stored.count - Self.capacity) }
        }
        if let data = try? JSONEncoder().encode(stored) { defaults.set(data, forKey: Self.key) }
    }
}
