---
description: Report and ship every server, npm package, plugin and marketplace artifact that changed since its last release
argument-hint: "[collab|npm|wiki|marketplace ...] [--check]"
allowed-tools: Bash, Read, Edit, mcp__nimbalyst__AskUserQuestion, mcp__nimbalyst__PromptForUserInput, mcp__nimbalyst__developer_git_commit_proposal
---

Find everything Nimbalyst ships outside the desktop app that has changed since its last release, then ship it in dependency order. Each target keeps its own procedure; this command decides what is due, orders it, and runs those procedures.

Arguments: `$ARGUMENTS`. Area names limit the run (`collab`, `npm`, `wiki`, `marketplace`). `--check` reports and stops.

| Area | Target | Published to | Status command (run from) | Procedure |
| --- | --- | --- | --- | --- |
| collab | collabv3 | sync.nimbalyst.com | `node scripts/deploy-changes.mjs` (nimbalyst-collab) | [/deploy-collab](./deploy-collab.md) |
| collab | web-console | Cloudflare Pages | same | same |
| collab | collabv3-metrics | nimbalyst-collabv3-metrics.pages.dev | same | same |
| npm | `@nimbalyst/cli` + `@nimbalyst/wiki-web` | npm, via `publish-cli.yml` | `node scripts/npm-publish-status.mjs` | [/publish-npm](./publish-npm.md) `cli` |
| npm | `@nimbalyst/extension-sdk` | npm, via `publish-extension-sdk.yml` | same | [/publish-npm](./publish-npm.md) `sdk` |
| wiki | Nimbalyst Wiki plugin (Claude Code and Codex) | `nimbalyst/nimbalyst-wiki`, and this repo's `main` for the `nimbalyst` marketplace | `node scripts/wiki-mirror-status.mjs` | step 4 below |
| marketplace | Marketplace Worker | extensions.nimbalyst.com | `node packages/marketplace/scripts/worker-status.mjs` | step 5 below |
| marketplace | Marketplace extensions | R2 CDN registry | `pnpm run marketplace:status` | [/release-extension](./release-extension.md) |

Out of scope: the desktop app (`/release-alpha`), iOS and Android, and the hand-written extensions list in the `nimbalyst-website` repo. If an extension ships to the marketplace for the first time, tell the user that list needs a manual entry.

## 1. Report

Run `git fetch origin && git status -sb` here, then every status command for the requested areas. They are independent, so run them in parallel. Show one table: target, status, and a short reason (the commit subjects that matter, not the full lists). Then add the notes that change a decision:

- **Unpushed commits on `main`.** The npm workflows build `origin/main`, and the `nimbalyst` plugin marketplace installs straight from it. Anything unpushed is not shippable through those channels yet.
- **Uncommitted watched files** in any report: that target does not ship until they are committed. They are often another session's work.
- **Over-reporting.** The collab, cli and wiki reports watch collab-bundle's inputs broadly, and package.json edits count as changes for the Worker. Read the commit subjects, and say when a target's changes do not reach what it ships (a desktop-only fix in `runtime/src/editor`, a scripts-only package.json edit).
- **Estimated baselines** (marked in the reports) can be off by a commit.

If nothing is due, say so and stop. With `--check`, stop here.

## 2. Choose and prepare

Ask with PromptForUserInput: a multiSelect of the due targets, pre-checked, minus any you flagged as over-reported. Then do every monorepo change the chosen targets need before anything deploys, so a single push covers them:

- npm version bumps ([/publish-npm](./publish-npm.md) step 3).
- The wiki plugin version bump when its status is `bump+stage`. Set the same version in `plugins/nimbalyst-wiki/.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (the history steps minor versions: 0.4.0, 0.5.0, 0.6.0; confirm the number).
- Then, after every bump above, run `node scripts/build-wiki-plugin.mjs --check`. If it reports stale, run `pnpm build:wiki-plugin` and include the result. The bundled server embeds the CLI version from `packages/cli/package.json`, so a rebuild before the cli bump leaves the old version in it and the pre-push gate refuses the push.

Commit these together with `mcp__nimbalyst__developer_git_commit_proposal` (`chore: release @nimbalyst/cli and @nimbalyst/wiki-web X.Y.Z`, or `chore: release Nimbalyst Wiki X.Y.Z` when only the plugin moved).

If `main` has unpushed commits, ask before `git push origin main`. The pre-push hook runs the test gate. Never force-push.

## 3. Ship, in this order

Later steps depend on earlier ones: the console, metrics, plugin and `nim` call collabv3 endpoints, and the wiki mirror bundles the same server and browser app the cli group publishes.

1. **collabv3**, then **web-console** and **collabv3-metrics**: [/deploy-collab](./deploy-collab.md) from step 2 on.
2. **Marketplace Worker**: step 5.
3. **npm**: [/publish-npm](./publish-npm.md) from step 4 on, `sdk` and `cli` independently.
4. **Wiki plugin**: step 4 below.
5. **Marketplace extensions**: [/release-extension](./release-extension.md) for each chosen extension.

Stop the chain at a failed step, unless the remaining targets do not depend on it (an extension release does not depend on the Worker deploy).

## 4. Wiki plugin mirror

`nimbalyst/nimbalyst-wiki` is generated output; never edit it by hand. The local clone is `../nimbalyst-wiki`.

1. The clone must be on `main`, clean, and current: `git -C ../nimbalyst-wiki status -sb`, then `git -C ../nimbalyst-wiki pull --ff-only`. If it has local changes, stop and ask.
2. Run `node scripts/stage-wiki-repo.mjs ../nimbalyst-wiki`. The plugin runs `@nimbalyst/cli` at its own version, so publish the cli group first ([/publish-npm](./publish-npm.md)). Staging refuses a stale plugin, a changed plugin without a version bump, a plugin whose pinned CLI is not on npm yet, and anything the Anthropic plugin directory would block or hold for a reviewer. If it refuses, go back to step 2 of this command.
3. Read `../nimbalyst-wiki/SOURCE`. If it says `(with uncommitted changes)`, stop: the staging is not reproducible from a commit.
4. Show `git -C ../nimbalyst-wiki status --short` and the diff stat. Ask before committing. Staging replaces the whole tree, so the commit stages everything in the clone (`git -C ../nimbalyst-wiki add -A`); that is safe only because the clone was clean in step 1. Use the mirror's own commit voice: `Nimbalyst Wiki X.Y.Z: <what users can now do>`.
5. Ask, then `git -C ../nimbalyst-wiki push origin main`.
6. Verify both channels the plugin's update check reads (`packages/cli/src/mcp/updateCheck.ts`):
   - `curl -s https://raw.githubusercontent.com/nimbalyst/nimbalyst/main/plugins/nimbalyst-wiki/.claude-plugin/plugin.json` reports the new version.
   - `gh api repos/nimbalyst/nimbalyst-wiki/contents/.claude-plugin/plugin.json -q .content | base64 -d` reports the new version. While that repository is private, the raw URL returns 404 to users, so installs from that marketplace get no update notice. Say so in the report.

Do not change `source` in this repo's `.claude-plugin/marketplace.json` as part of a ship. Pointing the `nimbalyst` marketplace at the mirror waits until the mirror is public.

## 5. Marketplace Worker

1. `pnpm --dir packages/marketplace exec tsc --noEmit -p .` and `pnpm exec vitest run packages/marketplace/__tests__`. Stop on failure.
2. Ask, then `pnpm --dir packages/marketplace run deploy:production`. It refuses uncommitted Worker sources and injects the version and commit.
3. `curl -s https://extensions.nimbalyst.com/health` must report the new version and a `commit` equal to `git rev-parse HEAD`. A null commit means the deploy predates `--var GIT_COMMIT`, or the var did not reach the Worker.
4. Commit `packages/marketplace/package.json` with `mcp__nimbalyst__developer_git_commit_proposal`, message `chore: deploy marketplace Worker vX.Y.Z`. Never tag it: tags in this repository reach the releases feed that the desktop app's update check reads.

## Report

One row per target: shipped, skipped (and why), or failed (at which step, and what state it left). Include the version, the verification you observed, and the commit, tag or workflow run URL. List anything committed but not pushed in either repository.
