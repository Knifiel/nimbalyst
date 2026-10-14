import SwiftUI

/// Shared loading and empty states for the project chooser and session sidebar.
struct IndexListPlaceholder: View {
    @EnvironmentObject private var appState: AppState
    let noun: String
    let symbol: String
    let emptyDescription: String
    let observationState: IndexLoadState
    /// Local query failure, when there is one. Without it the screen cannot tell
    /// a broken local database from a failed server sync.
    var localFailure: SessionListLoadFailure? = nil

    private var isFailed: Bool {
        observationState == .failed || appState.indexLoadState == .failed
    }

    var body: some View {
        VStack(spacing: 12) {
            // The placeholder overlays a List. Only the Copy button takes
            // touches, so pull-to-refresh still reaches the List everywhere else.
            VStack(spacing: 12) {
                if isFailed {
                    Image(systemName: "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90")
                        .font(.largeTitle)
                    Text("Couldn’t load \(noun.lowercased())")
                    Text("Pull down to try again.").font(.caption)
                    if let localFailure {
                        Text("Error reading this device’s database: \(localFailure.detail)")
                            .font(.caption2)
                    } else if appState.indexLoadState == .failed {
                        Text("The server sync failed.").font(.caption2)
                    }
                } else if observationState == .loading || appState.indexLoadState == .loading {
                    ProgressView()
                    Text("Loading \(noun.lowercased())…")
                    if !appState.isConnected {
                        Text("Waiting for a connection…").font(.caption)
                    }
                } else {
                    Image(systemName: symbol).font(.system(size: 48))
                    Text("No \(noun)").font(.title3)
                    Text(emptyDescription).font(.caption)
                }
            }
            .allowsHitTesting(false)

            if isFailed {
                CopyDiagnosticsButton()
                    .padding(.top, 4)
            }
        }
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
        .padding()
    }
}

/// "Copy diagnostics" where a failure is on screen, for pasting into a bug report.
struct CopyDiagnosticsButton: View {
    @EnvironmentObject private var appState: AppState
    @State private var copied = false

    var body: some View {
        Button {
            DiagnosticsReport.copyToClipboard(appState: appState)
            copied = true
        } label: {
            Label(copied ? "Copied" : "Copy diagnostics", systemImage: copied ? "checkmark" : "doc.on.doc")
                .font(.caption)
        }
        .buttonStyle(.bordered)
        .accessibilityIdentifier("copy-diagnostics")
    }
}
