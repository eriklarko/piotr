# Plan: Scoped `git` and `make` tools (no bash)

## Goal

Replace the general `bash` tool with narrow, allowlisted tools for git and make. Search is
already covered by the built-in `find`/`grep` tools — do not build a `code_search` tool.

## What this actually buys you (be honest)

Removing bash removes *arbitrary* command execution. It does **not** make the agent safe:

- `git` mutations (`reset --hard`, `checkout .`, `push --force`) destroy work with no shell.
- `make <target>` runs arbitrary shell from the Makefile. Removing bash from the front door
  and adding `make` opens it at the side.

So the safety story is two independent layers, and the second is the one that matters:

1. **Scoping** (no shell, no raw flags, typed params per subcommand) — makes intent *legible*.
2. **Per-call approval on every mutating action** — the actual control.

`pi.exec(cmd, args)` spawns the binary directly: no `;`, `|`, `&&`, `$()`, redirection, or
globbing the model controls. The model fills typed argument fields only.

### No raw args passthrough (this is the whole point)

git is a shell delivery mechanism. `git -c core.pager='sh -c ...' log`, `core.sshCommand`,
`diff.external`, `*.textconv`, aliases, hooks — a dozen config keys and flags run arbitrary
commands. A `git` tool with `args: string[]` passthrough makes the allowlist decorative: the
model reimplements anything, including shell exec, by chaining flags git already exposes.
A denylist can't win against git's flag surface.

So: **structured params per subcommand, no `args` array.** The model can only express what we
model. Missing a flag is intentional — complex git invocations are a smell (an agent losing
the plot), and an awkward path there is the tool working, not failing. Add flags when a human
actually hits the wall, never preemptively.

## Design decisions

- **One extension, one tool per git subcommand + one `make` tool.** File:
  `.pi/extensions/scoped-tools/index.ts` (project-local) or `~/.pi/agent/extensions/` (global).
- **typebox schemas** for parameters (required by `pi.registerTool`).
- **No subcommand-string + args passthrough.** Each git subcommand is its own tool with typed
  params. The set of tools *is* the allowlist; there is nothing to validate an `args` array for.
- **Disable `bash`** via `pi.setActiveTools(...)` on `session_start`, keeping only the safe
  toolset: `read`, `grep`, `find`, `ls`, `edit`, `write`, plus the new `git`/`make`.
- **Defense-in-depth `tool_call` gate that blocks `bash` outright** even if re-enabled.
- **`promptSnippet` + `promptGuidelines`** so the model knows when to reach for each tool.
- **`signal`** threaded into `pi.exec` for Esc-cancellation; **`timeout`** to avoid hangs.
- **Structured results.** Return stdout as text content; put exit code / stderr in `details`.

## Search: use built-ins, build nothing

pi already ships `find` and `grep` (shell-free). No `code_search` tool.

## Git tools (one per subcommand, typed params, no raw flags)

Start with the 90% path. Each is a separate `pi.registerTool` call. Every tool builds a fixed
`argv` from its typed params — no model-supplied flag strings ever reach `pi.exec`.

**Read-only (auto-allow):**
- `git_status` — no params. → `git status`
- `git_log` — `{ maxCount?: number, oneline?: boolean, paths?: string[] }`.
  → `git log [-n N] [--oneline] [-- paths]`
- `git_diff` — `{ staged?: boolean, base?: string, head?: string, paths?: string[] }`.
  → `git diff [--staged] [-- paths]`, or `git diff <base>..<head> [-- paths]` when
  `base`/`head` are both given (required together; incompatible with `staged`).

**Mutating (per-call `confirm`):**
- `git_add` — `{ paths: string[] }` (required, non-empty). → `git add -- <paths>`.
  No `-A`/`.` shorthand; explicit paths only, shown in the confirm prompt.
- `git_commit` — `{ message: string, amend?: boolean }`. → `git commit -m <msg> [--amend]`
- `git_push` — `{ remote?: string, branch?: string }`. → `git push [remote] [branch]`.
  No `--force`. Validate remote/branch as identifiers (no leading `-`, no spaces).

Mutating-vs-read-only is a property of *which tool*, so the `tool_call` gate just checks the
tool name against a `Set` of mutating tool names. No subcommand parsing.

Add more (`git_show`, `git_branch`, `git_fetch`, `git_stash`) only when you actually reach for
them. `config`, `remote` (set-url), `rebase`, `reset` are intentionally absent — add
deliberately, never by passthrough.

## Tool 2: `make`

Purpose: run make targets, nothing else.

- Params:
  - `target`: `Type.Optional(Type.String())` — the make target (default target if omitted).
  - `vars`: `Type.Optional(Type.Array(Type.String()))` — `VAR=value` assignments; validate each
    matches `^[A-Za-z_][A-Za-z0-9_]*=.*$` so they can't be flags.
  - `directory`: `Type.Optional(Type.String())` — passed as `-C <dir>`.
- Executes: `pi.exec("make", ["-C", dir, ...vars, target], { signal, timeout })`.
- Guard: reject a `target` that starts with `-` (prevents `make --eval=...` injection) and
  reject spaces in the target so it can't smuggle extra args.
- **`make` always requires per-call approval** — it runs arbitrary shell from the Makefile.
  It is not a "safe" tool; it is a trusted-Makefile tool.

## Makefile protection (the real threat, per your #2)

"Makefile trusted, but modifications extremely hard" cannot be enforced by the `make` tool.
The attack path is: agent `edit`s the Makefile to add a malicious recipe, then runs
`make <innocent-target>`. By exec time the target name looks fine. So protection must live on
`write`/`edit`, independent of `make`:

- A `tool_call` handler intercepts `write`/`edit` when the resolved path is a make file:
  basename in `{Makefile, makefile, GNUmakefile}` or extension `.mk`.
- **Block outright** (return `{ block: true }`). "Extremely hard" = not editable by the agent
  at all. If a legit change is needed, the human does it.
- **Resolve the path first** (`path.resolve(ctx.cwd, input.path)`), then match the basename.
  Do NOT use `path.includes("Makefile")` — substring matching is wrong (misses absolute
  paths, false-positives on `Makefile.bak.md`). The shipped `protected-paths.ts` example has
  this exact bug; do not copy it.

## Approval mechanism details (verified against pi examples)

- Approve/deny via `tool_call` handler returning `{ block: true, reason }`; prompt with
  `ctx.ui.confirm(title, body)` before deciding.
- **Fail closed when there is no UI.** In print/JSON mode `ctx.hasUI` is false and `confirm`
  can't run. The shipped examples `return` (fail open) on `!ctx.hasUI` — for a security gate
  that is wrong. Block the mutation when `!ctx.hasUI`.
- Per-call, no remembering (your #3). Every mutating call re-prompts.

## Guardrails common to all tools

- Validate every model-supplied string; reject tokens starting with `-` except where a flag is
  explicitly modeled by us.
- Never interpolate model input into a shell string. Always pass `argv` arrays to `pi.exec`.
- Wrap `pi.exec` in try/catch; return `{ isError: true, content: [...] }` on non-zero exit,
  including stderr so the model can react.
- Truncate very large stdout (keep first N KB) to protect the context window.
- Thread `signal` (from `execute`'s 3rd arg) and set a `timeout` (e.g. 120s) on every exec.

## Reference API (verified against pi docs)

- `pi.registerTool({ name, label, description, promptSnippet?, promptGuidelines?, parameters, execute })`
- `execute(toolCallId, params, signal, onUpdate, ctx)` returns `{ content, details? }`.
- `pi.exec(cmd, args, { signal, timeout })` → `{ stdout, stderr, code, killed }`.
- `pi.setActiveTools(names)` to drop `bash` and keep the safe set.
- `StringEnum` from `@earendil-works/pi-ai`; `Type` from `typebox`.
- Extension auto-discovered from `.pi/extensions/*/index.ts` (project) or
  `~/.pi/agent/extensions/` (global). Hot-reload with `/reload`.

## Task checklist

1. [x] Create `.pi/extensions/scoped-tools/index.ts` with the extension factory.
2. [x] Read-only git tools: `git_status`, `git_log`, `git_diff` — typed params, fixed argv,
       `pi.exec` with `signal`/`timeout`.
2b.[x] Mutating git tools: `git_add` (explicit paths), `git_commit`, `git_push` (no force).
3. [x] `make` tool: target/vars/directory params + validation, `pi.exec`.
4. [x] `session_start`: `pi.setActiveTools([...])` — drop `bash`, keep read/grep/find/ls/edit/
       write + git/make. (Verified active set at runtime via probe.)
5. [x] `tool_call` gate: block `bash` outright (defense-in-depth).
6. [x] `tool_call` gate: block `write`/`edit` to resolved make-file paths (basename match).
7. [x] `tool_call` gate: per-call `confirm` on mutating git tool names (Set) and `make`;
       fail closed when `!ctx.hasUI`; `git_add`/`make` show paths/target in the prompt.
8. [x] `promptSnippet` (+ `promptGuidelines` on `git_add`) per tool.
9. [x] stdout truncation + non-zero-exit error surfacing on every exec.
10.[x] Verified: extension loads, all 7 tools register, `bash` absent from active set,
       `git_status` runs through the wrapper. Pure gate logic covered by
       `gate-logic.test.mjs` (incl. the `Makefile.bak` case the shipped example gets wrong).

## Verification notes / known gaps

- Loaded via `pi -e .../index.ts` in print mode: 7 tools register, active set is exactly
  `{git_*, make, read, grep, find, ls}` (+ `write`/`edit` in TUI; `-p` disables those itself).
- `bash` is not in the active set and the gate blocks it as defense-in-depth.
- Pure validation (`isMakefilePath`, `isSafeToken`, make-var regex) unit-tested — all pass.
- **Not exercised at runtime:** the interactive `confirm` path on a real mutating call. In
  print mode the model refuses mutations at the reasoning level before the gate fires, and
  there's no headless approval flow. Confirm/deny mirrors the shipped `permission-gate.ts`.
  First real test is `git_commit` in an interactive TUI session.

## Resolved with you

- Architecture A, structured-per-subcommand, **no raw args passthrough**. Friction is a
  feature: complex git is a smell, so an awkward path there is correct behavior.
- Only the 90% subcommands modeled. Add flags/subcommands when a human hits the wall.
- Mutations allowed, per-call approval, no remembering.
- `git_add` takes explicit paths only (no `-A`), staged paths shown in the confirm.
- Makefile trusted but agent-uneditable (blocked on write/edit).
