/**
 * Three-Mode Controller Extension
 *
 * Loads operating modes from the `modes/*.md` files bundled alongside this
 * extension (see modes/README.md for the file format) and manages tool
 * permissions and system-prompt instructions across them. No mode names, tool
 * lists, or prompts are hardcoded here — everything comes from the mode files.
 *
 * Additionally implements plan review, execution handoff, and live progress
 * tracking when used with a mode named "plan".
 *
 * Switch modes with `/mode <name>`.
 */

import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { AssistantMessage, TextContent } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkPatternIsBounded,
  checkPatternPrivilege,
  expandToolPatterns,
  isToolAllowed,
  isToolPattern,
  markCompletedSteps,
  matchesAnyGlob,
  resolvePlanReview,
  sortedModeNames,
  type PlanStep,
} from './utils.ts';

const MODES_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'modes');

const PLAN_MODE = 'plan';
const BUILD_MODE = 'build';

interface ModeDefinition {
  name: string;
  tools: string[];
  prompt: string;
  writePaths?: string[];
  label: string;
  order?: number;
}

const WRITE_PATH_GATED_TOOLS = new Set(['edit', 'write']);

function toProjectRelativePath(cwd: string, rawPath: string): string {
  const stripped = rawPath.replace(/^@/, '');
  const abs = isAbsolute(stripped) ? stripped : resolve(cwd, stripped);
  return relative(cwd, abs).split(sep).join('/');
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === 'assistant' && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
  return message.content
    .filter((block): block is TextContent => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

async function loadModes(): Promise<{ modes: Map<string, ModeDefinition>; errors: string[] }> {
  const dir = MODES_DIR;
  const modes = new Map<string, ModeDefinition>();
  const errors: string[] = [];

  let files: string[];
  try {
    files = (await readdir(dir)).filter(
      (f) => f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'readme.md',
    );
  } catch {
    return { modes, errors };
  }

  for (const file of [...files].sort()) {
    const name = basename(file, extname(file));
    const raw = await readFile(join(dir, file), 'utf8');
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw);

    const tools = frontmatter.tools;
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((t) => typeof t === 'string')) {
      errors.push(`${file}: missing or invalid "tools" (expected a non-empty array of tool names)`);
      continue;
    }

    let writePaths: string[] | undefined;
    if (frontmatter.writePaths !== undefined) {
      const raw = frontmatter.writePaths;
      if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) {
        errors.push(`${file}: "writePaths" must be an array of glob strings`);
        continue;
      }
      writePaths = raw;
    }

    let order: number | undefined;
    if (frontmatter.order !== undefined) {
      if (typeof frontmatter.order !== 'number' || !Number.isFinite(frontmatter.order)) {
        errors.push(`${file}: "order" must be a finite number`);
        continue;
      }
      order = frontmatter.order;
    }

    if (!body.trim()) {
      errors.push(`${file}: empty prompt body`);
    }

    // Unbounded patterns can be rejected without knowing the registered tools.
    // Privilege-prefix checks need the real tool list and happen in rescan().
    const unbounded = tools
      .map((entry) => checkPatternIsBounded(entry))
      .filter((e): e is string => e !== undefined);
    if (unbounded.length > 0) {
      errors.push(...unbounded.map((e) => `${file}: ${e}`));
      continue;
    }

    modes.set(name, {
      name,
      tools: [...new Set(tools)],
      prompt: body.trim(),
      writePaths,
      label: typeof frontmatter.label === 'string' ? frontmatter.label : name,
      order,
    });
  }

  return { modes, errors };
}

export default function modeControllerExtension(pi: ExtensionAPI) {
  let modes: Map<string, ModeDefinition> = new Map();
  let currentMode: string | undefined;

  // Plan tracking state
  let planTodos: PlanStep[] = [];
  let executing = false;
  let lastPlanPath: string | undefined;
  const pendingWrites = new Map<string, string>();

  function isPlanMode(): boolean {
    return currentMode === PLAN_MODE;
  }

  // The mode's `tools` list is the complete allowlist. Anything absent from it
  // is inactive and blocked, whatever its source. There is deliberately no
  // passthrough for tools the controller "does not own" -- that was the bug
  // that left `bash` live in ask and plan mode.
  function applyToolsForMode(): void {
    const def = currentMode ? modes.get(currentMode) : undefined;
    if (!def) return;
    const allNames = pi.getAllTools().map((t) => t.name);
    pi.setActiveTools(expandToolPatterns(def.tools, allNames));
  }

  function updateStatus(ctx: ExtensionContext): void {
    const def = currentMode ? modes.get(currentMode) : undefined;

    // Mode status
    ctx.ui.setStatus('mode-controller', def ? ctx.ui.theme.fg('accent', def.label) : undefined);

    // Plan progress status + widget
    if (executing && planTodos.length > 0) {
      const completed = planTodos.filter((t) => t.completed).length;
      ctx.ui.setStatus('plan-progress', ctx.ui.theme.fg('accent', `📋 ${completed}/${planTodos.length}`));

      const lines = planTodos.map((item) => {
        if (item.completed) {
          return (
            ctx.ui.theme.fg('success', '☑ ') +
            ctx.ui.theme.fg('muted', ctx.ui.theme.strikethrough(item.text))
          );
        }
        return `${ctx.ui.theme.fg('muted', '☐ ')}${item.text}`;
      });
      ctx.ui.setWidget('plan-progress', lines);
    } else {
      ctx.ui.setStatus('plan-progress', undefined);
      ctx.ui.setWidget('plan-progress', undefined);
    }
  }

  function persistState(): void {
    if (!currentMode) return;
    pi.appendEntry('mode-controller', { mode: currentMode });
  }

  function persistPlanState(): void {
    pi.appendEntry('plan-tracking', {
      executing,
      todos: planTodos,
      lastPlanPath,
    });
  }

  async function rescan(ctx?: ExtensionContext): Promise<void> {
    const { modes: loaded, errors } = await loadModes();
    modes = loaded;

    // Validate mode tool lists against what is actually registered. Deny by
    // default makes a typo a silent denial, so surface it loudly instead.
    const allNames = pi.getAllTools().map((t) => t.name);
    if (allNames.length > 0) {
      const covered = new Set<string>();
      for (const def of modes.values()) {
        for (const entry of def.tools) {
          if (isToolPattern(entry)) {
            errors.push(
              ...checkPatternPrivilege(entry, allNames).map((e) => `${def.name}.md: ${e}`),
            );
            const matches = expandToolPatterns([entry], allNames);
            if (matches.length === 0) {
              errors.push(`${def.name}.md: tool pattern "${entry}" matches no registered tool`);
            }
            for (const m of matches) covered.add(m);
            continue;
          }
          if (!allNames.includes(entry)) {
            errors.push(`${def.name}.md: unknown tool "${entry}" (not registered)`);
          }
          covered.add(entry);
        }
      }

      // Inverse diagnostic: a registered tool named by no mode is unreachable.
      // Without this, installing a package silently adds a tool nothing can use.
      const orphans = allNames.filter((n) => !covered.has(n));
      if (orphans.length > 0) {
        errors.push(
          `tools registered but listed in no mode (unreachable): ${orphans.sort().join(', ')}`,
        );
      }
    }

    if (errors.length > 0) {
      ctx?.ui.notify(`Mode config warnings (${MODES_DIR}):\n${errors.join('\n')}`, 'warning');
    }

    if (currentMode && !modes.has(currentMode)) {
      const fallback = sortedModeNames(modes)[0];
      ctx?.ui.notify(`Mode "${currentMode}" no longer exists; falling back to "${fallback ?? 'none'}".`, 'warning');
      currentMode = fallback;
    }

    if (currentMode === undefined) {
      currentMode = sortedModeNames(modes)[0];
    }
  }

  function setMode(next: string, ctx: ExtensionContext): void {
    currentMode = next;
    applyToolsForMode();
    updateStatus(ctx);
    persistState();
  }

  async function startExecution(ctx: ExtensionContext): Promise<void> {
    executing = true;

    // Switch to build mode for full tool access
    if (modes.has(BUILD_MODE)) {
      setMode(BUILD_MODE, ctx);
    }

    updateStatus(ctx);
    persistPlanState();

    const stepList = planTodos.map((t) => `${t.step}. ${t.text}`).join('\n');
    pi.sendMessage(
      {
        customType: 'plan-execute',
        content: `Execute the plan. Steps:\n${stepList}\n\nDo them in order. After finishing a step include a [DONE:n] tag.`,
        display: true,
      },
      { triggerTurn: true, deliverAs: 'followUp' },
    );
  }

  pi.registerShortcut('shift+tab', {
    description: 'Cycle to next operating mode',
    handler: async (ctx) => {
      await rescan(ctx);
      const names = sortedModeNames(modes);
      if (names.length === 0) return;
      const idx = currentMode ? names.indexOf(currentMode) : -1;
      const next = names[(idx + 1) % names.length]!;
      setMode(next, ctx);
      ctx.ui.notify(`Switched to ${next} mode`, 'info');
    },
  });

  pi.registerCommand('mode', {
    description: 'Switch operating mode (reads definitions from the extension\'s modes/*.md)',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const items = sortedModeNames(modes).map((name) => ({
        value: name,
        label: modes.get(name)?.label ?? name,
      }));
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      await rescan(ctx);
      const names = sortedModeNames(modes);

      if (names.length === 0) {
        ctx.ui.notify(
          `No modes configured. Add *.md files under ${MODES_DIR} (see modes/README.md).`,
          'error',
        );
        return;
      }

      const requested = args.trim().toLowerCase();

      if (!requested) {
        ctx.ui.notify(`Current mode: ${currentMode}. Available modes: ${names.join(', ')}`, 'info');
        return;
      }

      if (!modes.has(requested)) {
        ctx.ui.notify(`Invalid mode "${requested}". Available modes: ${names.join(', ')}`, 'error');
        return;
      }

      if (requested === currentMode) {
        applyToolsForMode();
        updateStatus(ctx);
        ctx.ui.notify(`Already in ${requested} mode (definition refreshed)`, 'info');
        return;
      }

      setMode(requested, ctx);
      ctx.ui.notify(`Switched to ${requested} mode`, 'info');
    },
  });

  // Track written plan paths in plan mode
  pi.on('tool_call', async (event, ctx) => {
    if (!currentMode) return;
    const def = modes.get(currentMode);
    if (!def) return;

    if (!isToolAllowed(def, event.toolName)) {
      return { block: true, reason: `"${event.toolName}" is not available in ${def.label} mode.` };
    }

    if (def.writePaths && WRITE_PATH_GATED_TOOLS.has(event.toolName)) {
      const rawPath = String((event.input as { path?: string }).path ?? '');
      const relPath = toProjectRelativePath(ctx.cwd, rawPath);
      if (!matchesAnyGlob(relPath, def.writePaths)) {
        return {
          block: true,
          reason: `${def.label} mode only allows writing to paths matching: ${def.writePaths.join(', ')}. Blocked: "${rawPath}".`,
        };
      }
    }

    // Track write/edit paths in plan mode for plan-path reporting
    if (isPlanMode() && (event.toolName === 'write' || event.toolName === 'edit')) {
      const rawPath = String((event.input as { path?: string }).path ?? '');
      if (rawPath) {
        pendingWrites.set(event.toolCallId, rawPath);
      }
    }
  });

  pi.on('tool_execution_end', async (event, ctx) => {
    const rawPath = pendingWrites.get(event.toolCallId);
    pendingWrites.delete(event.toolCallId);
    if (rawPath && !event.isError) {
      lastPlanPath = toProjectRelativePath(ctx.cwd, rawPath);
    }
  });

  pi.on('before_agent_start', async (event) => {
    const def = currentMode ? modes.get(currentMode) : undefined;
    if (!def || !def.prompt) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${def.prompt}` };
  });

  // Live tracking: mark steps on [DONE:n]
  pi.on('turn_end', async (event, ctx) => {
    if (!executing || planTodos.length === 0) return;
    if (!isAssistantMessage(event.message)) return;

    const text = getTextContent(event.message);
    if (markCompletedSteps(text, planTodos) > 0) {
      updateStatus(ctx);
      persistPlanState();
    }
  });

  // Plan review popup + execution completion
  pi.on('agent_end', async (event, ctx) => {
    // Check if execution is complete
    if (executing && planTodos.length > 0) {
      if (planTodos.every((t) => t.completed)) {
        const completedList = planTodos.map((t) => `~~${t.text}~~`).join('\n');
        pi.sendMessage(
          { customType: 'plan-complete', content: `**Plan Complete!** ✓\n\n${completedList}`, display: true },
          { triggerTurn: false },
        );
        executing = false;
        planTodos = [];
        updateStatus(ctx);
        persistPlanState();
      }
      return;
    }

    if (!isPlanMode()) return;

    // Read the plan file for both display and checklist extraction.
    let planFileContent: string | undefined;
    if (lastPlanPath) {
      try {
        planFileContent = await readFile(resolve(ctx.cwd, lastPlanPath), 'utf8');
      } catch {
        // Fall through to the assistant-message fallback below.
      }
    }

    const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
    const assistantText = lastAssistant ? getTextContent(lastAssistant) : undefined;

    // A written plan file always wins for display; the assistant text only
    // supplies steps (and display when no plan file was written).
    const { displayContent, steps } = resolvePlanReview(planFileContent, assistantText);

    // Headless: nothing to click. Record where the plan is and stop.
    if (!ctx.hasUI) {
      if (lastPlanPath) {
        pi.sendMessage(
          { customType: 'plan-review', content: `📄 Plan written to: ${lastPlanPath}`, display: true },
          { triggerTurn: false },
        );
      }
      return;
    }

    // Show the plan itself so the review is about the plan, not the chatter
    // the model printed above it. Display is not gated on step parsing.
    if (displayContent) {
      const header = lastPlanPath ? `📄 \`${lastPlanPath}\`\n\n` : '';
      pi.sendMessage(
        { customType: 'plan-review', content: `${header}${displayContent}`, display: true },
        { triggerTurn: false },
      );
    } else if (lastPlanPath) {
      pi.sendMessage(
        { customType: 'plan-review', content: `📄 Plan written to: ${lastPlanPath}`, display: true },
        { triggerTurn: false },
      );
    } else {
      return; // Nothing to review.
    }

    if (steps.length > 0) {
      planTodos = steps;
      persistPlanState();
    }

    // Review popup
    const choice = await ctx.ui.select('Plan ready — what next?', [
      'Execute the plan',
      'Stay in plan mode',
      'Refine the plan',
    ]);

    if (choice?.startsWith('Execute')) {
      if (planTodos.length > 0) {
        await startExecution(ctx);
      } else {
        // No parseable checklist to track; still hand the plan to build mode.
        if (modes.has(BUILD_MODE)) setMode(BUILD_MODE, ctx);
        const ref = lastPlanPath ? ` in ${lastPlanPath}` : '';
        pi.sendUserMessage(`Implement the plan${ref}. Work through it in order.`, {
          deliverAs: 'followUp',
        });
      }
    } else if (choice === 'Refine the plan') {
      const refinement = await ctx.ui.editor('Refine the plan:', '');
      if (refinement?.trim()) {
        pi.sendUserMessage(refinement.trim(), { deliverAs: 'followUp' });
      }
    }
    // Stay in plan mode → no-op
  });

  // Context cleanup: strip stale plan-execute instructions when not executing
  pi.on('context', async (event) => {
    if (executing || isPlanMode()) return;

    return {
      messages: event.messages.filter((m) => {
        const msg = m as AgentMessage & { customType?: string };
        return msg.customType !== 'plan-execute';
      }),
    };
  });

  pi.on('session_start', async (_event, ctx) => {
    await rescan(ctx);

    const entries = ctx.sessionManager.getEntries();

    // Restore mode
    const savedEntry = entries
      .filter(
        (e): e is typeof e & { customType?: string; data?: { mode?: string } } =>
          e.type === 'custom' && (e as { customType?: string }).customType === 'mode-controller',
      )
      .pop();

    if (savedEntry?.data?.mode && modes.has(savedEntry.data.mode)) {
      currentMode = savedEntry.data.mode;
    }

    // Restore plan tracking state
    const planEntry = entries
      .filter(
        (e): e is typeof e & { customType?: string; data?: { executing?: boolean; todos?: PlanStep[]; lastPlanPath?: string } } =>
          e.type === 'custom' && (e as { customType?: string }).customType === 'plan-tracking',
      )
      .pop();

    if (planEntry?.data) {
      executing = planEntry.data.executing ?? false;
      planTodos = planEntry.data.todos ?? [];
      lastPlanPath = planEntry.data.lastPlanPath;
    }

    // On resume: re-scan messages after the execute marker to rebuild completion
    if (executing && planTodos.length > 0) {
      let executeIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i] as { type: string; customType?: string };
        if (entry.customType === 'plan-execute') {
          executeIndex = i;
          break;
        }
      }

      const messages: AssistantMessage[] = [];
      for (let i = executeIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.type === 'message' && 'message' in entry && isAssistantMessage(entry.message as AgentMessage)) {
          messages.push(entry.message as AssistantMessage);
        }
      }
      const allText = messages.map(getTextContent).join('\n');
      markCompletedSteps(allText, planTodos);
    }

    applyToolsForMode();
    updateStatus(ctx);
  });
}
