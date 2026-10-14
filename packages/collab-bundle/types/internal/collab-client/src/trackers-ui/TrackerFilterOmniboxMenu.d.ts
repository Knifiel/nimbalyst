import type { JSX } from 'react';
import type { TokenSuggestion } from '../trackers/trackerFilterTokens';
export interface TrackerFilterOmniboxMenuProps {
    reference: HTMLElement;
    suggestions: TokenSuggestion[];
    highlightIndex: number | null;
    onHighlight: (index: number) => void;
    onApply: (suggestion: TokenSuggestion) => void;
    onClose: () => void;
}
/** Floating suggestion list loaded after the eager search input receives intent. */
export declare function TrackerFilterOmniboxMenu({ reference, suggestions, highlightIndex, onHighlight, onApply, onClose, }: TrackerFilterOmniboxMenuProps): JSX.Element;
