# The strategic project wiki

The default wiki that setup builds. Home is a dashboard: it shows the whole project at once and every part of it is a way to drill in. Behind it sit five sections: Product and its Modules, Initiatives, Decisions, Team, and Strategy. Meetings and Glossary are offered in discovery and built only when the person picks them.

The skeletons below name each visual by the need it serves: the product map, the roadmap, impact against effort, positioning, the status of a set. Draw each with what the guide's "Our visual defaults" table names for that need. "On each wiki" at the end shows the base guide's defaults on each host; where the team changed a row, use their choice instead, and where it is missing or cannot be made here, follow the update skill's "Choosing a visual".

Syntax lives in the update skill's references; read the entry before writing a block: `../update/references/components.md` (callouts, columns, mentions, and every markdown component) and `../update/references/editor-pages.md` (editor pages and how to embed them).

## Rules for every page

- **Real data only.** Every module, initiative, owner, status, health, date, impact, effort, goal, competitor and axis value comes from the person, the project's own docs, plans and trackers, or a cited source. Never fill one in because a page looks empty.
- **Empty states say what is missing.** Where a part has no data yet, write a note in its place, not a placeholder:

  ```markdown
  > [!NOTE] Not filled in yet
  > No initiative has an impact and effort yet. Add both on each initiative's page to place it here.
  ```

  Name who can fill it in when the person told you. Leave out a whole part rather than draw a visual with fewer than two real points.
- **Links come from the tools.** Use the `link`, `viewLink`, marks view links and ids that `listPages` and `createSharedDoc` return; never build one from memory.
- **Start each body with text**, never the page title as a heading. Keep each page to what a reader needs; a dashboard is not a report.

## Order of work

1. The guide, then the section pages (Product, Initiatives, Decisions, Team, Strategy, and any offered ones picked) with empty bodies, so the types and typed pages have somewhere to go.
2. Types: Module, Initiative and Competitor (below), defined or reused in step 5 of the skill, and placed under their sections.
3. Module pages, one per module the person confirmed, then Initiative and Competitor pages the same way.
4. The product map under Product, built from the Module pages.
5. The section bodies, then Home last, because it embeds and links everything above.

## Types

Keep each one this small. Add a field only when the person asks for it.

| Type | Fields | Table columns |
| --- | --- | --- |
| Module | `layer` (string: the group it sits in on the map, such as Clients, Server, Data), `maturity` (select: planned, building, live, retired), `owner` (user) | layer, maturity, owner |
| Initiative | `status` (select: proposed, active, paused, done), `health` (select: on-track, at-risk, off-track), `owner` (user), `start` (date), `target` (date), `impact` (number, 1 to 5), `effort` (number, 1 to 5) | status, health, owner, target |
| Competitor | `category` (string), `website` (string), and two number fields from 0 to 1 named for the positioning axes the person gave (`devFirst`, `realtime`), only when they gave them | category, website |

Initiative is the one type that needs more than four fields: its header is the status line the dashboard reads. Give it `roles` so boards and timelines know its fields:

```json
{
  "type": "initiative",
  "displayName": "Initiative",
  "displayNamePlural": "All initiatives",
  "icon": "flag",
  "color": "#2563eb",
  "modes": { "inline": true, "fullDocument": true },
  "idPrefix": "init",
  "idFormat": "ulid",
  "fields": [
    { "name": "title", "type": "string", "required": true },
    { "name": "status", "type": "select", "options": [
      { "value": "proposed", "label": "Proposed" },
      { "value": "active", "label": "Active" },
      { "value": "paused", "label": "Paused" },
      { "value": "done", "label": "Done" }
    ] },
    { "name": "health", "type": "select", "options": [
      { "value": "on-track", "label": "On track" },
      { "value": "at-risk", "label": "At risk" },
      { "value": "off-track", "label": "Off track" }
    ] },
    { "name": "owner", "type": "user" },
    { "name": "start", "type": "date" },
    { "name": "target", "type": "date" },
    { "name": "impact", "type": "number" },
    { "name": "effort", "type": "number" }
  ],
  "roles": { "title": "title", "workflowStatus": "status", "assignee": "owner", "dueDate": "target" },
  "tableView": { "defaultColumns": ["status", "health", "owner", "target"] }
}
```

Module and Competitor follow the same shape. Before defining any of them, check `tracker_list_types` for a type that already holds modules, initiatives (an `epic` or `project` type) or competitors, and use it instead.

## Page tree

```
Home
How we write this wiki
Product
  Product map            (an editor page)
  Modules                (type)
Initiatives
  All initiatives        (type)
Decisions
Team
Strategy
  Competitors            (type)
Meetings, Glossary       (only when picked)
```

Place each type under its section with `moveSharedItem` (`kind: type`). Typed pages sit under their type. On a local wiki a type of pages is not a node in the tree: create its pages with `parentId` set to the section (Product, Initiatives, Strategy) instead.

## Module pages

Fields from discovery; leave a field empty when nobody said. The body:

```markdown
<What it does and for whom, one or two sentences.> <What it is built on or talks to, with links to those Module pages.>

<The decisions that shape it, as marked sentences, only those a person made.>
```

## Initiative pages

Fields from discovery; `health`, `impact` and `effort` only as the person gave them. The body:

```markdown
<What it changes and why now, two or three sentences.> <What done looks like.>

<Links to the modules it touches, and to its plan or tracker items.>
```

## Product map

A page titled "Product map" under Product, one box per Module page, grouped by `layer`. With the base default, an `html` page, each box is a link to its page: start from the module map in `editor-pages.md` and keep it that plain: the module's title, its one-line purpose, its maturity and owner in small text. Use the theme variables so it matches light and dark. Whatever the guide picks, order the layers from the user outward (clients, then services, then data), and rewrite the map when a Module page is added, renamed or removed.

## Home

Replace Nimbalyst's starter text (setup step 4). The dashboard, top to bottom:

````markdown
<What the project is, in one or two sentences, and who it serves.> <What this wiki is for, one sentence.>

<the product map, embedded>

## Initiatives

<the initiatives under way, with status and health>

## Decisions and open questions

<open questions, then recent decisions>

## Start here

<div data-columns="1fr 1fr">
<div data-column>

**Understand the product**

- [Product](<link>): who it serves and what it is made of
- [Team](<link>): who owns what and how we work
- [How we write this wiki](<link>)

</div>
<div data-column>

**Decide what's next**

- [Initiatives](<link>): the roadmap, and impact against effort
- [Strategy](<link>): goals, bets and competitors
- [Decisions](<link>): what was decided, and what is still open

</div>
</div>
````

Each angle-bracketed part is filled in as "On each wiki" below says. Drop a link whose section the person did not pick, and add Meetings or Glossary to the left column when they did.

## Product

```markdown
<Who it serves and the problem it solves, two or three sentences.> <What it is made of, one sentence.>

<the product map, embedded>

## Modules

<every module, with layer, maturity and owner>

## Who it serves

<The users or customers, in the person's words or the README's.>
```

## Initiatives

```markdown
<What counts as an initiative here, one sentence: work bigger than a task, with an owner and a target.>

## Roadmap

<the initiatives on a timeline from start to target>

## Impact and effort

<impact against effort: Effort across, Impact up; quadrants Quick wins, Big bets, Fill-ins, Thankless>

## All initiatives

<every initiative, with status, health, owner and target>
```

## Decisions

```markdown
Decisions are marked in the page they affect, so they stay next to what they change. This page gathers them. A decision gets a record of its own when no single page owns it, work hangs off it, or its reasons need more room.

## Open questions

<every open question>

## Decided

<recent decisions, newest first>
```

Add a question for the team (the guide's choice, a `decision` block by default) only for a choice the team has to make that came up in discovery, with the people the person named in `asked`. When the project has a decision type (`tracker_list_types`), add a "Records" section with that type's pages; never define a decision type for setup.

## Team

```markdown
<How the team is organized, one or two sentences.>

## Who owns what

- [@Dana Lee](mailto:dana@example.com): [Billing](<module link>), [Usage pricing](<initiative link>)

## How we work

<Where work is tracked (link it), how decisions get made, how a newcomer gets started; only what the person said.>

## Rituals

- <Meeting>, <cadence>: <what it decides>
```

Owners come from the Module and Initiative pages, so each owner's line links what they own. Write a mention only with an email the person or the team member list gave (`findOrgMembers`); otherwise write the name.

## Strategy

```markdown
<Where the project is headed, one or two sentences.>

## Goals

- <goal, with its measure when the person gave one>

## Bets

<Each bet as a sentence; a bet the person decided is a marked decided sentence, one still being weighed is an open mark.>

## Positioning

<positioning: us and the competitors on the two axes the person named>

## Competitors

<every competitor>
```

With no axes from the person, leave out Positioning and add an open question for it: `[Which two axes do we compete on?]{open by="<who owns strategy>"}`.

## Offered sections

- **Meetings:** one short section per recurring meeting: what it is for, its cadence and who attends. Decisions made in a meeting are marked in the pages they affect; this page is not for minutes.
- **Glossary:** one line per project term, alphabetical, linking the page that owns the concept.

## On each wiki

The base guide's defaults on each host. A row the team changed in its guide replaces the matching bullet.

### Team wiki from a terminal

Pages created from a terminal are markdown only, so this wiki cannot get its product map from here. Build everything else, and in Home's map slot place the modules as a board: `[Modules](<module viewLink> "mode=board group=layer cols=title,maturity,owner")`. Tell the person, in the report, that running setup again from the Nimbalyst desktop app adds the map and leaves the rest as it is; do not write a note about it into the page. If a "Product map" page already exists in the wiki, embed it instead (`editor-pages.md`).

Fill in the other parts with placed views, which work here:

- **Initiatives:** `[Initiatives](<viewLink> "cols=title,status,health,owner,target filter=status:active|proposed sort=target:asc")`.
- **Decisions and open questions:** the open marks view, then the decided one (`openMarksViewLink` from `listPages`, and the same link with `kind=decided`).
- **Modules, All initiatives, Competitors:** placed views of their type, with the columns in the table above.
- **Roadmap:** `[Roadmap](<viewLink> "mode=timeline start=start end=target cols=title,owner,health")`.
- **Impact and effort:** `[Impact and effort](<viewLink> "mode=2x2 x=effort y=impact xl=Effort yl=Impact q=Quick%20wins|Big%20bets|Fill-ins|Thankless")`.
- **Positioning:** a view of the Competitor type with `mode=2x2` on its two axis fields, with `pin=` for this project's own position as the person gave it.
- **Who owns what:** add `[Modules by owner](<module viewLink> "cols=title,maturity group=owner")` under the list.
### Local wiki

A local wiki has no placed views, no marks lists and no relations, but it does hold `html` pages, and the browser view shows callouts, columns, mermaid, `chart` and `2x2` blocks. Types are YAML files (setup's "On a local wiki"); write the Initiative type above as `.nimbalyst/trackers/initiative.yaml` with `storage: pages`. Typed pages are created with `tracker_create` and `parentId` = their section page; a type of pages has no page of its own in the tree, so every list of modules, initiatives or competitors is written on the section page. Links are relative paths with the target's id.

- **Product map:** `createSharedDoc` (`documentType: html`, `parentFolderId` = Product, `initialContent` = the whole page), each box's `href` the Module page's path relative to the map's file. Embed it alone in its paragraph with its path relative to the embedding page: `[Product map](Product/Product%20map.html "id=<id>")`.
- **Initiatives on Home:** one line per active or proposed initiative, linking its page, with its health and owner: `- [Usage pricing](Initiatives/All%20initiatives/Usage%20pricing.md "id=<id>"): at risk, Dana Lee, target 2026-12-01`. Then a link to the Initiatives page.
- **Decisions and open questions:** an index on the Decisions page, newest first, one line per mark linking the page that holds it: `- 2026-10-02, decided: [Pricing](../Strategy.md "id=<id>"), seats rather than usage`. Home shows the latest three of each, and links the rest.
- **Modules, All initiatives, Competitors:** a list on the section page, one line per typed page with a link and its key fields. On Product, group the modules by layer.
- **Roadmap:** a `mermaid` gantt of the initiatives that have both dates, one `section` per status. A title may not contain `:` or `#`.

  ```mermaid
  gantt
    dateFormat YYYY-MM-DD
    section Active
    Usage pricing :2026-09-15, 2026-12-01
  ```

- **Impact and effort:** a `2x2` block of the initiatives that have both values, each value written as `(value - 0.5) / 5`, so 1 to 5 spreads from 0.1 to 0.9: `x: Effort`, `y: Impact`, `quadrants: Quick wins | Big bets | Fill-ins | Thankless`. Axis captions name the axis; an arrow in them shows as text.
- **Positioning:** a `2x2` block of the competitors' axis values as the person gave them, with this project highlighted (`!`), its captions the two axis names.

These are snapshots. When an initiative's fields change, a mark is added, or a module is added or renamed, update Home, the Initiatives page, the Decisions index and the map in the same pass.
