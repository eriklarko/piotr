import { parseFrontmatter } from '@earendil-works/pi-coding-agent';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ModelIdentity {
  provider: string;
  id: string;
}

export interface ModelPromptDefinition {
  fileName: string;
  patterns: RegExp[];
  prompt: string;
}

export interface LoadedModelPrompts {
  definitions: ModelPromptDefinition[];
  errors: string[];
}

export async function loadModelPrompts(directory: string): Promise<LoadedModelPrompts> {
  const definitions: ModelPromptDefinition[] = [];
  const errors: string[] = [];

  let files: string[];
  try {
    files = (await readdir(directory))
      .filter((file) => file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'readme.md')
      .sort();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { definitions, errors: [`unable to read prompts directory: ${message}`] };
  }

  for (const fileName of files) {
    let raw: string;
    try {
      raw = await readFile(join(directory, fileName), 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${fileName}: unable to read file: ${message}`);
      continue;
    }

    let frontmatter: Record<string, unknown>;
    let body: string;
    try {
      ({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(raw));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${fileName}: invalid frontmatter: ${message}`);
      continue;
    }

    const models = frontmatter.models;
    if (
      !Array.isArray(models) ||
      models.length === 0 ||
      !models.every((pattern) => typeof pattern === 'string' && pattern.length > 0)
    ) {
      errors.push(`${fileName}: missing or invalid "models" (expected a non-empty array of regex strings)`);
      continue;
    }

    const patterns: RegExp[] = [];
    let invalidPattern: string | undefined;
    for (const source of models) {
      try {
        patterns.push(new RegExp(source, 'i'));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        invalidPattern = `invalid model regex ${JSON.stringify(source)}: ${message}`;
        break;
      }
    }
    if (invalidPattern) {
      errors.push(`${fileName}: ${invalidPattern}`);
      continue;
    }

    const prompt = body.trim();
    if (!prompt) {
      errors.push(`${fileName}: empty prompt body`);
      continue;
    }

    definitions.push({ fileName, patterns, prompt });
  }

  return { definitions, errors };
}

export function modelLabel(model: ModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

export function matchingModelPrompts(
  definitions: ModelPromptDefinition[],
  model: ModelIdentity,
): ModelPromptDefinition[] {
  const label = modelLabel(model);
  return definitions
    .filter((definition) => definition.patterns.some((pattern) => pattern.test(label)))
    .sort((a, b) => a.fileName.localeCompare(b.fileName));
}

export function appendModelPrompts(
  basePrompt: string,
  matches: ModelPromptDefinition[],
): string {
  if (matches.length === 0) return basePrompt;
  return [basePrompt, ...matches.map((definition) => definition.prompt)].join('\n\n');
}

export function formatMatchedPromptFiles(matches: ModelPromptDefinition[]): string {
  return matches.length > 0 ? matches.map((definition) => definition.fileName).join(', ') : 'none';
}
