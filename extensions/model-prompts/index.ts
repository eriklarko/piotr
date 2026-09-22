import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendModelPrompts,
  formatMatchedPromptFiles,
  loadModelPrompts,
  matchingModelPrompts,
  modelLabel,
  type ModelPromptDefinition,
} from './utils.ts';

const PROMPTS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'prompts');

export default function modelPromptsExtension(pi: ExtensionAPI) {
  let definitions: ModelPromptDefinition[] = [];

  async function rescan(ctx: ExtensionContext): Promise<void> {
    const loaded = await loadModelPrompts(PROMPTS_DIR);
    definitions = loaded.definitions;

    if (loaded.errors.length > 0) {
      ctx.ui.notify(`Model prompt config warnings (${PROMPTS_DIR}):\n${loaded.errors.join('\n')}`, 'warning');
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    await rescan(ctx);
  });

  pi.on('before_agent_start', async (event, ctx) => {
    if (!ctx.model) return;
    const matches = matchingModelPrompts(definitions, ctx.model);
    if (matches.length === 0) return;
    return { systemPrompt: appendModelPrompts(event.systemPrompt, matches) };
  });

  pi.on('model_select', async (event, ctx) => {
    if (event.source === 'restore') return;
    const matches = matchingModelPrompts(definitions, event.model);
    ctx.ui.notify(
      `Model prompts activated for ${modelLabel(event.model)}: ${formatMatchedPromptFiles(matches)}`,
      'info',
    );
  });
}
