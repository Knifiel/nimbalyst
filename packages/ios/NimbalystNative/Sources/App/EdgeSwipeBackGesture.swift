#if os(iOS)
import SwiftUI
import UIKit

/// A leading-edge swipe for screens that replace content in place rather than
/// pushing it, so the navigation controller's back swipe has nothing to pop.
struct EdgeSwipeBackGesture: UIGestureRecognizerRepresentable {
    var layoutDirection: LayoutDirection
    let action: () -> Void

    private var edge: UIRectEdge { layoutDirection == .rightToLeft ? .right : .left }

    func makeUIGestureRecognizer(context: Context) -> UIScreenEdgePanGestureRecognizer {
        let recognizer = UIScreenEdgePanGestureRecognizer()
        recognizer.edges = edge
        return recognizer
    }

    func updateUIGestureRecognizer(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        recognizer.edges = edge
    }

    func handleUIGestureRecognizerAction(_ recognizer: UIScreenEdgePanGestureRecognizer, context: Context) {
        guard recognizer.state == .ended, let view = recognizer.view else { return }
        // Measure toward the trailing side in either layout direction.
        let sign: CGFloat = recognizer.edges == .right ? -1 : 1
        let distance = recognizer.translation(in: view).x * sign
        let velocity = recognizer.velocity(in: view).x * sign
        if distance > 80 || (distance > 20 && velocity > 500) { action() }
    }
}
#endif
