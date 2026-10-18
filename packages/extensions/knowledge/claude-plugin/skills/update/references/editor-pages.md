# Editor pages

Besides markdown, a page can be a drawing, a spreadsheet, an interactive HTML page and the other types below. Each is a page in the tree like any other, placed under the page it explains, and shown inside that page by embedding it.

## Choosing a type

| Type (`documentType`) | File | Choose it for |
| --- | --- | --- |
| `html` | `.html` | A navigable map of the product or architecture, an interactive explainer, a timeline: anything a reader clicks through |
| `excalidraw` | `.excalidraw` | A drawing whose layout carries meaning: an architecture sketch, a screen flow someone will rearrange |
| `mindmap` | `.mindmap` | A branching outline people expand and reorganize |
| `datamodel` | `.prisma` | A database schema shown as an entity diagram |
| `mockup.html` | `.mockup.html` | One UI screen or wireframe |
| `csv` | `.csv` | A table of data people sort, filter and compute over |
| `calc.md` | `.calc.md` | A model of named numbers with units: pricing, capacity, unit economics |
| `canvas` | `.canvas` | Several pages laid out side by side and wired together: a review board, a flow of screens |
| `slides.md` | `.slides.md` | A presentation |

A small flow or sequence that reads top to bottom is a `mermaid` block in the page, not a drawing. A table of one type's pages is a placed view, not a spreadsheet. Notebooks (`ipynb`) and naming projects (`namenym`) are pages too, made in the desktop app. An animation (`.anim.json`) is not a page type.

## Creating one

Create the page with `createSharedDoc` (`documentType`, `title`, `parentFolderId` = the page it explains, and `initialContent` = the whole file in the format below; empty gives the editor's empty file). Then build it with that editor's tools, passing the page's `uri` as their `filePath`: `excalidraw_add_elements` and the other `excalidraw_*` tools for a drawing, `mindmap_*` for a mind map, `csv-spreadsheet_*` for a spreadsheet, `slides_*` for a deck, `datamodellm_get_schema` to read a data model. Types without tools (`html`, `mockup.html`, `calc.md`, `canvas`) are written whole as `initialContent`, and changed with `applyCollabDocEdit`.

A file that already exists in the repository is copied in with `importFileToPages`; never link its path. A Personal page can be any of these types too, but the editors' tools reach Team pages only: write a Personal page's whole file as `initialContent`, or build it as a file and copy it in.

## Embedding one in a page

A link alone in its paragraph shows the page live inside the one that links it. The title sets its size; leave it out to use the default.

- Team: `[Login flow](nimbalyst://doc/<documentId>?orgId=<orgId> "embedType=.excalidraw width=1000 height=600")`, with `orgId` from `listPages` (`consoleScope`) and the page's `id`. `embedType` is the file suffix from the table above and is required: an ordinary console link to the page stays a link.
- Personal: `[Login flow](https://console.nimbalyst.com/app/page/<id> "embedType=.excalidraw width=1000 height=600")`.

Embedded editor pages render live in the desktop app and in the team web console, at the `width` and `height` you set. Embed a page where the reader needs to see it; link it from a list.

## File formats

### html

A complete HTML document. It runs in a sandbox: scripts, styles, fonts and images may load over https (a library from a CDN is fine), but fetch, XHR and WebSocket are blocked and the page cannot reach the app. Put the data the page shows in the file itself.

- **Links navigate the app.** An ordinary `<a href>` opens its target in Nimbalyst: a console page link opens that page, `nimbalyst://NIM-123` opens that item, and a relative path opens that wiki file. For an SVG or a canvas where clicks are hit-tested in script, call `window.nimbalyst.navigate(href, { newTab: false })`.
- **Theme.** The app's colors are set as CSS variables on `:root`, with `color-scheme` and a `data-color-scheme` attribute of `light` or `dark`. Use them instead of fixed colors: `--nim-bg`, `--nim-bg-secondary`, `--nim-bg-tertiary`, `--nim-bg-hover`, `--nim-text`, `--nim-text-muted`, `--nim-text-faint`, `--nim-border`, `--nim-primary`, `--nim-link`, `--nim-success`, `--nim-warning`, `--nim-error`, `--nim-info`.
- **Embedded, it is interactive at once**: readers click and scroll inside it without selecting it first. Its height follows its content unless the link sets `height=`.

A module map whose boxes open the module pages:

```html
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; padding: 16px; background: var(--nim-bg); color: var(--nim-text); font: 14px system-ui, sans-serif; }
  .map { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }
  .layer { grid-column: 1 / -1; color: var(--nim-text-muted); font-size: 12px; text-transform: uppercase; }
  a { display: block; padding: 12px; border: 1px solid var(--nim-border); border-radius: 8px; background: var(--nim-bg-secondary); color: var(--nim-text); text-decoration: none; }
  a:hover { border-color: var(--nim-primary); }
  a small { display: block; color: var(--nim-text-muted); }
</style>
</head>
<body>
<div class="map">
  <div class="layer">Clients</div>
  <a href="https://console.nimbalyst.com/org/<orgId>/project/<projectId>/page/item/MOD-1">Desktop app<small>Electron, editors</small></a>
  <a href="https://console.nimbalyst.com/org/<orgId>/project/<projectId>/page/item/MOD-2">Web console<small>Team pages in a browser</small></a>
  <div class="layer">Server</div>
  <a href="https://console.nimbalyst.com/org/<orgId>/project/<projectId>/page/item/MOD-3">Collab server<small>Workers, Durable Objects</small></a>
</div>
</body>
</html>
```

Use real links copied from `listPages`, and keep the map to what a new reader needs to find their way.

### excalidraw

JSON. The empty file is `{"type":"excalidraw","version":2,"source":"https://excalidraw.com","elements":[],"appState":{"gridSize":null,"viewBackgroundColor":"#ffffff"},"files":{}}`. Build the elements with the drawing tools rather than writing element JSON by hand; they place shapes and bind arrows to labels.

### mindmap

A markdown outline with frontmatter: exactly one `#` root, `##` and `###` for the next levels, then `-` list items indented by two spaces. A `> ` line right after a node is its note, and `{color: green, status: todo}` after a node's text styles it.

```markdown
---
title: Launch plan
---

# Launch

## Product
- Pricing page
- Onboarding

## Marketing {color: blue}
> Owned by Dana.
- Launch post
```

### datamodel

A Prisma schema whose first line is the layout comment. Leave `positions` empty and the editor lays the models out.

```prisma
// @nimbalyst {"viewport":{"x":0,"y":0,"zoom":1},"positions":{},"entityViewMode":"standard"}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Team {
  id      String   @id
  name    String
  members Member[]
}

model Member {
  id     String @id
  email  String @unique
  team   Team   @relation(fields: [teamId], references: [id])
  teamId String
}
```

### mockup.html

A standalone HTML document with inline CSS and no external files: one screen, drawn as it would look. Use `html` instead when people should click through it.

### csv

Plain CSV. An optional first line `# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":0}` sets the header rows; without it, a first row of text is taken as the header. A cell starting with `=` is a formula with A1 references. Quote a cell that holds a comma or a quote.

```csv
# nimbalyst: {"hasHeaders":true,"headerRowCount":1,"frozenColumnCount":0}
Plan,Seats,Price,Monthly
Team,10,12,=B2*C2
Business,50,10,=B3*C3
Total,,,=SUM(D2:D3)
```

### calc.md

Frontmatter, then one entry per line: `# Section`, `name = expression` (values may carry units, like `100 USD` or `9.8 m / s^2`), an optional `-> currency(USD, 2)`, `-> percent(1)` or `-> number(0)` to format the result, `assert <expression>` to check one, and `// comment`. Any other line is prose.

```markdown
---
title: Seat pricing
baseCurrency: USD
display:
  decimals: 2
units: []
---

# Inputs
seats = 25
price = 12 USD
discount = 0.1

# Results
monthly = seats * price * (1 - discount) -> currency(USD, 2)
yearly = monthly * 12 -> currency(USD, 0)
assert yearly > 0 USD
```

### canvas

JSON Canvas: `{"nodes": [...], "edges": [...]}`. Every node has `id`, `type`, `x`, `y`, `width`, `height`. A card that shows a page live carries both the spec field and `x-nimbalyst.reference`:

- A team page: `"type": "link", "url": "nimbalyst://doc/<orgId>/<documentId>"`, with `"x-nimbalyst": {"reference": {"kind": "doc", "uri": "<the same url>"}, "label": "Login"}`.
- A note: `"type": "text", "text": "..."` (plain text, not markdown).
- Edges: `{"id": "e1", "fromNode": "a", "toNode": "b", "label": "then"}`.

The order of `nodes` is the drawing order: put a group before the cards inside it. Only write a card for a page you created or looked up.

### slides.md

Markdown with frontmatter (`theme`: `black`, `white`, `simple`, `night` and others; `transition`). A `---` line starts the next slide, and `Note:` starts the speaker notes of a slide.

```markdown
---
theme: white
transition: slide
---

# Q4 plan

---

## What we ship

- Teams beta
- Wiki in the browser

Note: Keep this to two minutes.
```
