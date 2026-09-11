#!/usr/bin/env node
// Fetch the current user's open Linear issues and compute, for each, how long it
// has been in its current workflow state. Emits a JSON array on stdout.
//
// Usage: LINEAR_API_KEY=lin_api_... node gather-linear.mjs
// Requires: `npm install` in this directory (pulls @linear/sdk).
import { LinearClient } from "@linear/sdk";

const apiKey = process.env.LINEAR_API_KEY;
if (!apiKey) {
  console.error(
    JSON.stringify({
      error: "LINEAR_API_KEY not set",
      hint: "Create a personal API key at https://linear.app/settings/account/security and export LINEAR_API_KEY.",
    })
  );
  process.exit(1);
}

const client = new LinearClient({ apiKey });

// "Open" = not completed and not canceled. Backlog/triage/started/etc. all count.
const OPEN_STATE_TYPES = ["triage", "backlog", "unstarted", "started"];

async function stateEnteredAt(issue, currentStateId, createdAt) {
  // Walk issue history (newest first) to find when it last entered its current state.
  // Falls back to issue creation time if no matching transition is recorded.
  let connection = await issue.history({ first: 100 });
  let newestEntry = null;
  while (true) {
    for (const entry of connection.nodes) {
      if (entry.toStateId && entry.toStateId === currentStateId) {
        if (!newestEntry || entry.createdAt > newestEntry) newestEntry = entry.createdAt;
      }
    }
    if (!connection.pageInfo.hasNextPage) break;
    connection = await connection.fetchNext();
  }
  return newestEntry ?? createdAt;
}

function daysBetween(fromIso, toMs) {
  return Math.round(((toMs - new Date(fromIso).getTime()) / 86_400_000) * 10) / 10;
}

async function main() {
  const me = await client.viewer;
  const issues = await me.assignedIssues({
    first: 100,
    filter: { state: { type: { in: OPEN_STATE_TYPES } } },
  });

  const now = Date.now();
  const out = [];
  for (const issue of issues.nodes) {
    const state = await issue.state;
    const enteredAt = await stateEnteredAt(issue, state?.id, issue.createdAt);
    out.push({
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      priority: issue.priorityLabel,
      state: state ? { name: state.name, type: state.type } : null,
      stateSince: enteredAt,
      daysInState: daysBetween(enteredAt, now),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    });
  }

  out.sort((a, b) => b.daysInState - a.daysInState);
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(1);
});
