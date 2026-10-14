import type { JSX, RefObject } from 'react';
import type { TrackerFilterOp } from '../../../runtime/src/plugins/TrackerPlugin/models/index';
import type { TrackerFilterField } from './trackerFilterFields';
export interface TrackerFilterValueMenuProps {
    field: TrackerFilterField;
    anchorRect: DOMRect | null;
    placement?: 'left' | 'right' | 'below';
    selectedValues?: ReadonlySet<string>;
    onSelect: (value: string | string[] | number, op?: TrackerFilterOp) => void;
    onClear?: () => void;
    onClose: () => void;
    dismissOnOutsideClick?: boolean;
    menuRef?: RefObject<HTMLDivElement | null>;
    testIdPrefix?: 'tracker-filter' | 'tracker-column-filter';
}
export declare function TrackerFilterValueMenu({ field, anchorRect, placement, selectedValues, onSelect, onClear, onClose, dismissOnOutsideClick, menuRef, testIdPrefix, }: TrackerFilterValueMenuProps): JSX.Element;
