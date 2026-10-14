/**
 * Shows deep links main could not route (see `shared/deepLinkNotices.ts`).
 *
 * Main queues the notice and sends a bare nudge; the notice is only read
 * through the consuming IPC, so a nudge racing the mount-time drain shows it
 * once. Project windows mount this through `initDeepLinkListeners`; the
 * Project Manager mounts it on its own, since it is the only window when no
 * project is open.
 */
import {
  DEEP_LINK_CONSUME_NOTICES_CHANNEL,
  DEEP_LINK_NOTICE_AVAILABLE_CHANNEL,
  type DeepLinkNotice,
} from '../../../shared/deepLinkNotices';
import { feedbackRequestConsoleUrl } from '../../../shared/feedbackRequestLinks';
import { errorNotificationService } from '../../services/ErrorNotificationService';

const WHAT: Record<DeepLinkNotice['kind'], string> = {
  'shared-document': 'shared document',
  'shared-folder': 'shared folder',
  'feedback-request': 'feedback request',
};

function showNotice(notice: DeepLinkNotice): void {
  const what = WHAT[notice.kind];
  if (!what) throw new Error(`Unknown deep-link notice kind: ${(notice as { kind?: string }).kind}`);
  if (notice.reason === 'not-authenticated') {
    errorNotificationService.showWarning(
      'Sign in required',
      `Sign in to your Nimbalyst team account to open this ${what}.`,
      { duration: 8000 },
    );
  } else if (notice.kind === 'feedback-request') {
    const consoleUrl = feedbackRequestConsoleUrl(notice.orgId, notice.requestId);
    errorNotificationService.showWarning(
      'No matching project',
      'None of your projects belongs to the team that sent this feedback request. You can answer it in the web console.',
      {
        duration: 10000,
        action: { label: 'Open in browser', onClick: () => { void window.electronAPI.openInBrowser(consoleUrl); } },
      },
    );
  } else {
    errorNotificationService.showWarning(
      'No matching project',
      `None of your projects belongs to the team that owns this ${notice.kind === 'shared-folder' ? 'folder' : 'document'}.`,
      { duration: 8000 },
    );
  }
  console.warn('[DeepLink] Could not open link:', notice);
}

async function drainNotices(): Promise<void> {
  try {
    const notices = await window.electronAPI.invoke(DEEP_LINK_CONSUME_NOTICES_CHANNEL) as DeepLinkNotice[];
    for (const notice of notices ?? []) showNotice(notice);
  } catch (err) {
    console.error('[DeepLink] Failed to consume deep-link notices:', err);
  }
}

export function initDeepLinkNoticeListeners(): () => void {
  const unsubscribe = window.electronAPI.on(DEEP_LINK_NOTICE_AVAILABLE_CHANNEL, () => {
    void drainNotices();
  });
  void drainNotices();
  return unsubscribe;
}
