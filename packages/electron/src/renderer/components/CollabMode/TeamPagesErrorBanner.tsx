import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';

/**
 * Pages' notice that the team's pages are not there because something failed,
 * as opposed to still loading or the project having no team.
 */
export const TeamPagesErrorBanner: React.FC<{
  title: string;
  message: string;
  onRetry: () => void;
}> = ({ title, message, onRetry }) => (
  <div
    className="team-pages-error-banner flex items-start gap-2 px-3 py-2 border-b border-nim bg-nim-secondary text-sm"
    role="alert"
    data-testid="team-pages-error-banner"
  >
    <MaterialSymbol icon="cloud_off" size={18} className="text-nim-error shrink-0 mt-0.5" />
    <div className="flex-1 min-w-0 select-text">
      <div className="text-nim font-medium">{title}</div>
      <div className="text-nim-muted break-words">{message}</div>
    </div>
    <button
      type="button"
      className="shrink-0 px-2 py-1 rounded border border-nim bg-transparent text-nim cursor-pointer hover:bg-nim-hover"
      onClick={onRetry}
    >
      Retry
    </button>
  </div>
);
