// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { editorReloadKind, reloadFromDisk, type ReloadDeps, type ReloadState } from '../reloadFromDisk';
import { resolveSaveAttempt } from '../resolveSaveAttempt';

/**
 * NIM-3684: a file open in a tab silently reverted an agent's write to
 * byte-identical pre-edit content, twice, with no banner.
 *
 * These tests occupy an intersection the suite has never covered: a CLEAN
 * tab whose reload apply fails, followed by an autosave, asserting DISK. The
 * three prior fixes for this class each tested an adjacent case --
 * 58ae96b9d tested a *dirty* buffer (structurally immune: DocumentModel skips
 * dirty attachments, so the reload never runs), a489bfb4f tested *deleted*
 * files, and NIM-905/911 tested *closed* files via HiddenTabManager. The
 * clean-visible-tab case was never tested, so the bug never had to regress --
 * it just had to stay.
 *
 * The assertion that matters is on disk bytes, not on editor text. Every
 * prior test asserted the happy path succeeded; none asserted disk survived
 * the unhappy one, which is exactly why a guard whose failure mode is silent
 * got past all of them.
 */

/** Models the conflict check in FileHandlers.saveFile (:182-199). */
function createFakeDisk(initialContent: string) {
  let disk = initialContent;
  const saveFile: Parameters<typeof resolveSaveAttempt>[1]['saveFile'] = async (
    content,
    filePath,
    lastKnownContent,
  ) => {
    if (lastKnownContent !== undefined && disk !== lastKnownContent) {
      return { success: false, conflict: true, filePath, diskContent: disk };
    }
    disk = content;
    return { success: true, filePath };
  };
  return { saveFile, read: () => disk };
}

/**
 * One autosave tick: serialize the buffer, send it with the tab's baseline.
 * Mirrors saveWithHistory's `expectedDiskContent = lastSavedContentRef.current`.
 */
async function autosave(state: ReloadState, disk: ReturnType<typeof createFakeDisk>) {
  return resolveSaveAttempt(
    {
      contentToSave: state.buffer,
      expectedDiskContent: state.baseline,
      filePath: '/plans/plan.md',
      snapshotType: 'auto',
    },
    {
      saveFile: disk.saveFile,
      confirmOverwrite: () => {
        throw new Error('autosave must never prompt');
      },
    },
  );
}

const ORIGINAL = '# Plan\n\nstatus: draft\n';
const AGENT_WROTE = '# Plan\n\nstatus: in-development\n\n## Progress\n\n- Phase 1 done\n';

/** A tab sitting clean on ORIGINAL, which an agent has just overwritten on disk. */
function cleanTabOnOriginal(): ReloadState {
  return { baseline: ORIGINAL, buffer: ORIGINAL, dirty: false };
}

function deps(overrides: Partial<ReloadDeps> = {}): ReloadDeps {
  return {
    applyToEditor: vi.fn(),
    readBuffer: () => ORIGINAL,
    onApplyError: vi.fn(),
    ...overrides,
  };
}

describe('reloadFromDisk: the baseline may not advance past the buffer', () => {
  it('does not clobber the agent write when the apply throws', async () => {
    const disk = createFakeDisk(AGENT_WROTE);
    const { next } = reloadFromDisk(AGENT_WROTE, cleanTabOnOriginal(), deps({
      applyToEditor: () => {
        throw new Error('selection has been lost');
      },
      readBuffer: () => ORIGINAL, // the apply threw, so the buffer never moved
    }));

    // The tab does not hold the agent's content, so it may not claim to.
    expect(next.baseline).not.toBe(AGENT_WROTE);

    const outcome = await autosave(next, disk);
    expect(outcome.kind).toBe('autosave-conflict');
    expect(disk.read()).toBe(AGENT_WROTE);
  });

  it('does not clobber the agent write when no editor is mounted to apply it', async () => {
    const disk = createFakeDisk(AGENT_WROTE);
    const { next } = reloadFromDisk(AGENT_WROTE, cleanTabOnOriginal(), deps({
      applyToEditor: null,
      readBuffer: () => ORIGINAL,
    }));

    expect(next.baseline).not.toBe(AGENT_WROTE);

    const outcome = await autosave(next, disk);
    expect(outcome.kind).toBe('autosave-conflict');
    expect(disk.read()).toBe(AGENT_WROTE);
  });

  it('does not clobber the agent write when the apply silently no-ops', async () => {
    // No throw to catch. This is the markdown-source-mode shape: the reload
    // picks the Lexical path off the file extension while editorRef holds the
    // Monaco wrapper, so the update lands nowhere. A try/catch cannot see it;
    // only reading the buffer back can.
    const disk = createFakeDisk(AGENT_WROTE);
    const { next } = reloadFromDisk(AGENT_WROTE, cleanTabOnOriginal(), deps({
      applyToEditor: () => {},
      readBuffer: () => ORIGINAL,
    }));

    expect(next.baseline).not.toBe(AGENT_WROTE);

    const outcome = await autosave(next, disk);
    expect(outcome.kind).toBe('autosave-conflict');
    expect(disk.read()).toBe(AGENT_WROTE);
  });

  it('advances the baseline and saves cleanly when the buffer verifiably took the content', async () => {
    // The other half of the contract: refusing to advance must not become a
    // tab that can never save again.
    const disk = createFakeDisk(AGENT_WROTE);
    let buffer = ORIGINAL;
    const outcome = reloadFromDisk(AGENT_WROTE, cleanTabOnOriginal(), deps({
      applyToEditor: (incoming) => {
        buffer = incoming;
      },
      readBuffer: () => buffer,
    }));

    expect(outcome.verified).toBe(true);
    expect(outcome.next).toEqual({ baseline: AGENT_WROTE, buffer: AGENT_WROTE, dirty: false });

    const edited = `${AGENT_WROTE}\n- Phase 2 done\n`;
    const saved = await autosave({ ...outcome.next, buffer: edited }, disk);
    expect(saved.kind).toBe('saved');
    expect(disk.read()).toBe(edited);
  });

  it('accepts a markdown-normalized render rather than blocking the tab', async () => {
    // Markdown does not round-trip byte-for-byte -- Lexical rewrites bullet
    // markers, setext headings, trailing whitespace. Gating on exact equality
    // would refuse to verify most ordinary reloads and permanently block
    // writes on healthy tabs, which is worse than the bug. The buffer moved
    // and holds a faithful render, so this must verify.
    const normalized = AGENT_WROTE.replace('- Phase 1 done', '* Phase 1 done');
    const disk = createFakeDisk(AGENT_WROTE);
    let buffer = ORIGINAL;
    const outcome = reloadFromDisk(AGENT_WROTE, cleanTabOnOriginal(), deps({
      applyToEditor: () => {
        buffer = normalized;
      },
      readBuffer: () => buffer,
    }));

    expect(outcome.verified).toBe(true);
    // Baseline tracks disk truth, so the next conflict check stays correct...
    expect(outcome.next.baseline).toBe(AGENT_WROTE);
    // ...while the buffer records what the editor really holds.
    expect(outcome.next.buffer).toBe(normalized);

    const saved = await autosave(outcome.next, disk);
    expect(saved.kind).toBe('saved');
  });

  it('reports why it refused, so the refusal is observable rather than silent', () => {
    const cases: Array<[Partial<ReloadDeps>, string]> = [
      [{ applyToEditor: null }, 'no-editor'],
      [{ applyToEditor: () => { throw new Error('boom'); } }, 'apply-threw'],
      [{ readBuffer: () => null }, 'unreadable'],
      [{ applyToEditor: () => {} }, 'buffer-unchanged'],
    ];

    for (const [override, expected] of cases) {
      const outcome = reloadFromDisk(AGENT_WROTE, cleanTabOnOriginal(), deps(override));
      expect(outcome.verified).toBe(false);
      expect(outcome.verified === false && outcome.failure).toBe(expected);
    }
  });
});

describe('editorReloadKind (#1672)', () => {
  it('routes a markdown tab in source mode to the content reload, not Lexical', () => {
    const monacoWrapper = { setContent: vi.fn(), getContent: vi.fn(), exitDiffMode: vi.fn() };
    expect(editorReloadKind(monacoWrapper)).toBe('content');
  });

  it('routes a Lexical editor to the Lexical reload', () => {
    expect(editorReloadKind({ update: vi.fn(), getEditorState: vi.fn() })).toBe('lexical');
  });

  it('reports no editor when nothing is mounted', () => {
    expect(editorReloadKind(null)).toBe('none');
  });
});
