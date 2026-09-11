---
name: morning-summary
description: Produce a morning triage of the user's open GitHub PRs and open Linear issues. Triage PRs by actionability (needs attention, needs a response, waiting on review, blocked) and time-in-state for Linear issues, then cluster related PRs and tickets into workstreams (shared ticket, PR stacks, cross-repo pairs, same-area work). Use when the user asks for their "morning summary", a daily PR/ticket triage, "what should I work on", or a status check of their open PRs and tickets.
disable-model-invocation: true
---

# Morning Summary

Triage the user's open PRs and Linear issues into an action-oriented report. Two
independent sections — produce both. If one data source fails, still deliver the other.

```
Progress:
- [ ] Step 1: Gather and categorize open PRs
- [ ] Step 2: Gather open Linear issues + time-in-state
- [ ] Step 3: Cluster related PRs and tickets into workstreams
- [ ] Step 4: Render the report
```

Scripts live next to this file in `scripts/`. Run them with absolute paths.

## Step 1: Open PRs

Run the gather script (finds open PRs authored by `@me` across all repos and emits
compact triage JSON). Per-PR detail is fetched in parallel:

```bash
node scripts/gather-prs.mjs
```

Each PR object includes: `repo`, `number`, `title`, `url`, `isDraft`, `ci`
(`failing`/`pending`/`passing`/`none`), `failingChecks`, `mergeable`
(`MERGEABLE`/`CONFLICTING`/`UNKNOWN`), `mergeStateStatus` (`CLEAN`/`BLOCKED`/`BEHIND`/
`DIRTY`/`UNSTABLE`/`DRAFT`), `reviewDecision` (`APPROVED`/`CHANGES_REQUESTED`/
`REVIEW_REQUIRED`/empty), `reviewRequests`, `latestReviews`, `changesRequestedBy`,
`createdAt`, `updatedAt`.

Categorize each PR into the **single most actionable** bucket using this precedence
(top wins), then report. A PR's age = days since `updatedAt`.

1. **Needs attention** (`1d`) — something is broken and blocks merge:
   - `ci == "failing"` → list `failingChecks`; suggest opening the failed run / fixing.
   - `mergeable == "CONFLICTING"` or `mergeStateStatus == "DIRTY"` → merge conflicts; suggest rebasing onto the base branch.
   - `mergeStateStatus == "BEHIND"` → branch behind base; suggest updating the branch.
2. **Needs a response to reviews** (`1c`) — the ball is in the user's court:
   - `reviewDecision == "CHANGES_REQUESTED"` or `changesRequestedBy` non-empty → address requested changes from those reviewers.
   - Reviewers left comments awaiting a reply (`latestReviews` with `COMMENTED`) → respond / resolve.
3. **Waiting on review** (`1b`) — ball is in reviewers' court, nothing broken:
   - `reviewDecision == "REVIEW_REQUIRED"` (or empty) with pending `reviewRequests` and `ci != "failing"`.
   - If age > 2 days, flag as stale and suggest a nudge / re-request.
4. **Blocked** (`1a`) — cannot make progress without an external unblock:
   - `mergeStateStatus == "BLOCKED"` (required reviews/checks not satisfied) → name what's missing (approvals, required check).
   - `isDraft` with no recent movement → ask whether it's abandoned or needs finishing.
   - Approved + green but not merged → suggest merging now.
   - For each blocked PR, give a concrete unblock action (who/what to chase).

Sort within each bucket by age (most stale first). Note when a PR also matches lower
buckets (e.g. "waiting on review, and CI is failing") so context isn't lost.

## Step 2: Open Linear issues

Linear has two paths. **Prefer the SDK script** — it is reliable and can compute
accurate time-in-state from issue history. Fall back to the MCP only if no API key.

### Path A — SDK (preferred)

Requires `LINEAR_API_KEY` (personal key from
https://linear.app/settings/account/security) and a one-time install. The key lives
in `~/.profile`, which non-interactive shells don't auto-load, so source it first.
Do not inline the key on the command line or echo it:

```bash
cd scripts && npm install                      # first run only
[ -f ~/.profile ] && . ~/.profile; node scripts/gather-linear.mjs
```

If `LINEAR_API_KEY` is still unset, the script exits with a clear message — fall back
to Path B rather than asking the user to paste the key into the chat.

Output is a JSON array (sorted by `daysInState` desc) of: `identifier`, `title`,
`url`, `priority`, `state` (`{name, type}`), `stateSince`, `daysInState`,
`createdAt`, `updatedAt`. `daysInState` is measured from the last transition **into**
the current state (via issue history), not last edit.

### Path B — MCP (fallback, flaky)

The Linear MCP is unreliable, so **verify connectivity first**: call `get_user` with
`query: "me"` (or `list_teams`). If it errors, returns nothing, or only `mcp_auth` is
available, tell the user the Linear MCP is not connected and to reconnect /
authenticate it, then skip Step 2 (still deliver Step 1). Do not silently proceed.

Once connected, call `list_issues` with `assignee: "me"` and a state filter for open
work (exclude `completed`/`canceled`). Group by state. The MCP does not expose state
history, so time-in-state must be approximated from `updatedAt` — **say so explicitly**
("~Xd since last update", not "Xd in state").

Keep each issue's `identifier`, title, `state`, `priority`, and time-in-state — the
clustering in Step 3 decides where each one is rendered (inside a workstream if a PR
links to it, otherwise under "Unlinked tickets" grouped by state). Call out anything
stuck (e.g. In Progress for many days).

## Step 3: Cluster related PRs and tickets into workstreams

Before rendering, group PRs and issues that belong to the same effort so they sit
together. Build groups from the **strongest signal down**; each PR lands in exactly one
group (first match wins). All signals below come from the data already gathered
(`title`, `headRefName`, `baseRefName`, plus the Linear `identifier`s).

1. **Explicit ticket link (strongest).** Scan each PR's `title` and `headRefName` for
   Linear identifiers (`/[A-Z]{2,6}-\d+/i`, upper-cased). PRs sharing an identifier form
   one group. If that identifier is in the gathered Linear set, head the group with the
   ticket (state + time-in-state); if not (closed/elsewhere), still group the PRs and
   mark the ticket "not in open set".
2. **Stack (base→head chain).** A PR whose `baseRefName` is **not** the repo default
   (`master`/`main`) and equals another open PR's `headRefName` is stacked on it. Follow
   the chain to its root and group the whole chain in stack order (root first). Branch
   prefixes (`spr/`, `graphite/`, `gt/`) and numbered titles (`(\d+)/(\d+)`, e.g. "4/8")
   corroborate a stack.
3. **Shared branch / cross-repo pair.** PRs in different repos with the **same**
   `headRefName` are one change split across repos — group them.
4. **Same-area (weakest).** Of the remaining PRs, group ones that share a branch stem
   (e.g. `momentic-split-2/3/4` → stem `momentic-split`) or a distinctive topic keyword
   in the title (e.g. "momentic", "scan results", "dependabot"). Label the group by the
   shared theme and treat the link as an **observation, not intent** — do not claim the
   author built them together (see the no-speculation rule).

Then attach **unlinked tickets**: gathered Linear issues with no PR in any group. If a
ticket only *topically* matches a group (no identifier in any branch/title), list it
under that group as "possibly related (no explicit link)" rather than asserting it.

A group is worth showing only with **≥2 items** (PRs and/or its ticket); a lone PR with
no ticket and no siblings is "standalone".

## Step 4: Render the report

Lead with **Workstreams** (the Step 3 groups), then flat lists for whatever is left.
Preserve the triage signal as a compact inline **status tag** on every PR so "what's
broken" stays visible at a glance. Derive the tag from the Step 1 bucket:
`🔴 attention` (append `conflicts`/`CI`/`behind`), `🟠 respond`, `🟡 waiting`,
`🚧 blocked`/`draft`; also append `· ✅ approved` when `reviewDecision == "APPROVED"`.
Within a group, order PRs by stack order if stacked, else most-stale-first.

```markdown
# Morning summary — <date>

> <n> PRs · <n> need attention · <n> open tickets. <one-line systemic callout, if any>

## Workstreams

### <TICKET-123: title — state · Xd in state>  ·OR·  <Theme>
- **[repo#PR](url)** — <title> · <status tag> · <age>d  [stack 2/7]
  ↳ <action, if any>
- possibly related: **TICKET-456** — <title> (no explicit link)

### <next group> …

## Standalone PRs (<n>)
- **[repo#PR](url)** — <title> · <status tag> · <age>d
  ↳ <action, if any>

## Unlinked tickets (<n>)   [source: SDK | MCP]
### <State> (<n>)
- **TICKET** — <title> · <priority> · <Xd in state>
```

Keep it scannable: one line per item plus an optional indented action. Order workstreams
by their most urgent member (attention → respond → waiting → blocked). Omit empty
sections. End with a one-line "focus today" drawn from the highest-priority items.
