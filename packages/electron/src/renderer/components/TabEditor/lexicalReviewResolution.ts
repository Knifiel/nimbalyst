import type { EditorState, LexicalEditor } from 'lexical';
import type { Transformer } from '@lexical/markdown';
import {
  $convertFromEnhancedMarkdownString,
  $convertToEnhancedMarkdownString,
  createHeadlessEditorFromEditor,
} from '@nimbalyst/runtime/editor/markdown';
import { $approveDiffs } from '@nimbalyst/runtime/editor/plugins/DiffPlugin/core/exports';
import type { DiffResolutionRequest } from '../../services/document-model/types';

export interface LexicalReviewResolution {
  accepted: boolean;
  request: DiffResolutionRequest;
  /** The editor's export at resolution time. */
  editorContent: string;
}

/**
 * Decide what a Lexical review that just ran out of groups writes to disk.
 *
 * The editor's export is not the file: Lexical re-dumps front matter, moves
 * emphasis around inline math and pads table separators, so writing it rewrote
 * every untouched line on Keep All and Revert All (#1734). The reviewed bytes
 * are on hand -- the agent's write and the pre-edit baseline -- so when the
 * buffer is exactly what one of them loads as, the model writes those bytes and
 * the editor reloads from disk.
 *
 * The check runs here, at resolution, against the buffer as it is now. Typing
 * at any earlier moment -- while the diff settled, between the click and this
 * call -- is in the buffer and fails the match, and so are mixed per-group
 * decisions. Those write the editor export, the only record of them.
 *
 * Accepting has a second candidate: Keep All replayed on the diff tree as it
 * rendered. The diff renderer itself can mangle `$` content, so an accepted
 * buffer need not match a fresh parse of the agent's bytes even untouched.
 * Rejecting has no such candidate: a replayed reject would keep text typed
 * into the baseline before the diff applied, which the baseline bytes lack.
 */
export function lexicalReviewResolution(input: {
  editorContent: string;
  /** The model generation that was live when the decision arrived. */
  decidedGeneration: number | undefined;
  /** Exports the buffer would have if it held exactly the agent's bytes; nulls are skipped. */
  acceptedExports: Array<string | null>;
  /** The export of the baseline bytes once loaded; null when unavailable. */
  baselineBytesExport: string | null;
}): Omit<LexicalReviewResolution, 'editorContent'> {
  const { editorContent, decidedGeneration: generation, acceptedExports, baselineBytesExport } = input;
  const isAccepted = acceptedExports.includes(editorContent);
  const isRejected = baselineBytesExport !== null && editorContent === baselineBytesExport;
  // Matching both means Lexical cannot tell the decisions apart.
  if (generation !== undefined && isAccepted !== isRejected) {
    return { accepted: isAccepted, request: { generation } };
  }
  return { accepted: true, request: { finalContent: editorContent, generation } };
}

/** The diff tree of one review generation, captured with no editable gap after it rendered. */
export interface RenderedLexicalReview {
  generation: number;
  state: EditorState;
}

/** Call synchronously after the diff command: `read` flushes its pending update first. */
export function captureRenderedReview(editor: LexicalEditor, generation: number): RenderedLexicalReview {
  return { generation, state: editor.read(() => editor.getEditorState()) };
}

/** Keep All replayed on a scratch copy of the rendered diff tree. */
function exportAfterKeepAll(editor: LexicalEditor, rendered: RenderedLexicalReview, transformers: Transformer[]): string | null {
  try {
    const scratch = createHeadlessEditorFromEditor(editor);
    scratch.setEditorState(scratch.parseEditorState(rendered.state.toJSON()));
    scratch.update(() => $approveDiffs(), { discrete: true });
    return scratch.getEditorState().read(() => $convertToEnhancedMarkdownString(transformers));
  } catch {
    return null;
  }
}

/** How `markdown` exports after loading it the way a reload does, in a scratch editor. */
function exportAsLoaded(editor: LexicalEditor, markdown: string, transformers: Transformer[]): string | null {
  try {
    const scratch = createHeadlessEditorFromEditor(editor);
    scratch.update(() => {
      $convertFromEnhancedMarkdownString(markdown, transformers);
    }, { discrete: true });
    return scratch.getEditorState().read(() => $convertToEnhancedMarkdownString(transformers));
  } catch {
    return null;
  }
}

/** `lexicalReviewResolution` for a live editor and the model's diff state. */
export function resolveLexicalReview(
  editor: LexicalEditor,
  transformers: Transformer[],
  diff: { oldContent: string; newContent: string } | null | undefined,
  decidedGeneration: number | undefined,
  rendered: RenderedLexicalReview | null,
): LexicalReviewResolution {
  const editorContent = editor
    .getEditorState()
    .read(() => $convertToEnhancedMarkdownString(transformers));
  const plan = lexicalReviewResolution({
    editorContent,
    decidedGeneration,
    acceptedExports: diff ? [
      exportAsLoaded(editor, diff.newContent, transformers),
      rendered && rendered.generation === decidedGeneration ? exportAfterKeepAll(editor, rendered, transformers) : null,
    ] : [],
    baselineBytesExport: diff ? exportAsLoaded(editor, diff.oldContent, transformers) : null,
  });
  return { ...plan, editorContent };
}

/**
 * The bytes a resolution put on disk: the editor export it was handed, or for
 * a whole-review decision the model's own bytes, which only disk has.
 */
export async function readResolvedContent(
  resolution: LexicalReviewResolution,
  readFile: () => Promise<{ success?: boolean; content?: unknown } | null | undefined>,
): Promise<string> {
  if (resolution.request.finalContent !== undefined) return resolution.editorContent;
  const written = await readFile();
  return written?.success && typeof written.content === 'string'
    ? written.content
    : resolution.editorContent;
}
