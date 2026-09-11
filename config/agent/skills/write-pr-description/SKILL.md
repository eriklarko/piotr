---
name: write-pr-description
disable-model-invocation: true
description: >-
  Draft concise, reviewer-useful pull request descriptions that explain why a
  change exists instead of narrating the diff. Use only when explicitly invoked
  by the user to write, draft, improve, or review a PR description, PR body, or
  pull request summary.
---
# Write PR Descriptions

A reviewer can read the diff. The description must supply what the diff cannot prove: why this change exists, why this approach, and the evidence it works. Lead with **why**; summarize the **what** only enough to orient.

Cut ruthlessly: if a sentence doesn't help the reviewer judge or navigate the change, delete it. Active voice, present tense.

## Source the why (never invent it)

Use only grounded sources: the user, the linked Linear/GitHub issue, the current session. Do not infer intent from code. If the why is still unclear, ask one or two targeted questions before drafting rather than guessing.

## Structure

Respect the repo's PR template if one exists — fill its sections with why-first content, don't replace it. Otherwise use, omitting any that don't apply:

1. **Why** — the problem/bug/need that makes this worth merging. The most important section.
2. **What** — brief orientation bullets, not a file-by-file changelog.
3. **Approach** — only when the choice is non-obvious or an alternative was rejected.
4. **Verification** — what was tested/checked. If none, say so or leave a visible TODO; don't invent tests.
5. **Out of scope** — only if there's known follow-up.
6. **Screenshots** — for UI changes, before/after table with an italic caption row saying what to notice. Ask the user for images if you can't capture them.

For template checkboxes, check only items backed by evidence; leave the rest unchecked or ask.

## Output & actions

Output markdown by default. Ask for confirmation before any GitHub write (`gh pr create`, `gh pr edit`, etc.).

## Never

- Invent why, intent, or history; or cite code as evidence of motivation.
- Narrate the diff, pad for thoroughness, or check boxes without evidence.
- Run GitHub write actions without asking.

## Example

**Weak:** Updates files A, B, and C and changes the handler logic.

**Better:** Fixes [problem] for [affected users]. Uses [approach] because [reason]. Verification: [evidence].
