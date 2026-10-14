# Nimbalyst Wiki

A local wiki your agents write for you, so you can think, organize, and set direction. It holds what the team decided and why, in the page each decision affects, with the person's own words cited. Agents read it for context before they work and record what was settled when they finish.

There are two kinds of wiki, and you can use either or both:

- **Local wiki**: a folder of markdown files in your repository. No account, no server. Keep it private to your checkout (`nimbalyst-local/wiki`, ignored by git) or check it in (`docs/wiki`) so teammates get it through git.
- **Team wiki**: a Nimbalyst Teams project's pages, shared live on the Nimbalyst server, with comments, history and access managed by your team.

You can work with the wiki from these places, all on the same pages:

| | Local wiki | Team wiki |
| --- | --- | --- |
| Claude Code (this plugin) | yes | yes |
| Codex (this plugin) | yes | yes |
| Nimbalyst app | Wiki mode, Local section | Wiki mode, Team section |
| `nim` command line | `nim wiki ...` | `nim wiki ...` |
| Browser | ask your agent to open it, or `nim wiki serve` | the Nimbalyst web console |

You don't need the Nimbalyst app for any of this. The plugin needs Node.js 22 or later on your `PATH`.

## Claude Code

### Install

In Claude Code:

```
/plugin marketplace add nimbalyst/nimbalyst-wiki
/plugin install nimbalyst-wiki@nimbalyst-wiki
```

Claude Code only reports that the install succeeded; it does not start any onboarding. Next, run:

```
/nimbalyst-wiki:setup
```

Your agent builds the first version of the wiki: Home, a writing guide, and starter pages based on this repository. Later, use `/nimbalyst-wiki:capture` at the end of sessions to record what you decided. For a short tour instead, run `/nimbalyst-wiki:start`.

### Updating

Claude Code does not update plugins from this marketplace unless you turn on auto-update for it (`/plugin`, then Marketplaces). To update by hand, run both commands, then restart Claude Code:

```sh
claude plugin marketplace update nimbalyst-wiki
claude plugin update nimbalyst-wiki@nimbalyst-wiki
```

The first command only refreshes the list of versions; the second installs the new one. Once a day the plugin checks GitHub for a newer version, and if there is one, Claude mentions it with these commands the next time it uses the wiki. The check sends nothing about you or your wiki. Set `NIMBALYST_WIKI_NO_UPDATE_CHECK=1` to turn it off.

### Updating from 0.3.0

Version 0.3.0 was installed from the `nimbalyst/nimbalyst` marketplace. Switch to this one so you get updates and the browser view:

```
/plugin uninstall nimbalyst-wiki@nimbalyst
/plugin marketplace remove nimbalyst
/plugin marketplace add nimbalyst/nimbalyst-wiki
/plugin install nimbalyst-wiki@nimbalyst-wiki
```

Then restart Claude Code. Your wiki is files in your repository, so nothing in it changes. `/plugin` shows the installed version.

The plugin brings three MCP servers. `/mcp` lists them:

- `nimbalyst-local`: the local wiki, plus the browser view of it. Runs on your machine and needs nothing else installed. When you move the wiki to a team, it signs in to Nimbalyst on its own to copy the pages.
- `nimbalyst-team`: the team wiki on the Nimbalyst server. It asks you to sign in to Nimbalyst the first time you connect it in `/mcp`. Leave it disconnected if you only use a local wiki.
- `nimbalyst-session`: lets Claude cite what you typed in this session when it records a decision. It reads only this session's transcript, on your machine.

### Skills

- `/nimbalyst-wiki:start` is a short tour: what the plugin does, which skills exist, and how to begin with a local or team wiki.
- `/nimbalyst-wiki:setup` builds a wiki that is useful from day one: it asks a few questions about who the wiki is for, then writes a Home page, the writing guide ("How we write this wiki") and a handful of starter pages from your project's README and docs. It can also define types (below). Running it again fills gaps and never duplicates or overwrites what people wrote.
- `/nimbalyst-wiki:capture` records what this session decided. Claude lists the decisions, answered questions and open questions from the conversation, finds the page each one affects, and writes it there. If nothing is worth keeping, it says so.
- `/nimbalyst-wiki:team` moves the wiki to Nimbalyst Teams: sign-in, creating or choosing the team project, moving the local wiki, opening it in the browser and inviting teammates. See [From a local wiki to Teams](#from-a-local-wiki-to-teams).
- `/nimbalyst-wiki:update` is the writing guide Claude follows for every wiki edit. You rarely call it yourself.

You can also just ask: "start a wiki for this repo", "what does the wiki say about auth?", "add a page about our deploy process", "open the wiki in my browser".

### Reading the wiki in your browser

Ask Claude to open the wiki in your browser. It starts a server on your machine and opens a tab with the page tree, the page editor, typed pages and type tables. Drawings (Excalidraw), mind maps, CSV spreadsheets, calc sheets, data models, mockups and project canvases open in their own editors and can be created from the New page menu. Edits save straight to the files, and pages Claude writes show up while you watch. The server only accepts connections from this machine, with the token in the link, and stops when the session ends.

### Which wiki Claude uses

At the start of wiki work Claude decides once per session:

1. If you name one ("the team wiki", "the local wiki"), it uses that.
2. If the repository has a local wiki, it uses it. If the repository is also connected to a team project, it asks which.
3. Otherwise it checks for a team project connected to this repository's git remote. If there is none, it offers once to start a local wiki: private in this checkout, checked in under a folder you choose, or not now.

It never writes the same thing to both. Team data never goes through the local server.

### From a local wiki to Teams

When the wiki should be shared with your team, run:

```
/nimbalyst-wiki:team
```

Claude walks you through it:

1. **Sign in.** Claude asks you to run `/mcp`, choose `nimbalyst-team` and Authenticate. A browser page opens where you sign in to Nimbalyst or create an account. Claude cannot start this step for you.
2. **Team and project.** With no team yet, Claude proposes a name and creates the team, its first project and a Home page, connected to this repository's git remote. If you are already in a team, you can connect the repository to one of its projects (team admins), create a project, or create a new team.
3. **A second, one-time approval.** The local server signs in with the same account, so the pages go straight from your files to Nimbalyst without passing through the conversation. Claude opens the approval page; you confirm the code. This is the same sign-in as `nim login`.
4. **The move.** Claude first shows what will move (pages, typed pages, types, and anything that cannot move yet, such as drawings), then moves everything in one step: hierarchy, order, fields and the links between pages, which now point at the team pages. If it is interrupted, running it again picks up where it stopped.
5. **The browser.** Claude opens the team wiki in your browser.
6. **Invites.** Claude can invite teammates by email (it reads the list back to you before sending anything) or create an invite link.

Your local files are not deleted. After a verified move, `.nimbalyst/local-wiki.json` records where the wiki went (`migratedTo`), the local Home gets a line linking to the team wiki, and agents use the team wiki from then on. Commit `.nimbalyst/wiki.json` so your teammates' agents find the same project.

From a terminal, `nim login` and then `nim wiki move-to-team` (add `--dry-run` to see what would move) does the same move.

### If you were invited

An invite email or link signs you in to Nimbalyst in the browser and opens the team's wiki. You can read, edit and comment there with nothing installed.

To use the wiki from Claude Code too, install this plugin (above), run `/mcp`, choose `nimbalyst-team` and Authenticate with the same email. If the repository has a committed `.nimbalyst/wiki.json`, your agent uses that team project right away; otherwise it finds the project through the repository's git remote.

### How decisions are recorded

A decision is a marked sentence in the page it affects, not a separate record:

```markdown
[We store and evaluate flags in Flagship.]{decided by="Dana Lee" email=dana@example.com on=2026-09-30 over="our own Durable Object store"}
```

Open questions use the same form with `open`. When the person's own words support a statement, Claude adds a citation copied from this session's transcript. It never invents a decision, a reason or a quote. On a local wiki the name and email come from `git config user.name` and `git config user.email`.

After a session with real work in it (a commit, a plan, or several file edits), the plugin reminds Claude once to run `/nimbalyst-wiki:capture` before it stops. Set `NIMBALYST_WIKI_NUDGE_MIN_EDITS` to change how many edits count.

### If you also use the Nimbalyst app

Inside the Nimbalyst app, agents already have the wiki tools, and the plugin stands aside so there is one write path per page.

## Codex

The same plugin installs in the Codex CLI:

```sh
codex plugin marketplace add nimbalyst/nimbalyst-wiki
codex plugin add nimbalyst-wiki@nimbalyst-wiki
```

It brings the same skills (`nimbalyst-wiki:start`, `setup`, `capture`, `update`, `connect`, `team`), the same three MCP servers (`codex mcp list` shows them) and the same browser view. Sign in to the team wiki with `codex mcp login nimbalyst-team`.

To update, run `codex plugin marketplace upgrade nimbalyst-wiki` and start a new session; that one command installs the new version. The plugin checks for a newer version once a day and Codex mentions it the next time it uses the wiki, as in Claude Code.

Two differences from Claude Code:

- Codex does not run hooks that come with a plugin, so there is no reminder to capture decisions at the end of a session. Ask for it ("record what we decided in the wiki").
- `nimbalyst-session` reads Claude Code transcripts only, so decisions recorded from Codex are marked with your name but carry no quote from the session.

## Other agents

Cursor, VS Code, the Claude desktop app and any other MCP client use the wiki through `nim mcp`, the same local server the plugin bundles. Install the `nim` command line (Node.js 22 or later):

```sh
npm install -g @nimbalyst/cli
```

Then add the server to the agent's MCP settings:

- **Cursor**, in `.cursor/mcp.json`: `{ "mcpServers": { "nimbalyst-wiki": { "command": "nim", "args": ["mcp", "--workspace", "${workspaceFolder}"] } } }`
- **VS Code** (Copilot in agent mode), in `.vscode/mcp.json`: `{ "servers": { "nimbalyst-wiki": { "command": "nim", "args": ["mcp", "--workspace", "${workspaceFolder}"] } } }`
- **Claude desktop app**: the same `mcpServers` entry with the project's full path in place of `${workspaceFolder}`. If the app cannot find `nim`, use the path `which nim` prints.

Then ask the agent to start a wiki for this repo. These agents get the wiki tools but not the plugin's skills (`setup`, `capture` and the writing guide), so ask for what you want in your own words. To open the wiki in the browser from these agents, also install the browser app: `npm install -g @nimbalyst/wiki-web`.

## Nimbalyst app

Open **Wiki** in the navigation gutter (Cmd+D).

- **Local** is the local wiki of the open project. Pages open as ordinary file tabs. Drawings, mind maps, data models, mockups and spreadsheets can be pages too; each keeps its own file.
- **Team** is the team project's wiki, when the project is shared with a team.
- Pages you kept in the app's older Personal section still show. Use **Export** in the section's menu to copy them into the wiki folder as files. The originals are kept.
- **Copy to Wiki...** on any file in the Files tree copies it in as a page.

The app and `nim` find the wiki the same way: the folder named in `.nimbalyst/local-wiki.json` (`{ "location": "docs/wiki" }`), else `nimbalyst-local/wiki`. In a git worktree the wiki is the main checkout's, so every worktree shares one.

## `nim` command line

```sh
npm install -g @nimbalyst/cli
```

You don't need `nim` to use the plugin. It is for working with the wiki from scripts and your own terminal. Requires Node.js 22 or later. `nim wiki` works on both wikis.

```sh
nim wiki init                         # create the local wiki (nimbalyst-local/wiki, ignored by git)
nim wiki init --location docs/wiki    # or a checked-in folder
nim wiki list                         # the page tree
nim wiki read "Product"               # a page by title, path or id
echo "..." | nim wiki write "Notes" --create
nim wiki search "deploy"
nim wiki move "Notes" --parent "Product"
nim wiki serve                        # open the wiki in your browser
```

- `list`, `read`, `move` and `search` use the local wiki when the project has one, and the team wiki otherwise. `--team` or `--local` picks one.
- `write` replaces a page body from stdin or `--file`. With `--expected-version` (from `read --json`) it refuses to overwrite a page that changed since you read it.
- Team-only commands (`status`, `edit`, `create`, `items` and more) need `nim login`. `nim --help` lists them all.
- `nim tracker list/get/create/update` work on typed pages in the local wiki.
- `nim mcp` runs the local wiki's MCP server on stdio, for agents other than Claude Code: `claude mcp add nimbalyst-local -- nim mcp` is the equivalent of the plugin's local server.

### `nim wiki serve`

The same browser view as the plugin's, from a terminal. It opens the local wiki in your browser to read and edit: the page tree, pages in the same editor as the app, typed pages with their fields, type tables, and drawings, mind maps, spreadsheets, calc sheets, data models, mockups and canvases in their own editors. Edits save straight to the files, and changes made in your editor or by an agent show up live.

The server listens on this machine only and requires the token in the URL it opens. The browser app is a separate package; the first time, `nim` prints the command to install it:

```sh
npm install -g @nimbalyst/wiki-web
```

`--no-open` prints the URL instead of opening a browser; `--port` picks the port.

## The files

A local wiki is plain files you can read, edit, diff and commit without any Nimbalyst tool. The full contract is [FORMAT.md](../../packages/local-wiki/FORMAT.md); in short:

```
nimbalyst-local/wiki/
  .nimbalyst-wiki.yaml          format version
  Home.md
  How we write this wiki.md
  Product.md
  Personas.md
  Personas/                     a page's children live in a folder of the same name
    CMO.md
    CMO.activity.jsonl          change log of a typed page
  Partners.csv                  a table type: one row per item
  .trash/                       deleted pages, restorable
```

- **Pages** are `<Title>.md`. Renaming a page renames its file and its child folder.
- **Frontmatter** is flat: `id` (never changes), `order`, and for a typed page `type` plus its fields.
- **Links** between pages are relative paths that carry the target's id: `[CMO](Personas/CMO.md "id=01M4...")`. They work on GitHub and in any editor. Nimbalyst rewrites them when a page moves, and repairs links broken by a move done outside Nimbalyst on its next scan.
- **Types** are defined in `.nimbalyst/trackers/<type>.yaml`. A type whose definition says `storage: pages` keeps one markdown page per item; `storage: table` keeps all its items as rows of one CSV. Types without `storage:` (bugs, tasks) stay in the app.
- **Deleting** moves files to `.trash/`, from where a page can be restored. Files are only removed when an item is deleted from the trash itself.

Agents can edit the files directly too. The MCP tools and `nim` add what plain edits do not: ids, ordering, link rewriting on moves, type fields, CSV rows and trash.
