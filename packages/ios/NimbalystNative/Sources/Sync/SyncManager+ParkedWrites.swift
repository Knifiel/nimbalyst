import Foundation

/// When writes parked across a disconnect re-publish.
///
/// A draft push replaces the server's whole client-metadata blob, and the
/// phone builds that blob from its cached row. Replayed straight after the
/// socket reopens, it would restore whatever the cache held, including
/// desktop-owned fields such as `transcriptSyncDisabled` that the desktop has
/// changed since. So the replay waits until index catch-up has applied the
/// server's current blobs to the rows the rebuild reads.
extension SyncManager {
    func indexLoadStateChanged(from oldValue: IndexLoadState) {
        if indexLoadState == .failed, oldValue != .failed { SyncDiagnosticsFile.shared.log("indexLoadFailed") }
        // Versioned replication reports `.loaded` after its first page; it
        // replays on `caughtUp` instead. Legacy loads are whole responses.
        if indexLoadState == .loaded, oldValue != .loaded, indexCoverage.compatibility != .v2 {
            requests.reconnect()
        }
    }

    func indexCoverageChanged(_ coverage: IndexCoverage) {
        if coverage.caughtUp { requests.reconnect() }
    }
}
