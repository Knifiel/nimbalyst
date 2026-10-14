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
import type { JSX, ReactNode } from 'react';
import { type TrackerFieldFilter, type TrackerFilterSet } from '../../../runtime/src/plugins/TrackerPlugin/models/index';
import type { TrackerFilterField } from './trackerFilterFields';
import { type TagTokenOption } from '../trackers/trackerFilterTokens';
export declare const TRACKER_FOCUS_SEARCH_EVENT = "nimbalyst:tracker-focus-search";
export declare function dispatchTrackerFocusSearch(): void;
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
export declare function TrackerFilterOmnibox({ searchQuery, onSearchQueryChange, fields, filters, onFiltersChange, tagOptions, tagFilter, onTagFilterChange, showPills, inlinePills, onPillClick, trailing, className, placeholder, size, }: TrackerFilterOmniboxProps): JSX.Element;
