/**
 * The Project canvas editor, loaded the first time a `.canvas` page opens. With
 * no `host.collaboration` the editor uses its local-file mode over the file
 * host, and its cards come from `WikiCanvasCard`.
 */
import { CanvasEditor, setCanvasCallbacks } from '@nimbalyst/collab-bundle/canvas';
import { WikiCanvasCard } from './WikiCanvasCard';

setCanvasCallbacks({ renderCard: WikiCanvasCard });

export const components = { ProjectCanvasEditor: CanvasEditor };
