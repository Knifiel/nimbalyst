## Token discipline

This repo runs a very high volume of sessions, most of them spawned by orchestrators or automations. Keep each session's context lean.

- Fan wide reads out to an `Explore` or `general-purpose` agent and keep only its conclusion. A single targeted `Read` beats a wide grep when you know the file.
- Do not re-derive what a sibling already produced; use `get_session_summary` or `get_workstream_overview`.
- Load MCP tool schemas on demand with `ToolSearch`.
- Check `automations_list` and the `github-pr` tracker before creating a duplicate automation or review session.
- Match effort to the task: no `/design` plan for a one-line fix, no re-running a command whose output you already have.
- Tests are context every later session pays for. The corpus is about 2M tokens. Extend an existing file, and do not test what a human would see on screen in one second.
- Move shipped or complete project memories to `MEMORY-archive.md`; recall still finds them.
