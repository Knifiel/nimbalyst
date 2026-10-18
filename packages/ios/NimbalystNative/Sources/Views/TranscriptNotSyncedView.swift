import SwiftUI

/// Shown in place of the transcript when the desktop lists a session but
/// withholds its messages because the session's project is not enabled for
/// sync. Without it the web view shows an empty transcript under a "Thinking..."
/// row that never resolves. The header keeps the real running/idle status.
struct TranscriptNotSyncedView: View {
    static let title = "Transcript not synced"
    static let message = "This session's project isn't synced to this device. To see the transcript, open Settings > Mobile App in the Nimbalyst desktop app and add the project under Projects accessible on mobile."

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: "icloud.slash")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
            Text(Self.title)
                .font(.headline)
            Text(Self.message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(NimbalystColors.backgroundSecondary)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("transcript-not-synced")
    }
}
