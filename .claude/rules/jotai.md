---
paths:
  - "**/store/**"
  - "**/atoms/**"
  - "**/*Atom*.ts"
  - "**/*Atom*.tsx"
---

Read [docs/JOTAI.md](../../docs/JOTAI.md) before adding or changing atoms. Key points:

- Derived atoms for session state, so UI and state cannot diverge
- No dynamic imports inside atoms
- Derived atoms stay synchronous
- Parents subscribe to lists of ids, children to their own atoms; needing `React.memo` means the atom shape is wrong
