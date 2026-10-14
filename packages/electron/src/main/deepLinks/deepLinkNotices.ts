/**
 * Queue for deep links main could not route (see `shared/deepLinkNotices.ts`).
 *
 * A notice sent straight to a window was lost on a cold start (the renderer was
 * not listening yet) and when no project window was open. Every notice is held
 * here instead; the target window gets a bare nudge, and any renderer that
 * mounts drains the queue. With no window at all the Project Manager opens and
 * drains it.
 */
import {
  DEEP_LINK_NOTICE_AVAILABLE_CHANNEL,
  type DeepLinkNotice,
} from '../../shared/deepLinkNotices';

interface NoticeWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  webContents: { send(channel: string): void };
}

export interface DeepLinkNoticeQueueDeps {
  /** The most recent project window, else the Project Manager, else null. */
  targetWindow(): NoticeWindow | null;
  openProjectManager(): void;
}

export function createDeepLinkNoticeQueue(deps: DeepLinkNoticeQueueDeps) {
  let pending: DeepLinkNotice[] = [];

  return {
    deliver(notice: DeepLinkNotice): void {
      pending.push(notice);
      const target = deps.targetWindow();
      if (!target || target.isDestroyed()) {
        deps.openProjectManager();
        return;
      }
      if (target.isMinimized()) target.restore();
      target.focus();
      target.webContents.send(DEEP_LINK_NOTICE_AVAILABLE_CHANNEL);
    },

    /** Every held notice, once. */
    consume(): DeepLinkNotice[] {
      const drained = pending;
      pending = [];
      return drained;
    },
  };
}

export type DeepLinkNoticeQueue = ReturnType<typeof createDeepLinkNoticeQueue>;
