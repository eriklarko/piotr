/**
 * Pure utility functions for plan step extraction and tracking, plus the glob
 * matching and tool-allowlist logic shared by index.ts and the tests.
 */

/**
 * Tool-name prefixes that must never be reachable via a glob pattern in a
 * mode's `tools` list. These namespaces split on privilege: `ask` and `plan`
 * legitimately get `git_status`/`git_log`/`git_diff` but must never acquire
 * `git_commit`/`git_push`. A `git_*` pattern would silently grant whatever
 * mutating git tool is registered next, so patterns reaching these prefixes
 * are a load-time error. Spell those tools out literally instead.
 */
export const GLOB_DENIED_PREFIXES = ['git_'];

/**
 * Mode display/cycle order: ascending `order`, then name.
 *
 * Every place that presents or walks the mode list must go through this --
 * shift+tab cycling, `/mode` completions, the "Available modes" text, and the
 * startup mode (the first entry). Four independent `.sort()` calls used to
 * decide this separately, which is how the order silently became alphabetical.
 *
 * A mode without `order` sorts after every mode that has one, so an unordered
 * mode set keeps its old alphabetical order.
 */
export function sortedModeNames(modes: Map<string, { order?: number }>): string[] {
  return [...modes.keys()].sort((a, b) => {
    const oa = modes.get(a)?.order ?? Number.MAX_SAFE_INTEGER;
    const ob = modes.get(b)?.order ?? Number.MAX_SAFE_INTEGER;
    return oa !== ob ? oa - ob : a.localeCompare(b);
  });
}

/** True when a `tools` entry is a glob pattern rather than a literal name. */
export function isToolPattern(entry: string): boolean {
  return entry.includes('*') || entry.includes('?');
}

function escapeRegExpChar(c: string): string {
  return /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
}

/**
 * Convert a glob to an anchored RegExp. Used for both `writePaths` (slash-aware,
 * so `**` spans separators and `*` does not) and tool names (which contain no
 * slashes, making that distinction irrelevant there).
 */
export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      pattern += '.*';
      i += 2;
      if (glob[i] === '/') i += 1;
      continue;
    }
    if (c === '*') {
      pattern += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      pattern += '[^/]';
      i += 1;
      continue;
    }
    pattern += escapeRegExpChar(c);
    i += 1;
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(path: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

/**
 * The single allow decision for the mode gate: is `toolName` permitted by this
 * mode's `tools` list? Deny by default -- a tool absent from the list is
 * blocked regardless of where it came from or which other modes allow it.
 */
export function isToolAllowed(def: { tools: string[] }, toolName: string): boolean {
  for (const entry of def.tools) {
    if (!isToolPattern(entry)) {
      if (entry === toolName) return true;
      continue;
    }
    if (globToRegExp(entry).test(toolName)) return true;
  }
  return false;
}

/**
 * Expand a mode's `tools` list against the registered tool names so patterns
 * become concrete names suitable for `pi.setActiveTools()`. Literal entries are
 * kept even when unregistered; the caller warns about those separately.
 */
export function expandToolPatterns(tools: string[], allNames: string[]): string[] {
  const out = new Set<string>();
  for (const entry of tools) {
    if (!isToolPattern(entry)) {
      out.add(entry);
      continue;
    }
    const re = globToRegExp(entry);
    for (const name of allNames) {
      if (re.test(name)) out.add(name);
    }
  }
  return [...out];
}

/**
 * A pattern matching everything defeats the allowlist, so it is rejected
 * without needing the registered tool list. Returns an error message or
 * undefined.
 */
export function checkPatternIsBounded(entry: string): string | undefined {
  if (!isToolPattern(entry)) return undefined;
  if (/^[*?]+$/.test(entry)) {
    return `tool pattern "${entry}" matches every tool, which defeats the allowlist`;
  }
  return undefined;
}

/**
 * Reject patterns that reach a privilege-split namespace. Checked against the
 * real registered names so `*_commit` is caught too, not just `git_*`.
 */
export function checkPatternPrivilege(entry: string, allNames: string[]): string[] {
  if (!isToolPattern(entry)) return [];
  const re = globToRegExp(entry);
  const errors: string[] = [];
  for (const name of allNames) {
    if (!re.test(name)) continue;
    const prefix = GLOB_DENIED_PREFIXES.find((p) => name.startsWith(p));
    if (prefix) {
      errors.push(
        `tool pattern "${entry}" matches "${name}"; the "${prefix}" namespace splits on privilege and must be listed literally`,
      );
    }
  }
  return errors;
}

export interface PlanStep {
  step: number;
  text: string;
  completed: boolean;
}

/**
 * Strip checkbox markers, bold/italic, inline code, and collapse whitespace.
 */
export function cleanStepText(text: string): string {
  return text
    .replace(/^\s*\[[ x]\]\s*/i, '')       // leading checkbox
    .replace(/\*{1,2}([^*]+)\*{1,2}/g, '$1') // bold/italic
    .replace(/`([^`]+)`/g, '$1')            // inline code
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the **last** `## Task checklist` (any heading level) and extract
 * numbered items beneath it until the next heading or EOF.
 * Returns steps renumbered 1..n.
 */
export function extractPlanSteps(markdown: string): PlanStep[] {
  // Find the last "Task checklist" heading (any level)
  const headingPattern = /^#{1,6}\s+Task checklist\s*$/gim;
  let lastMatch: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = headingPattern.exec(markdown)) !== null) {
    lastMatch = m;
  }
  if (!lastMatch) return [];

  // Slice from after the heading
  const section = markdown.slice(lastMatch.index + lastMatch[0].length);

  // Read numbered items until next heading or EOF
  const lines = section.split('\n');
  const items: PlanStep[] = [];
  const numberedPattern = /^\s*\d+[.)]\s+(.+)/;

  for (const line of lines) {
    // Stop at next heading
    if (/^#{1,6}\s/.test(line)) break;

    const match = numberedPattern.exec(line);
    if (match) {
      const cleaned = cleanStepText(match[1]);
      if (cleaned.length > 0) {
        items.push({
          step: items.length + 1,
          text: cleaned,
          completed: false,
        });
      }
    }
  }

  return items;
}

/**
 * Decide what to show in the plan-review popup and which steps to track,
 * keeping the two decisions independent.
 *
 * - `steps` come from the plan file when it yields any, otherwise from the
 *   assistant message text (the fallback source).
 * - `displayContent` is the plan file whenever one was written and non-empty;
 *   the assistant text is only used for display when there was no plan file to
 *   show. A present plan file is never overwritten by assistant text.
 */
export function resolvePlanReview(
  planFileContent: string | undefined,
  assistantText: string | undefined,
): { displayContent?: string; steps: PlanStep[] } {
  const hasPlanFile = Boolean(planFileContent && planFileContent.trim());

  const fileSteps = planFileContent ? extractPlanSteps(planFileContent) : [];
  const steps =
    fileSteps.length > 0
      ? fileSteps
      : assistantText
        ? extractPlanSteps(assistantText)
        : [];

  const displayContent = hasPlanFile
    ? planFileContent
    : steps.length > 0
      ? assistantText
      : undefined;

  return { displayContent, steps };
}

/**
 * Extract all `[DONE:n]` step numbers from text.
 */
export function extractDoneSteps(text: string): number[] {
  const steps: number[] = [];
  for (const match of text.matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) steps.push(step);
  }
  return steps;
}

/**
 * Mark steps as completed based on `[DONE:n]` markers in text.
 * Returns the number of markers found.
 */
export function markCompletedSteps(text: string, items: PlanStep[]): number {
  const doneSteps = extractDoneSteps(text);
  let count = 0;
  for (const step of doneSteps) {
    const item = items.find((t) => t.step === step);
    if (item && !item.completed) {
      item.completed = true;
      count++;
    }
  }
  return count;
}
