import XCTest
@testable import NimbalystNative

/// Sign-in failures must reach the user. Two paths previously ended in silence:
/// the collab worker's `error_description` deep link, and an auth sheet abandoned
/// after Stytch's OAuth state cookie expired (NIM-2679).
final class AuthErrorSurfacingTests: XCTestCase {

    // MARK: - Worker error deep link

    func testWorkerErrorDescriptionIsPreferredOverErrorCode() {
        let message = AuthManager.authErrorMessage(fromCallbackParams: [
            "error": "discovery_authentication_failed",
            "error_description": "Sign-in failed: a password is required for this organization.",
        ])

        XCTAssertEqual(message, "Sign-in failed: a password is required for this organization.")
    }

    func testWorkerErrorCodeIsSurfacedWhenDescriptionMissing() {
        let message = AuthManager.authErrorMessage(fromCallbackParams: [
            "error": "discovery_authentication_failed",
        ])

        // The bare code is not a sentence, so it must be wrapped into one.
        XCTAssertEqual(message, "Sign-in failed (discovery_authentication_failed).")
    }

    func testBlankErrorDescriptionFallsBackToCode() {
        let message = AuthManager.authErrorMessage(fromCallbackParams: [
            "error": "discovery_authentication_failed",
            "error_description": "   ",
        ])

        XCTAssertEqual(message, "Sign-in failed (discovery_authentication_failed).")
    }

    func testSuccessfulCallbackParamsProduceNoError() {
        let message = AuthManager.authErrorMessage(fromCallbackParams: [
            "session_token": "tok",
            "session_jwt": "jwt",
            "user_id": "member-123",
            "org_id": "org-123",
        ])

        XCTAssertNil(message)
    }

    // MARK: - Abandoned auth sheet

    func testQuickDismissIsTreatedAsDeliberateCancel() {
        // Tapping Cancel within seconds is intentional -- staying silent is correct.
        XCTAssertNil(AuthManager.abandonedSessionMessage(elapsed: 4))
    }

    func testDismissAfterStateWindowReportsTimeout() {
        // Past Stytch's 600s oauth_state lifetime the sheet was almost certainly
        // showing an oauth_invalid_state error rather than a login form.
        let message = AuthManager.abandonedSessionMessage(elapsed: 601)

        XCTAssertNotNil(message)
        XCTAssertTrue(
            message!.localizedCaseInsensitiveContains("timed out"),
            "Expected a timeout explanation, got: \(message!)"
        )
    }

    func testStateWindowBoundaryIsInclusive() {
        XCTAssertNil(AuthManager.abandonedSessionMessage(elapsed: 599))
        XCTAssertNotNil(AuthManager.abandonedSessionMessage(elapsed: 600))
    }

    /// Failures are counted at most once per four minutes, so a banner at the third
    /// one left a user on a silent spinner for 10 minutes before offering sign-in.
    func testFirstCountedRefreshFailureOffersSignInAndFifthSignsOut() {
        XCTAssertEqual(RefreshFailurePolicy.action(forConsecutiveFailures: 0), .none)
        XCTAssertEqual(RefreshFailurePolicy.action(forConsecutiveFailures: 1), .banner)
        XCTAssertEqual(RefreshFailurePolicy.action(forConsecutiveFailures: 4), .banner)
        XCTAssertEqual(RefreshFailurePolicy.action(forConsecutiveFailures: 5), .signOut)
    }
}
