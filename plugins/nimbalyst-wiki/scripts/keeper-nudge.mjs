#!/usr/bin/env node
// Stop hook for the nimbalyst-wiki plugin. Asks the agent, at most once per
// session, to record what the session established in the team's pages, and
// only when the transcript shows substantive work: a git commit, at least N
// file edits, or a plan written. Every other stop passes through silently, and
// so does every stop in a directory with no wiki to record into: neither a git
// remote (team pages are reached through one) nor a local wiki. With a local
// wiki, the reason names up to five pages whose `paths` cover the files the
// session edited, read through the SessionStart hook's bundle (wiki-context.mjs)
// so both hooks match pages the way the `pagesForFiles` tool does.
//
// A hook that fails must never trap the user in a session, so every error path
// exits 0 with no output. Plain Node; the bundle is loaded only when a local
// wiki exists.
//
// Env:
//   NIMBALYST_WIKI_NUDGE_MIN_EDITS   edits that count as substance (default 5)
//   NIMBALYST_WIKI_NUDGE_STATE_DIR   where once-per-session markers live (default:
//                                     $XDG_STATE_HOME/nimbalyst-wiki, else
//                                     ~/.claude/state/nimbalyst-wiki; created 0700)

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_MIN_EDITS = 5;
/** Pages named in the reason; more are left to the capture skill's `pagesForFiles`. */
const MAX_NAMED_PAGES = 5;
// The local wiki's root marker (packages/local-wiki FORMAT.md); the hook has no dependencies to import it from.
const LOCAL_WIKI_MARKER = '.nimbalyst-wiki.yaml';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const GIT_COMMIT = /\bgit\b[^|;&\n]*\bcommit\b/;
const PLAN_PATH = /(^|[\\/])(plans?|\.claude[\\/]plans)[\\/]|(^|[\\/])[^\\/]*plan[^\\/]*\.md$/i;
// The agent already wrote to pages this session, through the plugin or the
// desktop app's tools (same names, any MCP prefix).
const PAGE_WRITE = /(^|__)(applyCollabDocEdit|createSharedDoc|setPageType|moveSharedItem|tracker_create|tracker_update)$/;

export function minEdits(env = process.env) {
  const parsed = Number.parseInt(env.NIMBALYST_WIKI_NUDGE_MIN_EDITS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_EDITS;
}

function toolUses(line) {
  const content = line?.message?.content;
  return Array.isArray(content) ? content.filter((part) => part && part.type === 'tool_use') : [];
}

/** Summarizes a Claude Code JSONL transcript into the signals the nudge uses. */
export function assessTranscript(text) {
  const signals = { commits: 0, edits: 0, plans: 0, pageWrites: 0, files: [] };
  const files = new Set();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    for (const use of toolUses(line)) {
      const name = String(use.name ?? '');
      const input = use.input ?? {};
      if (PAGE_WRITE.test(name)) signals.pageWrites += 1;
      if (name === 'ExitPlanMode') signals.plans += 1;
      if (/git_commit/.test(name)) signals.commits += 1;
      if (name === 'Bash' && GIT_COMMIT.test(String(input.command ?? ''))) signals.commits += 1;
      if (EDIT_TOOLS.has(name)) {
        signals.edits += 1;
        const file = String(input.file_path ?? input.notebook_path ?? '');
        if (file) files.add(file);
        if (name === 'Write' && PLAN_PATH.test(file)) signals.plans += 1;
      }
    }
  }
  signals.files = [...files];
  return signals;
}

export function substanceReason(signals, threshold) {
  if (signals.pageWrites > 0) return null;
  const parts = [];
  if (signals.commits > 0) parts.push(`${signals.commits} git commit${signals.commits === 1 ? '' : 's'}`);
  if (signals.plans > 0) parts.push('a plan');
  if (signals.edits >= threshold) parts.push(`${signals.edits} file edits`);
  return parts.length > 0 ? parts.join(', ') : null;
}

// Per-user, not the shared temp dir: another local user could otherwise
// pre-create or read markers named after this user's session ids.
function stateDir(env) {
  if (env.NIMBALYST_WIKI_NUDGE_STATE_DIR) return env.NIMBALYST_WIKI_NUDGE_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'nimbalyst-wiki');
  return path.join(env.HOME || homedir(), '.claude', 'state', 'nimbalyst-wiki');
}

function markerPath(sessionId, env) {
  const dir = stateDir(env);
  return { dir, file: path.join(dir, `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.nudged`) };
}

/** Whether `dir` is inside a git checkout with at least one remote. Any failure counts as no. */
export function hasGitRemote(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'remote'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether the project has a local wiki: its `.nimbalyst/local-wiki.json`
 * setting, or the default folder's marker. Any failure counts as no.
 */
export function hasLocalWiki(dir) {
  try {
    let root = dir;
    try {
      root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim() || dir;
    } catch {
      // not a git checkout: the directory itself is the project
    }
    return existsSync(path.join(root, '.nimbalyst', 'local-wiki.json')) || existsSync(path.join(root, 'nimbalyst-local', 'wiki', LOCAL_WIKI_MARKER));
  } catch {
    return false;
  }
}

/** Somewhere to record: a team wiki through a git remote, or a local wiki. */
export function hasWiki(dir) {
  return hasGitRemote(dir) || hasLocalWiki(dir);
}

/**
 * Titles of the local wiki pages covering `files` (or the working tree's
 * changes when the session edited nothing), at most five, stale ones marked.
 * Any failure counts as none.
 */
export async function coveredPageNames(dir, files) {
  if (!hasLocalWiki(dir)) return [];
  try {
    const { coveredPages } = await import('./wiki-context.mjs');
    const pages = await coveredPages(dir, files);
    return pages.slice(0, MAX_NAMED_PAGES).map((page) => (page.stale ? `${page.title} (stale)` : page.title));
  } catch {
    return [];
  }
}

/** Returns the hook's stdout JSON, or null to let the stop through. */
export async function decide(input, env = process.env, remoteCheck = hasWiki, coveredCheck = coveredPageNames) {
  if (!input || typeof input !== 'object' || input.stop_hook_active === true) return null;
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : '';
  if (!sessionId || !transcriptPath) return null;

  const marker = markerPath(sessionId, env);
  if (existsSync(marker.file)) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (!remoteCheck(cwd)) return null;

  const signals = assessTranscript(readFileSync(transcriptPath, 'utf8'));
  const why = substanceReason(signals, minEdits(env));
  if (!why) return null;
  const covered = await coveredCheck(cwd, signals.files);

  // Record before blocking: if the write fails, the catch lets the stop through
  // rather than risking a nudge on every turn.
  mkdirSync(marker.dir, { recursive: true, mode: 0o700 });
  writeFileSync(marker.file, new Date().toISOString());
  return {
    decision: 'block',
    reason:
      `This session did substantive work (${why}). ` +
      (covered.length > 0 ? `It changed files covered by these wiki pages: ${covered.join(', ')}. ` : '') +
      'Before stopping, run the /nimbalyst-wiki:capture skill ' +
      (covered.length > 0 ? 'to update those pages or mark them outdated, and ' : '') +
      'to record any decision made or question answered in the wiki pages it affects. ' +
      'If nothing is worth keeping, reply "nothing to record" and stop. This reminder appears once per session.',
  };
}

async function main() {
  try {
    const raw = readFileSync(0, 'utf8');
    const result = await decide(JSON.parse(raw));
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    // Never block a stop because the hook itself failed.
  }
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on('uncaughtException', () => process.exit(0));
  main();
}
