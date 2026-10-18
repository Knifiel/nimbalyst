/**
 * The reload half of the Layer D baseline contract.
 *
 * `saveWithHistory` already funnels every save outcome through one
 * `setPersistedBaseline` helper, precisely so a new branch cannot forget to
 * move the baseline with the bytes. The reload path had no such choke point:
 * it assigned `lastSavedContentRef.current` inline, unconditionally, after a
 * `try/catch` that swallowed apply failures. That was the whole bug (#3684).
 *
 * Why an unverified baseline is destructive: the conflict check in
 * `FileHandlers.saveFile` compares `lastKnownContent` to disk. If the baseline
 * advances to the new disk bytes while the editor buffer keeps the old ones,
 * the comparison passes and the stale buffer is written as a clean save --
 * silently reverting whoever wrote the file. GitHub #647 was the empty-buffer
 * instance of this same shape (see the `safeFileWrite.ts` header, which spells
 * out "the conflict check one layer up still passed -- disk matched
 * last-known"); it was closed by refusing one *value* of wrong buffer rather
 * than the *property* of an unverified one. A stale buffer walks through the
 * same door. So does the hidden-editor case NIM-905 worked around privately
 * rather than fixing here.
 *
 * So: the baseline may only advance on a buffer we have read back and checked.
 *
 * ## Why the check is not `buffer === incoming`
 *
 * Markdown does not round-trip byte-for-byte. `$convertFromEnhancedMarkdownString`
 * followed by `$convertToEnhancedMarkdownString` normalizes bullet markers,
 * setext headings, trailing whitespace and more. An exact-equality gate would
 * therefore refuse to verify most ordinary reloads and block writes on tabs
 * that are working perfectly -- worse than the bug it fixes.
 *
 * The failure that actually loses data is narrower and is checked exactly:
 * **the buffer did not move at all** while disk did. That is the byte-identical
 * revert the incident reported. A buffer that moved but normalized differently
 * is a faithful render and is allowed through, with the baseline set to disk
 * truth -- which is what the conflict check needs and matches the behavior the
 * save path has always had.
 */

/** The three pieces of tab state that must move together, or not at all. */
export interface ReloadState {
  /** The conflict baseline: what we believe disk holds. */
  baseline: string;
  /** What the editor buffer actually holds. */
  buffer: string;
  dirty: boolean;
}

export interface ReloadDeps {
  /**
   * Push `content` into the editor. Throws if the apply fails. `null` when no
   * editor is mounted to receive it -- which must be treated the same as a
   * failure, not as a successful no-op.
   */
  applyToEditor: ((content: string) => void) | null;
  /**
   * Serialize the buffer back out. Must be the same serialization a save
   * uses, or the verification is comparing against something that will never
   * reach disk. `null` when the buffer cannot be read.
   */
  readBuffer: () => string | null;
  onApplyError: (error: unknown) => void;
}

/** Why a reload did not produce a buffer we can vouch for. */
export type ReloadFailure =
  /** No editor was mounted to receive the content. */
  | 'no-editor'
  /** The apply threw. */
  | 'apply-threw'
  /** The buffer could not be serialized back out, so nothing can be verified. */
  | 'unreadable'
  /** The apply completed but the buffer is unchanged -- it silently did nothing. */
  | 'buffer-unchanged';

export type ReloadOutcome =
  | {
      verified: true;
      next: ReloadState;
      /**
       * True when the buffer holds a faithful but not byte-identical render of
       * `incoming` (markdown normalization). Safe, but worth an event: if this
       * is common we are rewriting users' formatting on every reload.
       */
      normalized: boolean;
    }
  | {
      verified: false;
      /**
       * State is preserved apart from `buffer`, which is corrected to whatever
       * the editor actually holds. The baseline explicitly does NOT advance:
       * the tab does not know what is on disk, so it must not write to it.
       */
      next: ReloadState;
      failure: ReloadFailure;
    };

/**
 * Apply an external change to the editor and decide what the tab's baseline,
 * buffer and dirty flag become.
 */
export function reloadFromDisk(
  incoming: string,
  state: ReloadState,
  deps: ReloadDeps,
): ReloadOutcome {
  if (!deps.applyToEditor) {
    return { verified: false, next: state, failure: 'no-editor' };
  }

  try {
    deps.applyToEditor(incoming);
  } catch (error) {
    deps.onApplyError(error);
    return { verified: false, next: state, failure: 'apply-threw' };
  }

  const buffer = deps.readBuffer();
  if (buffer === null) {
    return { verified: false, next: state, failure: 'unreadable' };
  }

  if (buffer === incoming) {
    return {
      verified: true,
      next: { baseline: incoming, buffer: incoming, dirty: false },
      normalized: false,
    };
  }

  // The apply ran without throwing and the buffer is byte-identical to what it
  // held before, while disk holds something else. Nothing landed. This is the
  // case no try/catch can see -- a null-op update, or the wrong apply strategy
  // for the mounted editor -- and it is the one that reverts users' files.
  if (buffer === state.buffer) {
    return { verified: false, next: state, failure: 'buffer-unchanged' };
  }

  // The buffer moved and holds a normalized render of `incoming`. Baseline
  // tracks disk truth so the conflict check stays correct.
  return {
    verified: true,
    next: { baseline: incoming, buffer, dirty: false },
    normalized: true,
  };
}

/**
 * Which reload a tab's editor handle can take. A markdown tab in source mode
 * holds the Monaco wrapper, so the file type alone does not say the editor is
 * Lexical; calling `update` on that wrapper threw after Keep All (#1672).
 */
export function editorReloadKind(editor: unknown): 'lexical' | 'content' | 'none' {
  if (!editor || typeof editor !== 'object') return 'none';
  if (typeof (editor as { update?: unknown }).update === 'function') return 'lexical';
  return 'content';
}
