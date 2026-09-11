---
name: split-large-diffs
description: >-
  Split a large set of changes into small, logically-grouped, reviewable PRs by
  grouping code that belongs to one idea. Use when the user asks to split, break
  up, or carve up a big diff, branch, chat, or PR, or says a change is too large
  to review.
---
# Split large diffs into reviewable PRs

Turn one large pile of changes into a few PRs, each built around a single coherent
idea. The hard part is not the git mechanics — it is deciding what belongs together.
Spend your effort there.

## The core principle

Group by **one coherent idea per PR** — a single intent a reviewer can hold in
their head. Do not group by file, directory, owner, or layer, and never split just
to make sizes even.

Deployability is a *bonus, not a requirement*: prefer slices where each PR leaves
`main` building and tests green, but do not contort the grouping to force it. When
a slice cannot stand alone without breaking, that is a real dependency — stack it
(see below) rather than padding it.

## Finding idea boundaries

Two changes belong to the same PR when they serve the same intent. Strongest
signals, in order:

1. **Shared new symbol/module/type** — one change introduces it, the others use it.
2. **Covered by the same test** — they are exercised as one behavior.

Weaker, supporting signals: call-graph proximity (one calls the other), same
subsystem/directory. Use these only to break ties, never as the primary axis.

Tests, types, and docs ride **with the feature PR they belong to** — do not strand
them in a separate "tests" or "docs" PR.

## Sizing

Judge size by **number of logical changes and reviewer load**, not line count. A
500-line PR doing one mechanical rename is fine; a 60-line PR doing three unrelated
things is not. If a PR contains more than one idea, split it. If splitting would
produce a fragment that only makes sense alongside another PR, it was one idea —
keep it whole.

## Enablers and refactors

A refactor or shared util that several features depend on:

- **Small enabler** → fold it into the first feature PR that needs it.
- **Big enabler** → land it as its own foundation PR first; features depend on it.

## Independent vs stacked

Default to **independent PRs off the default branch**. Stack only on a *real*
dependency (a PR genuinely needs code from another to build or make sense). Order
foundations before consumers. Avoid stacks created for convenience.

## When one idea is too big to review

Sometimes a single coherent idea is still too large for one PR. Do not pick a
sub-split silently. Present the trade-off and let the user choose, e.g.:

- **Vertical slices** — smaller end-to-end sub-features.
- **By layer** — schema/types → backend → frontend.
- **Incremental no-op steps** — scaffold → wire up → switch over.

Explain the cost of each for this specific change, then defer to the user.

## Never

- Never split purely by file or directory when those files belong to one idea.
- Never mix an unrelated refactor with a behavior change in the same PR.
- Never split just to hit an even size or line count.

## Output: plan first, then execute

Before any git action, produce a **split plan** and get approval:

- One line per PR: title + a one-line scope note.
- Per-PR size: number of files changed and lines added/removed (e.g. `+367 / -123,
  6 files`). Pull from `git diff --numstat <base>..HEAD`; when one file's hunks are
  split across PRs, apportion by hunk and mark the figure approximate (`~`).
- The dependency/order (independent, or what stacks on what). Show a Mermaid graph
  when there are multiple slices.

Only after the user approves, execute.

## Safe execution

- Save a recoverable snapshot before moving work; never discard user work.
- Stage only named files or hunks per slice — no `git add .` / `git add -A`.
- No destructive git (`reset --hard`, `clean -fdx`, force-push, branch deletion,
  history rewrite) without explicit approval.
- Per approved slice: branch from the right base, commit only the planned changes,
  push, open the PR. Report back titles + URLs and anything left behind.

## Worked example

A branch touches `auth/login.ts`, a new `lib/result.ts` (a `Result<T>` type),
`auth/login.test.ts`, and `billing/invoice.ts` which also returns `Result<T>`.

- **Lazy (wrong):** one PR per directory — `auth`, `lib`, `billing`.
- **Good:**
  1. `lib/result.ts` foundation PR (big shared enabler many things consume).
  2. Auth login PR — `auth/login.ts` + `auth/login.test.ts` together (same test
     signals one idea), stacked on #1.
  3. Billing PR — `billing/invoice.ts`, stacked on #1, independent of #2.
- **Why:** the `Result<T>` type is a shared new symbol used across ideas, so it is
  its own foundation. Auth and billing are separate intents with separate reviewers;
  each stacks on the type only because of a real dependency.
