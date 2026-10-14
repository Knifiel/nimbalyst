/**
 * TrackerFilterOmnibox - the one search box Tracker Mode uses everywhere.
 *
 * Greg's ask: "I want to share the text filter we use in the other view, but I
 * want to add typeahead menus to get the full power of the filter dropdown, all
 * from the keyboard input." So this box is not a second filter: it drives the
 * *same* `searchQuery` the toolbar search drove and writes into the *same*
 * persisted column-filter set the filter dropdown writes, and adds a typed
 * grammar (`trackerFilterTokens.ts`) on top so every field, operator, and value
 * in that dropdown is reachable without leaving the keyboard.
 *
 * It is mounted twice -- in the main toolbar and above the document-view list
 * pane -- differing only by `className` and `showPills`, so both surfaces behave
 * identically. `#tag` completion is part of the grammar because the toolbar box
 * it replaced had it; tags stay their own filter list (not clauses) so the
 * existing tag chips keep working.
 *
 * The input's text is `searchQuery` plus, when one is being composed, a trailing
 * filter token. Committing the token turns it into a pill and hands the clause
 * to the shared filter set; the search text it was appended to is untouched.
 */

import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  isClauseComplete,
  OP_LABELS,
  UNARY_OPS,
  withFieldClauses,
  type TrackerFieldFilter,
  type TrackerFilterSet,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import type { TrackerFilterField } from './trackerFilterFields';
import {
  buildTokenSuggestions,
  draftToClause,
  parseOmniboxInput,
  serializeClause,
  type TagTokenOption,
  type TokenSuggestion,
} from '../trackers/trackerFilterTokens';

const loadTrackerFilterOmniboxMenu = () => import('./TrackerFilterOmniboxMenu');
const TrackerFilterOmniboxMenu = lazy(() =>
  loadTrackerFilterOmniboxMenu().then((module) => ({
    default: module.TrackerFilterOmniboxMenu,
  }))
);

export const TRACKER_FOCUS_SEARCH_EVENT = 'nimbalyst:tracker-focus-search';

export function dispatchTrackerFocusSearch(): void {
  window.dispatchEvent(new CustomEvent(TRACKER_FOCUS_SEARCH_EVENT));
}

export interface TrackerFilterOmniboxProps {
  /** The shared free-text query. Same state the toolbar search input drives. */
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  /** Filterable fields, with option counts, as built for the filter dropdown. */
  fields: TrackerFilterField[];
  /** The persisted per-type column filters. */
  filters: TrackerFilterSet | null;
  onFiltersChange: (filters: TrackerFilterSet) => void;
  /** Tags offered after `#`, with the active ones already removed. */
  tagOptions?: TagTokenOption[];
  /** Tags currently filtering the view. Their own list, not filter clauses. */
  tagFilter?: string[];
  onTagFilterChange?: (tags: string[]) => void;
  /**
   * Whether the box renders its own filter pills. The main toolbar has its own
   * horizontal pill row beside it, so it opts out -- one set of pills, not two.
   */
  showPills?: boolean;
  /** Draw the pills inside the box, before the text, instead of in a row below it. */
  inlinePills?: boolean;
  /**
   * Clicking a field pill calls this instead of pulling the pill back into the
   * text. Returning `false` declines, and the pill is pulled back as usual.
   */
  onPillClick?: (clauseIndex: number, clause: TrackerFieldFilter) => boolean | void;
  /** Controls drawn at the right end of an inline-pills box, before its clear button. */
  trailing?: ReactNode;
  /** Layout for the surface this instance sits on (width, padding, borders). */
  className?: string;
  placeholder?: string;
  /** `large` for a page whose main control is this box (Pages search); `default` for toolbars. */
  size?: 'default' | 'large';
}

function pillLabel(
  clause: TrackerFieldFilter,
  fields: TrackerFilterField[]
): { field: string; op: string; value: string } {
  const field = fields.find((candidate) => candidate.id === clause.field);
  const values = (Array.isArray(clause.value) ? clause.value : [clause.value])
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => {
      const text = String(value);
      return (
        field?.options?.find((option) => option.value === text)?.label ?? text
      );
    });
  return {
    field: field?.label ?? clause.field,
    op: OP_LABELS[clause.op],
    value: UNARY_OPS.has(clause.op)
      ? ''
      : clause.op === 'in-last' || clause.op === 'not-in-last'
      ? `${values.join(', ')} days`
      : values.join(', '),
  };
}

export function TrackerFilterOmnibox({
  searchQuery,
  onSearchQueryChange,
  fields,
  filters,
  onFiltersChange,
  tagOptions,
  tagFilter,
  onTagFilterChange,
  showPills = true,
  inlinePills = false,
  onPillClick,
  trailing,
  className = '',
  placeholder = 'Search, # for tags, or a field name to filter…',
  size = 'default',
}: TrackerFilterOmniboxProps): JSX.Element {
  const large = size === 'large';
  // The token under composition. Everything before it is `searchQuery`, so the
  // two together are exactly what the input shows.
  const [draftToken, setDraftToken] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  const setInputNode = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
  }, []);

  const inputValue = searchQuery + draftToken;
  const parsed = useMemo(
    () => parseOmniboxInput(inputValue, fields),
    [inputValue, fields]
  );
  const suggestions = useMemo(
    () =>
      menuOpen
        ? buildTokenSuggestions(parsed.draft, fields, { tagOptions })
        : [],
    [menuOpen, parsed.draft, fields, tagOptions]
  );
  const activeTags = tagFilter ?? [];

  const activeClauses = useMemo(
    () =>
      (filters?.clauses ?? [])
        .map((clause, index) => ({ clause, index }))
        .filter(({ clause }) => isClauseComplete(clause)),
    [filters]
  );

  // Keep the highlight inside the list as it shrinks under the user's typing.
  useLayoutEffect(() => {
    setHighlightIndex((current) => {
      if (current === null) return null;
      if (suggestions.length === 0) return null;
      return Math.min(current, suggestions.length - 1);
    });
  }, [suggestions.length]);

  // Cmd+F (Edit > Find, routed by content mode) lands here. Selecting the text
  // matches every other find box: the next keystroke starts a new search rather
  // than appending to whatever the box was last filtered by.
  useEffect(() => {
    const focusSearch = () => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.select();
    };
    window.addEventListener(TRACKER_FOCUS_SEARCH_EVENT, focusSearch);
    return () =>
      window.removeEventListener(TRACKER_FOCUS_SEARCH_EVENT, focusSearch);
  }, []);

  const applyInput = useCallback(
    (value: string, autoHighlight: boolean) => {
      const next = parseOmniboxInput(value, fields);
      const isToken = next.draft.stage !== 'field';
      setDraftToken(isToken ? next.draft.raw : '');
      onSearchQueryChange(isToken ? next.searchText : value);
      setMenuOpen(true);
      // A colon means the user asked for the filter language, so the first row is
      // pre-selected and Enter commits it. A bare word is still plain search text,
      // so nothing is selected until they press Down or Tab -- otherwise Enter
      // would hijack ordinary typing.
      setHighlightIndex(autoHighlight && isToken ? 0 : null);
    },
    [fields, onSearchQueryChange]
  );

  /**
   * The search text once the draft token is taken out of the input.
   *
   * A field-stage word is still part of the search text while it is being
   * typed, so accepting a suggestion has to reclaim it -- otherwise "auth stat"
   * plus the Status suggestion would leave "auth stat" behind in the query.
   */
  const searchTextWithoutToken = inputValue.slice(0, parsed.tokenStart);

  const commitClause = useCallback(
    (clause: TrackerFieldFilter) => {
      // Replace rather than append this field's clauses, matching the filter
      // dropdown -- two clauses on one field read as an unsatisfiable AND.
      onFiltersChange(withFieldClauses(filters, clause.field, [clause]));
      onSearchQueryChange(searchTextWithoutToken);
      setDraftToken('');
      setMenuOpen(false);
      setHighlightIndex(null);
      inputRef.current?.focus();
    },
    [filters, onFiltersChange, onSearchQueryChange, searchTextWithoutToken]
  );

  const addTag = useCallback(
    (tag: string) => {
      if (!activeTags.includes(tag)) onTagFilterChange?.([...activeTags, tag]);
      onSearchQueryChange(searchTextWithoutToken);
      setDraftToken('');
      setMenuOpen(false);
      setHighlightIndex(null);
      inputRef.current?.focus();
    },
    [activeTags, onSearchQueryChange, onTagFilterChange, searchTextWithoutToken]
  );

  const removeTag = useCallback(
    (tag: string) => {
      onTagFilterChange?.(activeTags.filter((candidate) => candidate !== tag));
    },
    [activeTags, onTagFilterChange]
  );

  const applySuggestion = useCallback(
    (suggestion: TokenSuggestion) => {
      if (suggestion.tag) {
        addTag(suggestion.tag);
        return;
      }
      if (suggestion.clause) {
        commitClause(suggestion.clause);
        return;
      }
      if (suggestion.insertText !== undefined) {
        onSearchQueryChange(searchTextWithoutToken);
        setDraftToken(suggestion.insertText);
        setMenuOpen(true);
        setHighlightIndex(0);
        inputRef.current?.focus();
      }
    },
    [addTag, commitClause, onSearchQueryChange, searchTextWithoutToken]
  );

  const removeClause = useCallback(
    (index: number) => {
      onFiltersChange({
        combinator: filters?.combinator ?? 'and',
        clauses: (filters?.clauses ?? []).filter(
          (_, position) => position !== index
        ),
      });
    },
    [filters, onFiltersChange]
  );

  /** Pull a pill back into the input so it can be retyped instead of rebuilt. */
  const editClause = useCallback(
    (clause: TrackerFieldFilter, index: number) => {
      removeClause(index);
      setDraftToken(serializeClause(clause, fields));
      setMenuOpen(true);
      setHighlightIndex(0);
      inputRef.current?.focus();
    },
    [fields, removeClause]
  );

  const clearAll = useCallback(() => {
    setDraftToken('');
    onSearchQueryChange('');
    onFiltersChange({ combinator: filters?.combinator ?? 'and', clauses: [] });
    if (activeTags.length > 0) onTagFilterChange?.([]);
    setMenuOpen(false);
    setHighlightIndex(null);
  }, [
    activeTags.length,
    filters?.combinator,
    onFiltersChange,
    onSearchQueryChange,
    onTagFilterChange,
  ]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        if (suggestions.length === 0 && !menuOpen) setMenuOpen(true);
        event.preventDefault();
        setHighlightIndex((current) =>
          current === null
            ? 0
            : Math.min(current + 1, Math.max(suggestions.length - 1, 0))
        );
        return;
      }
      if (event.key === 'ArrowUp') {
        if (highlightIndex === null) return;
        event.preventDefault();
        setHighlightIndex((current) =>
          current === null || current === 0 ? null : current - 1
        );
        return;
      }
      if (event.key === 'Tab') {
        const target = suggestions[highlightIndex ?? 0];
        if (!target) return;
        event.preventDefault();
        applySuggestion(target);
        return;
      }
      if (event.key === 'Enter') {
        const target =
          highlightIndex === null ? null : suggestions[highlightIndex];
        if (target) {
          event.preventDefault();
          applySuggestion(target);
          return;
        }
        // No row selected: a fully typed token still commits, so someone who knows
        // the grammar never has to look at the menu.
        const clause = draftToClause(parsed.draft);
        if (clause) {
          event.preventDefault();
          commitClause(clause);
        }
        return;
      }
      if (event.key === 'Escape') {
        if (menuOpen) {
          event.preventDefault();
          event.stopPropagation();
          setMenuOpen(false);
          setHighlightIndex(null);
          return;
        }
        if (draftToken) {
          event.preventDefault();
          event.stopPropagation();
          setDraftToken('');
        }
        return;
      }
      if (event.key === 'Backspace' && inputValue === '') {
        // Tags first: that is what Backspace did in the box this replaced, and
        // someone who has just typed `#ui` expects it back.
        if (activeTags.length > 0) {
          event.preventDefault();
          removeTag(activeTags[activeTags.length - 1]);
          return;
        }
        if (activeClauses.length > 0) {
          event.preventDefault();
          removeClause(activeClauses[activeClauses.length - 1].index);
        }
      }
    },
    [
      activeClauses,
      activeTags,
      applySuggestion,
      commitClause,
      draftToken,
      highlightIndex,
      inputValue,
      menuOpen,
      parsed.draft,
      removeClause,
      removeTag,
      suggestions,
    ]
  );

  const hasAnything =
    inputValue.length > 0 || activeClauses.length > 0 || activeTags.length > 0;

  const hasPills = activeClauses.length > 0 || activeTags.length > 0;
  const pillSize = large && inlinePills ? 'h-6 text-[12px]' : 'h-5 text-[10px]';
  const pillIcon = large && inlinePills ? 12 : 10;
  const pills = (
    <>
      {activeTags.map((tag) => (
        <button
          key={`tag-${tag}`}
          type="button"
          className={`tracker-filter-omnibox-tag-chip flex ${pillSize} shrink-0 items-center gap-1 rounded-full border border-blue-400/30 bg-blue-400/[0.12] px-1.5 text-blue-400 hover:bg-blue-400/[0.18]`}
          onClick={() => removeTag(tag)}
          title={`Remove #${tag} filter`}
          data-testid={`tracker-filter-omnibox-tag-chip-${tag}`}
        >
          #{tag}
          <MaterialSymbol icon="close" size={pillIcon} />
        </button>
      ))}
      {activeClauses.map(({ clause, index }) => {
        const parts = pillLabel(clause, fields);
        return (
          <div
            key={`${clause.field}-${index}`}
            className={`tracker-filter-omnibox-pill flex ${pillSize} max-w-full items-center overflow-hidden rounded-full border border-nim ${inlinePills ? 'bg-nim-tertiary' : 'bg-nim-secondary'} text-nim-muted`}
            data-testid={`tracker-filter-omnibox-pill-${index}`}
          >
            <button
              type="button"
              className="flex h-full min-w-0 items-center gap-1 px-1.5 hover:bg-nim-tertiary hover:text-nim"
              onClick={() => {
                if (onPillClick?.(index, clause) === false || !onPillClick) editClause(clause, index);
              }}
              title={onPillClick ? 'Edit filters' : `Edit ${serializeClause(clause, fields)}`}
            >
              <span className="shrink-0 font-medium text-nim">
                {parts.field}
              </span>
              <span className="shrink-0 text-nim-faint">{parts.op}</span>
              {parts.value && (
                <span className="truncate">{parts.value}</span>
              )}
            </button>
            <button
              type="button"
              className={`inline-flex h-full ${large && inlinePills ? 'w-5' : 'w-4'} shrink-0 items-center justify-center border-l border-nim text-nim-faint hover:bg-nim-tertiary hover:text-nim`}
              onClick={() => removeClause(index)}
              aria-label={`Remove ${parts.field} filter`}
            >
              <MaterialSymbol icon="close" size={pillIcon} />
            </button>
          </div>
        );
      })}
    </>
  );

  return (
    <div
      className={`tracker-filter-omnibox flex min-w-0 flex-col gap-1 ${className}`}
      data-testid="tracker-filter-omnibox"
    >
      {inlinePills ? (
        <div
          ref={boxRef}
          className={`tracker-filter-omnibox-box flex min-w-0 cursor-text flex-wrap items-center gap-1 border border-nim bg-nim-secondary focus-within:border-[var(--nim-primary)] ${large ? 'min-h-9 rounded-md py-1 pl-3 pr-2' : 'min-h-7 rounded py-0.5 pl-2 pr-1'}`}
          onClick={(event) => {
            if (event.target === event.currentTarget) inputRef.current?.focus();
          }}
        >
          <MaterialSymbol icon="search" size={large ? 18 : 14} className="mr-1 shrink-0 text-nim-faint pointer-events-none" />
          {pills}
          <input
            ref={setInputNode}
            type="text"
            role="combobox"
            aria-expanded={menuOpen && suggestions.length > 0}
            aria-controls="tracker-filter-omnibox-menu"
            aria-label="Search or filter tracker items"
            className={`tracker-filter-omnibox-input min-w-[120px] flex-1 border-none bg-transparent p-0 text-nim placeholder:text-nim-faint focus:outline-none ${large ? 'h-7 text-[13.5px]' : 'text-xs'}`}
            placeholder={hasPills ? undefined : placeholder}
            value={inputValue}
            onChange={(event) => applyInput(event.target.value, true)}
            onPointerEnter={() => {
              void loadTrackerFilterOmniboxMenu();
            }}
            onFocus={() => {
              void loadTrackerFilterOmniboxMenu();
              setMenuOpen(true);
            }}
            onKeyDown={handleKeyDown}
            data-testid="tracker-filter-omnibox-input"
          />
          {trailing}
          {hasAnything && (
            <button
              type="button"
              className="shrink-0 text-nim-faint hover:text-nim"
              onClick={clearAll}
              aria-label="Clear search and filters"
              data-testid="tracker-filter-omnibox-clear"
            >
              <MaterialSymbol icon="close" size={large ? 16 : 13} />
            </button>
          )}
        </div>
      ) : (
      <div className="relative flex-1 min-w-0">
        <MaterialSymbol
          icon="search"
          size={large ? 18 : 14}
          className={`absolute ${large ? 'left-3' : 'left-2'} top-1/2 -translate-y-1/2 text-nim-faint pointer-events-none`}
        />
        <input
          ref={setInputNode}
          type="text"
          role="combobox"
          aria-expanded={menuOpen && suggestions.length > 0}
          aria-controls="tracker-filter-omnibox-menu"
          aria-label="Search or filter tracker items"
          className={`tracker-filter-omnibox-input w-full border border-nim bg-nim-secondary text-nim placeholder:text-nim-faint focus:border-[var(--nim-primary)] focus:outline-none ${large ? 'h-9 rounded-md pl-10 pr-9 text-[13.5px]' : 'rounded py-1 pl-7 pr-6 text-xs'}`}
          placeholder={placeholder}
          value={inputValue}
          onChange={(event) => applyInput(event.target.value, true)}
          onPointerEnter={() => {
            void loadTrackerFilterOmniboxMenu();
          }}
          onFocus={() => {
            void loadTrackerFilterOmniboxMenu();
            setMenuOpen(true);
          }}
          onKeyDown={handleKeyDown}
          data-testid="tracker-filter-omnibox-input"
        />
        {hasAnything && (
          <button
            type="button"
            className={`absolute ${large ? 'right-2.5' : 'right-1'} top-1/2 -translate-y-1/2 text-nim-faint hover:text-nim`}
            onClick={clearAll}
            aria-label="Clear search and filters"
            data-testid="tracker-filter-omnibox-clear"
          >
            <MaterialSymbol icon="close" size={large ? 16 : 13} />
          </button>
        )}
      </div>
      )}

      {showPills && !inlinePills && hasPills && (
        <div
          className="tracker-filter-omnibox-pills flex flex-wrap items-center gap-1"
          data-testid="tracker-filter-omnibox-pills"
        >
          {pills}
        </div>
      )}

      {menuOpen && suggestions.length > 0 && inputRef.current && (
        <Suspense fallback={null}>
          <TrackerFilterOmniboxMenu
            reference={(inlinePills && boxRef.current) || inputRef.current}
            suggestions={suggestions}
            highlightIndex={highlightIndex}
            onHighlight={setHighlightIndex}
            onApply={applySuggestion}
            onClose={() => setMenuOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
