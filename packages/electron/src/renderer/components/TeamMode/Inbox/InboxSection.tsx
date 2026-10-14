import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useAtom, useStore } from 'jotai';

import { InboxContextPane } from './InboxContextPane';
import { FeedbackRequestSurface } from '../../FeedbackRequest/FeedbackRequestSurface';
import { InboxContextSlot } from './InboxContextSlot';
import { InboxEmptyState, InboxOfflineWithoutCache } from './InboxEmptyState';
import { InboxFilterBar } from './InboxFilterBar';
import { InboxRow } from './InboxRow';
import { InboxSearchEscalation, InboxSearchField } from './InboxSearchField';
import { InboxSkeleton } from './InboxSkeleton';
import { InboxStatusBanner } from './InboxStatusBanner';
import { InboxStatePicker } from './InboxStatePicker';
import { DEFAULT_INBOX_PREFERENCES, persistInboxPreferences, readInboxPreferences } from './inboxPreferences';
import {
  consumeInboxRowSelectionRequest,
  consumeInboxSearchFocusRequest,
  subscribeInboxRowSelection,
  subscribeInboxSearchFocus,
  type InboxRowSelectionRequest,
} from '../orgWindowCommandBus';
import {
  ORG_WINDOW_SURFACE_ID,
  isUntouchedOrgWindowRoute,
  orgWindowInboxFilterAtomFamily,
  orgWindowRouteAtomFamily,
} from '../orgWindowState';
import { useInboxProvider, type InboxProvider } from './inboxProvider';
import {
  deriveScopeOptions,
  groupRows,
  inboxFilterLabel,
  isScopeActive,
  openRow,
  scopeWithinOrg,
  selectRows,
} from './inboxViewModel';
import { DEFAULT_INBOX_FILTER, EMPTY_INBOX_SCOPE, type InboxRowView, type InboxScope, type InboxSubscriptionState } from './inboxTypes';

/** How often relative timestamps re-render in the absence of any data change. */
const RELATIVE_LABEL_TICK_MS = 60_000;

/**
 * The messaging Inbox — the first section of the organization-management window.
 *
 * Reads exclusively from an `InboxProvider` and renders only `InboxRowView`s
 * produced by `toRowView`, which is what keeps an unavailable delivery from
 * leaking its former source. With no provider mounted above it, the surface
 * shows an empty inbox — fixtures only arrive when a caller injects them.
 *
 * Layout: list plus a right-hand context pane the user sizes by dragging its
 * divider (width persisted per user). The pane collapses only once the surface
 * is too narrow to hold both it and a readable list.
 */
export function InboxSection({
  surfaceId = ORG_WINDOW_SURFACE_ID,
  provider: providerProp,
  workspacePath,
  restrictToOrgId,
  now: nowProp,
  onBrowseRooms,
  onNewMessage,
  composeUnavailableLabel = 'Compose is available in the organization window',
}: {
  /** Mounted surface whose imperative command latches this Inbox consumes. */
  surfaceId?: string;
  provider?: InboxProvider;
  /** Workspace whose team JWT and local feedback projection back this inbox. */
  workspacePath?: string;
  /**
   * Show only this organization's deliveries.
   *
   * Set by a surface that belongs to exactly one organization — Org mode inside
   * a project window, which renders under that organization's header and whose
   * rows open into that project's context. Deliberately absent in the
   * standalone organization window, which is the cross-org surface: the two
   * behave differently, and the difference is stated here at the call site
   * rather than inferred from the chrome further down.
   */
  restrictToOrgId?: string;
  /** Deterministic clock seam for grouping and relative-label tests. */
  now?: number;
  /**
   * Where "Browse rooms" goes. Supplied by the org window, which owns the
   * rooms directory; absent when the Inbox is mounted without one.
   */
  onBrowseRooms?: () => void;
  /**
   * Opens the compose destination picker. Supplied by the org window, which
   * owns the conversation directory the picker lists; the control renders
   * disabled without it rather than doing nothing when clicked.
   */
  onNewMessage?: () => void;
  /**
   * Why compose is unavailable, when it is. The default speaks to the project
   * window; the org window overrides it when the organization turned messaging
   * off, where "open the organization window" would be nonsense advice.
   */
  composeUnavailableLabel?: string;
} = {}) {
  const provider = useInboxProvider(providerProp);

  const snapshot = useSyncExternalStore(provider.subscribe, provider.getSnapshot, provider.getSnapshot);

  // The reason axis is the sidebar's Inbox rows, and one navigation moves both:
  // there is no second copy of the filter here to fall out of step with them.
  const [filter, setFilter] = useAtom(orgWindowInboxFilterAtomFamily(surfaceId));
  const store = useStore();
  const [unreadOnly, setUnreadOnly] = useState<boolean>(DEFAULT_INBOX_PREFERENCES.unreadOnly);
  const [scope, setScope] = useState<InboxScope>(DEFAULT_INBOX_PREFERENCES.scope);
  const [contextPaneWidth, setContextPaneWidth] = useState<number>(DEFAULT_INBOX_PREFERENCES.contextPaneWidth);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const preferencesLoaded = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSelectionRef = useRef<InboxRowSelectionRequest | null>(null);
  const [selectionRequestTick, setSelectionRequestTick] = useState(0);
  /** A linked feedback request with no delivery for this reader, shown in the pane. */
  const [linkedRequest, setLinkedRequest] = useState<{ orgId: string; requestId: string } | null>(null);

  // Messages > Search Messages. The command routes the window to the Inbox
  // first, so it may well arrive before this surface exists — hence the latched
  // request, consumed either on mount or on notification, whichever comes second.
  useEffect(() => {
    const focusSearch = () => {
      if (!consumeInboxSearchFocusRequest(surfaceId)) return;
      const input = searchInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    return subscribeInboxSearchFocus(surfaceId, focusSearch);
  }, [surfaceId]);

  // A deep link (`nimbalyst://feedback-request/...`) names a source, not a
  // delivery, and may arrive before this surface exists or before the inbox has
  // synced. Latch the request here; the effect below resolves it against every
  // snapshot until the delivery shows up.
  useEffect(() => {
    const latch = () => {
      const pending = consumeInboxRowSelectionRequest(surfaceId);
      if (!pending) return;
      pendingSelectionRef.current = pending;
      setSelectionRequestTick((value) => value + 1);
    };
    latch();
    return subscribeInboxRowSelection(surfaceId, latch);
  }, [surfaceId]);

  useEffect(() => {
    // A quiet inbox still ages: without a tick, "12m" would sit there until the
    // next delivery arrived. One coarse tick a minute matches the finest
    // granularity `formatRelativeTimestamp` renders.
    if (nowProp !== undefined) return;
    const timer = setInterval(() => setTick((value) => value + 1), RELATIVE_LABEL_TICK_MS);
    return () => clearInterval(timer);
  }, [nowProp]);

  // `now` is frozen per render pass so relative labels and day grouping stay
  // stable while the user types; the provider re-renders on real changes.
  const now = useMemo(() => nowProp ?? Date.now(), [nowProp, snapshot, tick]);

  useEffect(() => {
    let cancelled = false;
    void readInboxPreferences().then((preferences) => {
      if (cancelled) return;
      // The remembered row is only restored onto a surface nothing has pointed
      // anywhere yet. A deep link — or the user, while this read was in flight
      // — has already chosen a row, and a stored preference must not overrule
      // it after the fact.
      if (isUntouchedOrgWindowRoute(store.get(orgWindowRouteAtomFamily(surfaceId)))) {
        setFilter(preferences.filter);
      }
      setUnreadOnly(preferences.unreadOnly);
      setScope(preferences.scope);
      setContextPaneWidth(preferences.contextPaneWidth);
      preferencesLoaded.current = true;
    });
    return () => { cancelled = true; };
  }, [setFilter, store, surfaceId]);

  useEffect(() => {
    // Don't write back the defaults before the stored value has been read.
    if (!preferencesLoaded.current) return;
    // `contextPaneWidth` only changes when a drag ends, so this stays one write
    // per resize rather than one per pointermove.
    void persistInboxPreferences({ filter, unreadOnly, scope, contextPaneWidth });
  }, [filter, unreadOnly, scope, contextPaneWidth]);

  const loading = snapshot.status === 'loading';
  const offline = snapshot.status === 'offlineWithCache' || snapshot.status === 'offlineWithoutCache';
  const offlineWithoutCache = snapshot.status === 'offlineWithoutCache';

  const { rows, scoped, unreadInScope, typeCounts } = useMemo(
    () => selectRows({
      deliveries: snapshot.deliveries,
      filter,
      unreadOnly,
      scope,
      query,
      now,
      stalePreviews: offline,
      restrictToOrgId,
    }),
    [snapshot.deliveries, filter, unreadOnly, scope, query, now, offline, restrictToOrgId],
  );

  // What the controls must show, which is what the list actually applied — a
  // checkbox reading "only Acme" above a list pinned to Globex is worse than no
  // control at all.
  const effectiveScope = useMemo(
    () => scopeWithinOrg(scope, restrictToOrgId, snapshot.deliveries),
    [restrictToOrgId, scope, snapshot.deliveries],
  );

  const scopeOptions = useMemo(
    () => deriveScopeOptions(snapshot.deliveries, restrictToOrgId),
    [restrictToOrgId, snapshot.deliveries],
  );
  const groups = useMemo(() => groupRows(rows, now), [rows, now]);
  const selectedRow = useMemo(() => rows.find((row) => row.id === selectedId) ?? null, [rows, selectedId]);
  const filterLabel = inboxFilterLabel(filter);

  // Selecting is free: it fills the context pane and never moves you. Every
  // navigation is an explicit second act, so a click is safe to spend on
  // reading a row you are not sure about.
  const handleSelect = useCallback((row: InboxRowView) => {
    // An explicit choice ends any link still waiting for its delivery; a later
    // sync must not take the selection back.
    pendingSelectionRef.current = null;
    setSelectedId(row.id);
    setLinkedRequest(null);
    setActivationNotice(null);
  }, []);

  const handleOpen = useCallback(async (row: InboxRowView) => {
    pendingSelectionRef.current = null;
    setSelectedId(row.id);
    setLinkedRequest(null);
    setActivationNotice(null);
    const result = await openRow(row, {
      navigate: (target) => provider.navigate(target),
      markRead: (id) => provider.markRead([id]),
    });
    if (result.outcome === 'navigationFailed') {
      // Read state is the user's record of what they have actually seen. A
      // failed open must not consume it.
      setActivationNotice('Could not open that conversation. It stays unread.');
    }
  }, [provider]);

  const handleMarkAllRead = useCallback(() => {
    // Scoped to the active filter, per the plan; the search query does not
    // narrow it, so nothing silently escapes the batch.
    void provider.markRead(scoped.filter((row) => row.unread).map((row) => row.id));
  }, [provider, scoped]);

  const handleSubscription = useCallback((row: InboxRowView, state: InboxSubscriptionState) => {
    // The control is hidden when the provider cannot mute, so this is a residual
    // path only; a rejection must not surface as an unhandled rejection.
    void provider.setSubscriptionState?.(row.id, state).catch(() => undefined);
  }, [provider]);

  /**
   * The stored scope is one per user, not one per surface. A pinned surface
   * never shows the org axis, so it must not silently overwrite the choice the
   * organization window made on it either — it carries the stored value through
   * untouched and narrows only the axes it can actually see.
   */
  const applyScope = useCallback((next: InboxScope) => {
    setScope((current) => (restrictToOrgId ? { ...next, orgIds: current.orgIds } : next));
  }, [restrictToOrgId]);

  const clearFilters = useCallback(() => {
    // Clearing the reason axis is a navigation now — the sidebar row moves with
    // the list, which is the whole point of the filter living in the route.
    setFilter(DEFAULT_INBOX_FILTER);
    setUnreadOnly(false);
    applyScope(EMPTY_INBOX_SCOPE);
    setQuery('');
  }, [applyScope, setFilter]);

  useEffect(() => {
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    // A link into another organization is not this surface's to open: selecting
    // it would mount the context pane on a row the list cannot show, in the
    // wrong project's context. Dropped rather than latched forever.
    if (restrictToOrgId && pending.orgId !== restrictToOrgId) {
      pendingSelectionRef.current = null;
      return;
    }
    const delivery = snapshot.deliveries.find((entry) =>
      entry.source.orgId === pending.orgId
      && entry.source.sourceKind === pending.sourceKind
      && entry.source.sourceId === pending.sourceId);
    if (!delivery) {
      // Any org member may open a feedback request; only its recipients hold a
      // delivery. Once the inbox has loaded, show the request itself, and keep
      // the latch so a delivery that syncs later still takes the selection.
      if (pending.sourceKind === 'feedbackRequest' && snapshot.status !== 'loading') {
        setSelectedId(null);
        setLinkedRequest((current) => (current?.requestId === pending.sourceId && current.orgId === pending.orgId
          ? current
          : { orgId: pending.orgId, requestId: pending.sourceId }));
      }
      return;
    }
    pendingSelectionRef.current = null;
    setSelectedId(delivery.id);
    setLinkedRequest(null);
    setActivationNotice(null);
    // Landing on a row the filter in force hides would show an empty pane,
    // which is the exact failure the link exists to avoid. Clearing writes the
    // preferences back — deliberately: the inbox is left in the state that
    // shows what the recipient was sent.
    if (!rows.some((row) => row.id === delivery.id)) clearFilters();
  }, [clearFilters, restrictToOrgId, rows, selectionRequestTick, snapshot.deliveries, snapshot.status]);

  return (
    <section
      className="inbox-surface flex h-full min-h-0 flex-col [container-name:inbox-surface] [container-type:inline-size]"
      data-testid="inbox-surface"
      data-component="InboxSection"
      data-source="packages/electron/src/renderer/components/TeamMode/Inbox/InboxSection.tsx"
      data-status={snapshot.status}
    >
      <header
        className="inbox-header org-window-drag-region shrink-0 border-b border-[var(--nim-border)] px-5 py-4"
        data-window-drag-region="true"
      >
        <div className="inbox-header-title flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-semibold text-[var(--nim-text)]">Inbox</h2>
          {unreadInScope > 0 && (
            <span
              className="inbox-header-unread rounded-full bg-[var(--nim-primary)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--nim-on-primary)]"
              data-testid="inbox-header-unread"
            >
              {unreadInScope}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              className="inbox-mark-all-read org-window-no-drag rounded-md border border-[var(--nim-border)] px-2.5 py-1 text-[12px] text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] disabled:cursor-not-allowed disabled:text-[var(--nim-text-disabled)]"
              data-testid="inbox-mark-all-read"
              disabled={loading || unreadInScope === 0}
              title={`Mark everything in ${filterLabel} as read`}
              onClick={handleMarkAllRead}
            >
              Mark {filterLabel.toLowerCase()} read
            </button>
            <button
              type="button"
              className="inbox-new-message org-window-no-drag flex items-center gap-1.5 rounded-md bg-[var(--nim-primary)] px-2.5 py-1 text-[12px] text-[var(--nim-on-primary)] hover:bg-[var(--nim-primary-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              data-testid="inbox-new-message"
              disabled={!onNewMessage}
              title={onNewMessage
                ? 'Write to a room or a person'
                : composeUnavailableLabel}
              onClick={onNewMessage}
            >
              <MaterialSymbol icon="edit_square" size={14} /> New message
            </button>
          </div>
        </div>

        {/* The beta disclosure is the org window's bottom status bar now
            (2026-07-28 layout decision) — two lines of it above every Inbox
            was the thing being replaced. */}
        <div className="inbox-controls org-window-no-drag mt-3 flex flex-col gap-2">
          <InboxSearchField value={query} filterLabel={filterLabel} disabled={loading} inputRef={searchInputRef} onChange={setQuery} />
          <InboxFilterBar
            unreadOnly={unreadOnly}
            unreadCount={unreadInScope}
            typeCounts={typeCounts}
            scope={effectiveScope}
            scopeOptions={scopeOptions}
            disabled={loading}
            onUnreadOnlyChange={setUnreadOnly}
            onScopeChange={applyScope}
          />
        </div>
      </header>

      <InboxStatusBanner status={snapshot.status} lastSyncedAt={snapshot.lastSyncedAt} now={now} />

      {snapshot.unavailableOrganizations?.map((organization) => (
        <div
          key={organization.orgId}
          className="inbox-organization-unavailable flex items-center gap-3 border-b border-[var(--nim-border)] bg-[color-mix(in_srgb,var(--nim-warning)_10%,transparent)] px-5 py-2.5 text-[12px] text-[var(--nim-text)]"
          data-testid={`inbox-organization-unavailable-${organization.orgId}`}
          data-org-id={organization.orgId}
        >
          <MaterialSymbol icon="encrypted_off" size={15} />
          <span className="min-w-0 flex-1">
            Messaging is not available for {organization.orgName}. Migrate this organization to server-managed encryption to enable it.
          </span>
          <button
            type="button"
            className="inbox-organization-migrate shrink-0 rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2.5 py-1 text-[12px] hover:bg-[var(--nim-bg-hover)]"
            onClick={() => {
              void provider.migrateOrganization(organization.orgId);
            }}
          >
            Migrate organization
          </button>
        </div>
      ))}

      {activationNotice && (
        <p
          className="inbox-activation-notice m-0 flex items-center gap-1.5 border-b border-[var(--nim-border)] bg-[color-mix(in_srgb,var(--nim-error)_10%,transparent)] px-5 py-2 text-[12px] text-[var(--nim-text)]"
          data-testid="inbox-activation-notice"
          role="status"
        >
          <MaterialSymbol icon="error" size={14} /> {activationNotice}
        </p>
      )}

      <div className="inbox-body flex min-h-0 flex-1">
        <div className="inbox-list-pane min-w-0 flex-1 overflow-y-auto" data-testid="inbox-list-pane">
          {loading && <InboxSkeleton />}

          {!loading && offlineWithoutCache && <InboxOfflineWithoutCache />}

          {!loading && !offlineWithoutCache && rows.length === 0 && (
            <InboxEmptyState
              filter={filter}
              unreadOnly={unreadOnly}
              query={query}
              scopeActive={isScopeActive(effectiveScope)}
              onClearFilters={clearFilters}
              onBrowse={onBrowseRooms}
            >
              {query ? <InboxSearchEscalation query={query} matchCount={0} onEscalate={() => { /* federated search lands in Phase 4 */ }} /> : null}
            </InboxEmptyState>
          )}

          {!loading && !offlineWithoutCache && rows.length > 0 && (
            <div className="inbox-list" data-testid="inbox-list" role="list">
              {groups.map((group) => (
                <div key={group.id} className="inbox-list-group" data-testid={`inbox-group-${group.id}`}>
                  <div className="inbox-list-group-label sticky top-0 z-[1] bg-[var(--nim-bg)] px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)]">
                    {group.label}
                  </div>
                  {group.rows.map((row) => (
                    <InboxRow
                      key={row.id}
                      row={row}
                      selected={row.id === selectedId}
                      onSelect={handleSelect}
                      onOpen={(target) => { void handleOpen(target); }}
                      onDismiss={(target) => { void provider.dismiss(target.id); }}
                    />
                  ))}
                </div>
              ))}

              {query && (
                <div className="inbox-list-escalation border-t border-[var(--nim-border)] px-4 py-3">
                  <InboxSearchEscalation query={query} matchCount={rows.length} onEscalate={() => { /* federated search lands in Phase 4 */ }} />
                </div>
              )}
            </div>
          )}
        </div>

        <InboxContextSlot width={contextPaneWidth} onWidthChange={setContextPaneWidth}>
          {linkedRequest && !selectedRow && workspacePath ? (
            <aside
              className="inbox-context-pane inbox-linked-feedback-request flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto border-l border-[var(--nim-border)] p-3"
              data-testid="inbox-linked-feedback-request"
            >
              {/* No delivery means no server-resolved comment capability, so
                  the discussion is read-only. Answering needs none: the
                  surface offers it only to a viewer the request assigns asks
                  to, and the server attributes it to the signed-in member. */}
              <FeedbackRequestSurface
                workspacePath={workspacePath}
                orgId={linkedRequest.orgId}
                requestId={linkedRequest.requestId}
                canComment={false}
              />
            </aside>
          ) : (
          <InboxContextPane
            row={selectedRow}
            workspacePath={workspacePath}
            conversationTransport={provider.conversationTransport === true}
            canChangeSubscription={provider.setSubscriptionState !== undefined}
            onSubscriptionChange={handleSubscription}
            onOpenSource={(row) => { void handleOpen(row); }}
          />
          )}
        </InboxContextSlot>
      </div>

      {provider.simulateStatus && (
        <InboxStatePicker status={snapshot.status} onChange={(status) => provider.simulateStatus?.(status)} />
      )}
    </section>
  );
}
