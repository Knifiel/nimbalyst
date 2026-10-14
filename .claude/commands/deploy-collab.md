---
description: Deploy the collab server, web console and/or metrics console, whichever changed since its last deploy
argument-hint: "[collabv3|web-console|collabv3-metrics] [--check]"
allowed-tools: Bash, Read, Edit, mcp__nimbalyst__AskUserQuestion
---

Deploy `collabv3` (sync.nimbalyst.com), `web-console` and/or `collabv3-metrics` (the internal operations console at nimbalyst-collabv3-metrics.pages.dev) to production, but only the ones whose deployed artifact has changed since its last `<pkg>-vX.Y.Z` tag. All three live in the sibling `nimbalyst-collab` repo. collabv3 and web-console are built partly from this repo through `link:` dependencies, so a change here can require a deploy there. collabv3-metrics is built only from its own package.

This is one step of [/ship](./ship.md), which also covers npm, the wiki plugin and the extension marketplace.

Arguments: `$ARGUMENTS`. A package name limits the run to that package. `--check` reports what changed and stops without deploying.

Run every command below from the `nimbalyst-collab` root (`../nimbalyst-collab` relative to this repo's root). Commits there use plain `git commit`, staging only the named paths.

## 1. Find what changed

```bash
node scripts/deploy-changes.mjs [<pkg>]
```

For each package it diffs the files that actually reach the artifact (collabv3: wrangler's esbuild inputs; web-console: its own sources plus the stravu-editor modules in collab-bundle's bundle report and the linked extension repos; collabv3-metrics: its own package) against the last deploy tag, in every repo involved. It lists the commits and any uncommitted watched files.

Show the user the report. If nothing changed, say so and stop. With `--check`, stop here.

Read the notes. A baseline marked "estimated from tag date" comes from a tag written before deploys recorded their sources, so it can be off by a commit or two. A missing bundle report means stravu-editor is watched broadly and may over-report.

## 2. Gate on uncommitted work

If a package to deploy has any `UNCOMMITTED` files in any repo, do not deploy it. Those edits are often another session's work in progress. List them and use AskUserQuestion: wait for them to be committed, skip that package, or deploy only the other one. Never pass `--allow-dirty`.

## 3. Deploy, collabv3 first

When several changed, finish collabv3 completely before starting web-console or collabv3-metrics, since both can depend on new server endpoints and metrics reads collabv3's D1 schema. For each package:

1. **Changelog.** Read `packages/<pkg>/CHANGELOG.md`. Every user-visible or operational change in the reported commits, from any repo, needs a bullet under `## [Unreleased]` (create it if absent; group under Added / Changed / Fixed / Removed / Security). Most stravu-editor commits will not have one yet. Skip commits with no effect on this artifact (refactors, desktop-only behavior that happens to touch a shared file). Follow the existing voice in that file. If no reported commit has an effect, tell the user and ask whether to deploy anyway.
2. **Verify.** collabv3: `pnpm --dir packages/collabv3 run typecheck && pnpm --dir packages/collabv3 test`. web-console: the deploy builds and typechecks it. collabv3-metrics: `pnpm --dir packages/collabv3-metrics test`; the deploy builds and typechecks it. Stop on failure.
3. **Deploy.** `./scripts/deploy.sh <pkg> patch`. If it reports pending D1 migrations, show the list and ask before re-running with `--migrate`. collabv3-metrics cannot apply migrations; if it reports pending ones, deploy collabv3 with `--migrate` first. If the migration-state read fails with Cloudflare 7403, retry it once before believing it; it has been transient.
4. **Confirm it landed.** collabv3: `curl -s https://sync.nimbalyst.com/health` must report the new version. web-console: fetch the deployment URL wrangler printed and expect 200. collabv3-metrics: it is behind Cloudflare Access, so the deployment URL answers 302 to the Access login; anything else means it did not land. Say so if a check does not match.
5. **Tag.** Retitle `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, then run the commit and `git tag -a ... -F ...` commands deploy.sh printed. The tag message records the linked-repo commits, which is the next run's baseline.

Do not push unless the user asks.

## Report

Per package: deployed or skipped (and why), version, verification result, whether migrations were applied, commit SHA and tag. If something failed midway, say which step and what state it left (a bumped but uncommitted `package.json` is the usual leftover).
