/**
 * The toolbar's New button, with importing tucked into its menu: a rare action
 * should not hold a permanent toolbar slot beside the common one.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { ImportFromSourceDialog } from './ImportFromSourceDialog';

export interface TrackerExternalImporter {
  id: string;
  displayName: string;
  icon: string;
  importsAs?: string[];
}

const BULK_IMPORT_DIRECTORIES = ['nimbalyst-local/plans', 'plans', 'design'] as const;

interface TrackerNewMenuProps {
  workspacePath?: string;
  /** False for a non-creatable type (e.g. automations): the menu still offers imports. */
  canCreate: boolean;
  onNewItem: () => void;
}

export function TrackerNewMenu({ workspacePath, canCreate, onNewItem }: TrackerNewMenuProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [externalImporters, setExternalImporters] = useState<TrackerExternalImporter[]>([]);
  const [sourceDialog, setSourceDialog] = useState<TrackerExternalImporter | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  // External-source importers (GitHub, ...) come from installed extensions.
  useEffect(() => {
    if (!menuOpen || !workspacePath) return;
    let cancelled = false;
    window.electronAPI
      .invoke('tracker:importer:list', workspacePath)
      .then((list: unknown) => {
        if (!cancelled && Array.isArray(list)) setExternalImporters(list as TrackerExternalImporter[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [menuOpen, workspacePath]);

  const handleBulkImport = useCallback(async (directory: string) => {
    setMenuOpen(false);
    setImportStatus('Importing...');
    try {
      const result = await window.electronAPI.documentService.bulkImportTrackerItems({
        directory,
        skipDuplicates: true,
        recursive: true,
      });
      if (result.success) {
        const parts: string[] = [];
        if (result.imported) parts.push(`${result.imported} imported`);
        if (result.skipped) parts.push(`${result.skipped} skipped`);
        if (result.errors?.length) parts.push(`${result.errors.length} errors`);
        setImportStatus(parts.join(', ') || 'No items found');
      } else {
        setImportStatus(`Failed: ${result.error}`);
      }
    } catch (error) {
      setImportStatus('Import failed');
      console.error('[TrackerNewMenu] Bulk import failed:', error);
    }
    setTimeout(() => setImportStatus(null), 4000);
  }, []);

  const itemClass = 'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-nim-muted hover:bg-nim-tertiary hover:text-nim text-left';

  return (
    <>
      {importStatus && (
        <span className="text-[11px] text-nim-muted bg-nim-secondary px-2 py-0.5 rounded">{importStatus}</span>
      )}
      <div className="tracker-new-menu relative flex shrink-0" ref={menuRef}>
        {canCreate ? (
          <>
            <button
              className="inline-flex h-7 items-center gap-1 rounded-l bg-[var(--nim-primary)] px-2.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
              onClick={onNewItem}
              data-testid="tracker-toolbar-new-button"
            >
              <MaterialSymbol icon="add" size={14} />
              New
            </button>
            <button
              className="inline-flex h-7 items-center rounded-r border-l border-white/25 bg-[var(--nim-primary)] px-1 text-white transition-opacity hover:opacity-90"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label="More ways to add items"
              aria-expanded={menuOpen}
              data-testid="tracker-toolbar-new-menu-button"
            >
              <MaterialSymbol icon="expand_more" size={14} />
            </button>
          </>
        ) : (
          <button
            className="inline-flex h-7 items-center gap-1 rounded border border-nim px-2 text-[11px] font-medium text-nim-muted transition-colors hover:bg-nim-tertiary hover:text-nim"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            data-testid="tracker-toolbar-new-menu-button"
          >
            <MaterialSymbol icon="upload_file" size={14} />
            Import
          </button>
        )}
        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-[220px] bg-nim border border-nim rounded-md shadow-lg z-50 py-1" data-testid="tracker-toolbar-new-menu">
            {BULK_IMPORT_DIRECTORIES.map((directory) => (
              <button key={directory} className={itemClass} onClick={() => handleBulkImport(directory)}>
                <MaterialSymbol icon="folder_open" size={14} />
                Import from {directory === 'nimbalyst-local/plans' ? directory : `${directory}/`}
              </button>
            ))}
            {externalImporters.length > 0 && <div className="my-1 border-t border-nim" />}
            {externalImporters.map((importer) => (
              <button
                key={importer.id}
                className={itemClass}
                onClick={() => {
                  setMenuOpen(false);
                  setSourceDialog(importer);
                }}
                data-testid={`tracker-import-source-${importer.id}`}
              >
                <MaterialSymbol icon={importer.icon || 'cloud_download'} size={14} />
                Import from {importer.displayName}
              </button>
            ))}
          </div>
        )}
      </div>
      {sourceDialog && workspacePath && (
        <ImportFromSourceDialog
          providerId={sourceDialog.id}
          providerLabel={sourceDialog.displayName}
          importsAs={sourceDialog.importsAs}
          workspacePath={workspacePath}
          onClose={() => setSourceDialog(null)}
          onImported={(count) => {
            if (count > 0) {
              setImportStatus(`Imported ${count} item${count === 1 ? '' : 's'}`);
              setTimeout(() => setImportStatus(null), 4000);
            }
          }}
        />
      )}
    </>
  );
}
