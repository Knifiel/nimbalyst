import type { JSX } from 'react';
import type { TrackerColumnDef, TypeColumnConfig } from '../../../runtime/src/plugins/TrackerPlugin/components/trackerColumns';
import { type TrackerFilterSet, type TrackerGroupBy, type TrackerOrdering } from '../../../runtime/src/plugins/TrackerPlugin/models/index';
import { type TrackerViewMode, type TrackerViewModeOption, type TrackerStatusScope } from '../trackers';
import type { TrackerFilterField } from './trackerFilterFields';
export type { TrackerFilterField, TrackerFilterFieldOption, } from './trackerFilterFields';
export interface TrackerViewLayoutUpdate {
    viewMode?: TrackerViewMode;
    groupBy?: TrackerGroupBy;
    ordering?: TrackerOrdering;
}
export interface TrackerViewHeaderControlsProps {
    itemCount: number;
    /** Count with lifecycle scope removed but all other predicates retained. */
    unscopedItemCount?: number;
    availableColumns: TrackerColumnDef[];
    columnConfig: TypeColumnConfig;
    onColumnConfigChange: (config: TypeColumnConfig) => void;
    /**
     * Whether the rendered view has table columns. Display Settings opens either
     * way -- it owns view mode, grouping, and ordering too -- but the column
     * property list only applies to the list and table renderings.
     */
    showColumnControls: boolean;
    filterFields: TrackerFilterField[];
    filters: TrackerFilterSet | null;
    onFiltersChange: (filters: TrackerFilterSet) => void;
    openFiltersToken?: number;
    /**
     * When set, the host opens filters from its own control (bumping
     * `openFiltersToken`): the Filter button is not drawn and the builder opens
     * under this element instead.
     */
    filterAnchor?: HTMLElement | null;
    statusScope: TrackerStatusScope;
    onStatusScopeChange: (scope: TrackerStatusScope) => void;
    viewMode: TrackerViewMode;
    groupBy: TrackerGroupBy;
    ordering: TrackerOrdering;
    onLayoutChange: (updates: TrackerViewLayoutUpdate) => void;
    /** Modes this host can honestly render. Desktop uses the full catalog. */
    viewModeOptions?: readonly TrackerViewModeOption[];
}
export declare function TrackerViewHeaderControls({ itemCount, unscopedItemCount, availableColumns, columnConfig, onColumnConfigChange, showColumnControls, filterFields, filters, onFiltersChange, openFiltersToken, filterAnchor, statusScope, onStatusScopeChange, viewMode, groupBy, ordering, onLayoutChange, viewModeOptions, }: TrackerViewHeaderControlsProps): JSX.Element;
