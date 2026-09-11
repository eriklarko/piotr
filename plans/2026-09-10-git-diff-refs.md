# git_diff: arbitrary ref comparison

## Task 1: Add `base`/`head` ref params to git_diff

**Goal:** `git_diff` currently only supports `--staged` vs working tree. Extend
it to diff any two refs (commits, branches, tags), so the agent can e.g. diff
a feature branch against `origin/master`, or two arbitrary commits — while
keeping today's "unstaged" and "staged" behavior as the default.

**Files:** `dotpi/agent/extensions/scoped-tools/index.ts` — `git_diff` tool
definition.

**Design:**
- New optional params `base: string` and `head: string`. Both must be given
  together (or neither) — mixing one ref param with `staged` is invalid.
- Behavior:
  - Neither `base` nor `head` given: unchanged — `git diff` (or
    `git diff --staged` if `staged: true`).
  - Both given: `git diff <base>..<head>` (straight two-dot comparison of the
    two trees). Reject if `staged` is also set (`paramError`).
  - Description/promptSnippet updated to mention ref comparison and that
    `origin/master`/`HEAD` are reasonable defaults for a PR-style diff, but
    the model must pass them explicitly — no implicit default ref resolution
    in code, since "default to origin/master and HEAD" is guidance for the
    model's typical call, not app logic.
- Validate `base`/`head` with `isSafeToken` (already used for remote/branch)
  so refs can't smuggle flags.
- Keep `paths` filtering working in combination with `base`/`head`.

**Tests:** add to `dotpi/agent/extensions/scoped-tools/gate-logic.test.mjs`
(or a new sibling test file if diff-argv construction isn't currently
covered there — check first) covering pure argv-building logic if it's
factored out, otherwise skip if the test file only covers the confirm gate
and there's no existing precedent for testing tool argv construction.

- `base` only (no `head`, no `staged`) → `paramError`.
- `head` only → `paramError`.
- `base` + `head` → argv is `["diff", "<base>..<head>"]`.
- `base` + `head` + `staged: true` → `paramError`.
- `base` + `head` + `paths` → argv includes `-- <paths>` after the ref range.
- ref value starting with `-` → `paramError` (via `isSafeToken`).

**Done when:** `git_diff` can compare any two refs via explicit params, old
staged/unstaged behavior is unchanged, and invalid combinations are rejected
with `paramError` rather than passed to `git`.

## Task checklist

1. Add `base`/`head` ref params to git_diff
