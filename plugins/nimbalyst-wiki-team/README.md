# Nimbalyst Wiki Team

The `nimbalyst-team` server for [Nimbalyst Wiki](https://github.com/nimbalyst/nimbalyst-wiki): your team project's pages on Nimbalyst Teams. It has no skills of its own; the `nimbalyst-wiki` plugin's skills use it.

It is a separate plugin so that people who only use a local wiki are never asked to sign in. The `nimbalyst-wiki` plugin's `team` skill installs it when you move a wiki to a team or connect to one. To install it yourself:

- Claude Code: `claude plugin install nimbalyst-wiki-team@nimbalyst-wiki`, start a new session, then run `/mcp`, choose `nimbalyst-team` and Authenticate.
- Codex: `codex plugin add nimbalyst-wiki-team@nimbalyst-wiki`, then `codex mcp login nimbalyst-team`.
