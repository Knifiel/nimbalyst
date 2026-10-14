import type { JSX } from 'react';
import type { TokenSuggestion } from '../trackers/trackerFilterTokens';
import {
  FloatingPortal,
  useTrackerFloatingMenu,
} from './useTrackerFloatingMenu';

export interface TrackerFilterOmniboxMenuProps {
  reference: HTMLElement;
  suggestions: TokenSuggestion[];
  highlightIndex: number | null;
  onHighlight: (index: number) => void;
  onApply: (suggestion: TokenSuggestion) => void;
  onClose: () => void;
}

/** Floating suggestion list loaded after the eager search input receives intent. */
export function TrackerFilterOmniboxMenu({
  reference,
  suggestions,
  highlightIndex,
  onHighlight,
  onApply,
  onClose,
}: TrackerFilterOmniboxMenuProps): JSX.Element {
  const menu = useTrackerFloatingMenu({
    placement: 'bottom-start',
    reference,
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });

  return (
    <FloatingPortal>
      <div
        ref={menu.refs.setFloating}
        id="tracker-filter-omnibox-menu"
        className="tracker-filter-omnibox-menu z-[100] overflow-y-auto rounded border border-nim bg-nim-secondary shadow-lg"
        style={{
          ...menu.floatingStyles,
          width: Math.max(reference.offsetWidth, 240),
        }}
        data-testid="tracker-filter-omnibox-menu"
        {...menu.getFloatingProps()}
      >
        {suggestions.map((suggestion, index) => {
          const previous = suggestions[index - 1];
          return (
            <div key={suggestion.id}>
              {suggestion.section !== previous?.section && (
                <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-nim-faint">
                  {suggestion.section}
                </div>
              )}
              <button
                type="button"
                className={`flex w-full items-center gap-2 px-2 py-1 text-left text-[12px] transition-colors ${
                  index === highlightIndex
                    ? 'bg-[var(--nim-bg-tertiary)] text-nim'
                    : 'text-nim-muted hover:bg-[var(--nim-bg-tertiary)]'
                }`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onApply(suggestion);
                }}
                onMouseEnter={() => onHighlight(index)}
                data-testid={`tracker-filter-omnibox-option-${suggestion.id}`}
                data-selected={index === highlightIndex ? 'true' : undefined}
              >
                <span className="min-w-0 flex-1 truncate">
                  {suggestion.label}
                </span>
                {suggestion.detail && (
                  <span className="shrink-0 text-[10px] text-nim-faint">
                    {suggestion.detail}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </FloatingPortal>
  );
}
