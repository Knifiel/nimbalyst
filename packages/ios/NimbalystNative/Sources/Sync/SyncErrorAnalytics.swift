import Foundation

/// Decides which `SyncError`s become a `mobile_sync_error` event. One per kind
/// and code per window: a dead socket fails every send, and a burst is one
/// interruption, not fifty events.
struct SyncErrorAnalyticsThrottle {
    private var lastSent: [String: Date] = [:]
    private let window: TimeInterval

    init(window: TimeInterval = 10 * 60) {
        self.window = window
    }

    /// Event properties to send, or nil when this failure was reported recently.
    /// Kind and code only: messages and details stay on the device.
    /// Keeps the error for "Copy diagnostics" and sends the throttled event.
    @MainActor
    mutating func observe(_ error: SyncError) {
        DiagnosticsLog.shared.record(area: "sync.\(error.kind.rawValue)", summary: error.code ?? error.message, detail: error.detail)
        if let properties = properties(for: error) {
            AnalyticsManager.shared.capture("mobile_sync_error", properties: properties)
        }
    }

    mutating func properties(for error: SyncError, now: Date = Date()) -> [String: Any]? {
        let key = "\(error.kind.rawValue)|\(error.code ?? "")"
        if let last = lastSent[key], now.timeIntervalSince(last) < window { return nil }
        lastSent[key] = now
        var properties: [String: Any] = ["kind": error.kind.rawValue]
        if let code = error.code { properties["code"] = code }
        return properties
    }
}
