# mode-controller

**The problem it solves:** an agent that can write files and push commits can
do that at any point in a conversation, including while you are only asking it
questions. mode-controller makes the set of available tools an explicit,
switchable choice, so a mode like `ask` physically cannot edit, commit, or push
— the tools are not registered while that mode is active.

A pi extension that gates tool access and appends system-prompt instructions
based on the currently selected operating mode. Modes are defined by data
files, not code: each `*.md` file in `modes/` defines one operating mode. The
mode name is the filename without extension (`build.md` → `build`).

Switch modes with `/mode <name>`. `/mode` re-reads the `modes/` directory
every time it runs, so editing those files takes effect immediately — no
`/reload` needed.

## Mode file format

Each file in `modes/`:

```yaml
---
tools: [read, grep, find, ls] # required: active tool names for this mode
order: 10 # optional: cycle position; lowest is the startup mode
writePaths: ["**/*.md"] # optional: restrict edit/write/delete to matching paths
label: "💬 ask" # optional: shown in the footer status; defaults to the mode name
cycle: false # optional: exclude from shift+tab (still reachable via /mode); default true
---
Prompt text appended to the system prompt while this mode is active.
```

- `tools` — the exact set of tools active while this mode is selected. It is a
  complete allowlist: any tool not listed here is deactivated and blocked while
  this mode is active, whatever extension registered it.
- `writePaths` — when present, restricts the `edit`, `write` and `delete` tools
  to paths matching at least one glob (`*`, `**`, `?` supported, matched
  relative to the project root). Omit it for unrestricted write access.
- `order` — position in the `/mode` list and the shift+tab cycle. The lowest
  `order` is the mode used at startup. Values are spaced (10, 20, 30, …) so a new
  mode can be slotted in without renumbering; a mode with no `order` sorts after
  every mode that has one.
- `cycle: false` — removes this mode from the shift+tab cycle, without
  removing it from `/mode`, its autocomplete, or the "Available modes" text.
  `danger` sets this: shift+tab should never be a way to land in the one mode
  with unrestricted shell access by mashing a key one time too many; typing
  `/mode danger` deliberately is unaffected. Every other consumer of mode
  ordering (autocomplete, startup, the missing-mode fallback) keeps using the
  full, unfiltered order.
- If `modes/` has no valid `*.md` files, the extension does nothing:
  `/mode` reports the problem instead of silently falling back to any
  built-in defaults.
