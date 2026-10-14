---
paths:
  - "packages/electron/src/renderer/help/**"
  - "packages/electron/src/renderer/walkthroughs/**"
  - "packages/electron/e2e/walkthroughs/**"
  - "**/HelpContent*"
  - "**/HelpTooltip*"
  - "**/Walkthrough*"
---

Read [docs/HELP_WALKTHROUGHS.md](../../docs/HELP_WALKTHROUGHS.md) before changing help content or walkthroughs. Key points:

- `HelpContent.ts` is the registry of help text, keyed by `data-testid`
- Wrap elements that need hover help in `HelpTooltip`
- Walkthrough definitions go in `walkthroughs/definitions/`
- Add `data-testid` to any element that needs help content
