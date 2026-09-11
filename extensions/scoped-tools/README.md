# scoped-tools

**The problem it solves:** giving an agent `bash` gives it everything. `git`
in particular is a shell delivery mechanism — `core.pager`, `core.sshCommand`,
`diff.external`, aliases and hooks all run arbitrary commands — so "allow git,
deny bash" is not a boundary you can enforce by inspecting a command string.

scoped-tools replaces raw shell access with one narrow tool per git operation.
Each tool takes typed parameters, builds a fixed argv itself, and executes the
binary directly. There is no shell, and no `args: string[]` passthrough for the
model to smuggle flags through. Tokens that look like flags or contain
whitespace are rejected outright.

Only the common path is modeled. A git invocation the tools cannot express is
usually a sign the agent has lost the plot; when a human hits a real wall, add
the flag deliberately.

This extension only *registers* tools. Which of them are active is decided per
mode by [mode-controller](../mode-controller/README.md) — a mode that should
not commit simply does not list `git_commit`, and modes without `bash` have no
shell at all.

## Tools

Read-only:

| Tool | What it does |
| --- | --- |
| `git_status` | Working tree status. |
| `git_log` | Commit history, optionally limited by count, one-line format, or paths. |
| `git_diff` | Unstaged, staged (`staged`), or arbitrary `base`/`head` ref comparison, optionally path-limited. |

Mutating:

| Tool | What it does |
| --- | --- |
| `git_add` | Stage exact file paths. No `-A` or `.` shorthand. |
| `git_commit` | Commit staged changes with a message; can `amend`. |
| `git_push` | Push to a remote/branch. No force push, ever. |
| `make` | Run a make target, with optional `VAR=value` assignments and `-C` directory. |

`make` is the one deliberate exception to "no shell": a Makefile recipe runs
through a shell by definition. It is allowed because the Makefile is part of
the trusted repo, not agent-supplied input.

## The one gate

`git_commit` and `git_push` ask for confirmation on every call, because they
publish work or rewrite history. Everything else runs without prompting — the
agent is trusted with the tools it was given.

The confirmation **fails open**: in print/JSON mode there is no UI and nobody
to ask, so the action proceeds unconfirmed rather than hanging. Keep that in
mind before handing these tools to an unattended run.

## Tests

`make test-extensions` runs `gate-logic.test.mjs`, which covers token
validation and `git_diff`/`make` argv construction. Those pure functions are
*copied* into the test file rather than imported, so if you change them in
`index.ts` you must update the copies.
