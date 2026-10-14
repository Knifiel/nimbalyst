import Foundation

/// What a run of transient JWT refresh failures should surface. A failure is
/// counted at most once per four minutes, so the banner used to wait 8+ minutes
/// behind an endless "Loading sessions" spinner with no error shown.
enum RefreshFailurePolicy {
    enum Action: Equatable { case none, banner, signOut }

    static let escalationThreshold = 5

    static func action(forConsecutiveFailures count: Int) -> Action {
        if count >= escalationThreshold { return .signOut }
        return count >= 1 ? .banner : .none
    }
}
