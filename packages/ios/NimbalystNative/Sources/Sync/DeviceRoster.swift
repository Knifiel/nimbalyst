import Foundation

/// A desktop's id changes with its data directory, so the server's roster holds
/// old offline ids for the same computer until it expires them. Only show what
/// is online or was seen within the week the phone keeps sessions for.
enum DeviceRoster {
    static let recentWindowMs = 7 * 24 * 60 * 60 * 1000

    static func recent(_ devices: [DeviceInfo], now: Date = Date()) -> [DeviceInfo] {
        let cutoff = Int(now.timeIntervalSince1970 * 1000) - recentWindowMs
        // No isOnline: a server that lists only connected devices.
        return devices.filter { $0.isOnline != false || ($0.lastSeenAt ?? $0.lastActiveAt) >= cutoff }
    }
}
