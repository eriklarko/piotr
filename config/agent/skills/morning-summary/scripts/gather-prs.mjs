#!/usr/bin/env node
// Gather open PRs authored by the current GitHub user across all repos and emit
// a compact JSON array with the signals needed to triage them.
//
// Usage: node gather-prs.mjs [limit]
// Requires: gh (authenticated) on PATH; inherits its keyring auth. No npm deps.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const LIMIT = process.argv[2] ?? "100";
const CONCURRENCY = 8;
const MAX_BUFFER = 64 * 1024 * 1024; // PRs with many comments/checks can be large

const PR_FIELDS = [
  "number", "title", "url", "isDraft", "mergeable", "mergeStateStatus",
  "reviewDecision", "statusCheckRollup", "reviewRequests", "latestReviews",
  "comments", "createdAt", "updatedAt", "headRefName", "baseRefName",
  "additions", "deletions", "changedFiles", "labels",
].join(",");

const FAILING = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);
const PENDING = new Set(["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"]);

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: MAX_BUFFER });
  return stdout;
}

// CheckRun entries carry status/conclusion; StatusContext entries carry state.
// Failure is judged on conclusion//state, pending on status//state, matching gh.
function ciStatus(checks) {
  if (checks.length === 0) return "none";
  if (checks.some((c) => FAILING.has(c.conclusion || c.state || ""))) return "failing";
  if (checks.some((c) => PENDING.has(c.status || c.state || ""))) return "pending";
  return "passing";
}

function compact(pr) {
  const checks = pr.statusCheckRollup ?? [];
  const repoMatch = (pr.url ?? "").match(/github\.com\/([^/]+\/[^/]+)\/pull/);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    repo: repoMatch ? repoMatch[1] : null,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: (pr.labels ?? []).map((l) => l.name),
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    ci: ciStatus(checks),
    failingChecks: checks
      .filter((c) => FAILING.has(c.conclusion || c.state || ""))
      .map((c) => c.name ?? c.context),
    reviewRequests: (pr.reviewRequests ?? []).map((r) => r.login ?? r.name),
    latestReviews: (pr.latestReviews ?? []).map((r) => ({
      author: r.author?.login,
      state: r.state,
      submittedAt: r.submittedAt,
    })),
    changesRequestedBy: (pr.latestReviews ?? [])
      .filter((r) => r.state === "CHANGES_REQUESTED")
      .map((r) => r.author?.login),
    commentCount: (pr.comments ?? []).length,
  };
}

async function prDetail(url) {
  try {
    return compact(JSON.parse(await gh(["pr", "view", url, "--json", PR_FIELDS])));
  } catch {
    return null; // skip PRs we can't read, mirroring the previous behavior
  }
}

// Bounded-concurrency map that preserves input order.
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  let listOut;
  try {
    listOut = await gh([
      "search", "prs", "--author=@me", "--state=open",
      "--limit", String(LIMIT), "--json", "url",
    ]);
  } catch (err) {
    if (err?.code === "ENOENT") {
      console.error(JSON.stringify({ error: "gh CLI not found" }));
      process.exit(1);
    }
    throw err;
  }

  const urls = JSON.parse(listOut).map((r) => r.url).filter(Boolean);
  if (urls.length === 0) {
    process.stdout.write("[]\n");
    return;
  }

  const details = (await mapPool(urls, CONCURRENCY, prDetail)).filter(Boolean);
  process.stdout.write(JSON.stringify(details, null, 2) + "\n");
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err?.message ?? err) }));
  process.exit(1);
});
