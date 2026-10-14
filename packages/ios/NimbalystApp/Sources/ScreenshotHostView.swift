import SwiftUI
import NimbalystNative

#if DEBUG
/// Routes to the appropriate screen for screenshot capture.
/// Reads `--screenshot-screen=<name>` from launch arguments.
struct ScreenshotHostView: View {
    @EnvironmentObject var appState: AppState

    private var screenTarget: String {
        for arg in CommandLine.arguments {
            if arg.hasPrefix("--screenshot-screen=") {
                return arg.replacingOccurrences(of: "--screenshot-screen=", with: "")
            }
        }
        return "projects"
    }

    var body: some View {
        Group {
            switch screenTarget {
            case "navigation":
                MainNavigationView()
            case "projects":
                MainNavigationView()
            case "sessions":
                MainNavigationView(project: firstProject)
            case "detail":
                NavigationStack {
                    SessionDetailView(session: detailSession)
                }
            case "settings":
                NavigationStack {
                    SettingsView()
                }
            case "pairing":
                PairingView()
            case "document":
                NavigationStack {
                    DocumentEditorView(document: demoDocument)
                }
            default:
                MainNavigationView()
            }
        }
        .preferredColorScheme(.dark)
    }

    /// The first project (nimbalyst) for the sessions screenshot.
    private var firstProject: Project {
        let projects = (try? appState.databaseManager?.allProjects()) ?? []
        return projects.first ?? Project(id: "demo", name: "Demo")
    }

    /// A wiki-style status page with a wide table, for the document editor screenshot.
    private var demoDocument: SyncedDocument {
        let content = """
        # Status

        | Track | Plan | Stage | Progress | Spec | Waiting on | Next step |
        | --- | --- | --- | --- | --- | --- | --- |
        | Collaboration | Teams beta launch plan | Implementing | About two thirds of the tracker sync work has landed | Shared trackers spec | Server deploy of the room migration | Verify the web console can edit tracker items |
        | Wiki | Knowledge pages v2 | Planning | Design doc drafted, prototype pending review | Pages design | Feedback from the team on the ontology | Build the first typed page view |
        """
        return SyncedDocument(
            id: "demo-status-doc",
            projectId: firstProject.id,
            relativePath: "wiki/Status.md",
            title: "Status",
            contentDecrypted: content
        )
    }

    /// The session with messages for the detail screenshot (sess-nim-1).
    private var detailSession: Session {
        if let db = appState.databaseManager,
           let session = try? db.session(byId: "sess-nim-1") {
            return session
        }
        return Session(id: "demo", projectId: "demo", titleDecrypted: "Demo Session")
    }
}
#endif
