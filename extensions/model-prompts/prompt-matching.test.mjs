// Regression tests for model prompt loading, matching, and composition.
// Imports the real implementation from utils.ts -- no copies to drift.
// Run: node --experimental-strip-types prompt-matching.test.mjs

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendModelPrompts,
  formatMatchedPromptFiles,
  loadModelPrompts,
  matchingModelPrompts,
  modelLabel,
} from './utils.ts';

let fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    fail++;
    console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want));
  } else {
    console.log('ok  ', name);
  }
}

const root = await mkdtemp(join(tmpdir(), 'model-prompts-'));
const promptsDir = join(root, 'prompts');
await mkdir(promptsDir);

try {
  await Promise.all([
    writeFile(join(promptsDir, 'README.md'), '# Documentation only'),
    writeFile(
      join(promptsDir, '20-openai.md'),
      ['---', 'models:', '  - ".*openai.*"', '  - ".*codex.*"', '---', 'OpenAI guidance.'].join('\n'),
    ),
    writeFile(
      join(promptsDir, '10-sol.md'),
      ['---', "models: ['.*gpt-5\\.6-sol.*']", '---', 'Sol guidance.'].join('\n'),
    ),
    writeFile(
      join(promptsDir, '30-anthropic.md'),
      ['---', 'models: ["anthropic/claude-.*"]', '---', 'Anthropic guidance.'].join('\n'),
    ),
    writeFile(join(promptsDir, '40-missing-models.md'), ['---', 'title: nope', '---', 'Ignored.'].join('\n')),
    writeFile(join(promptsDir, '41-empty-models.md'), ['---', 'models: []', '---', 'Ignored.'].join('\n')),
    writeFile(join(promptsDir, '42-non-string.md'), ['---', 'models: ["ok", 42]', '---', 'Ignored.'].join('\n')),
    writeFile(join(promptsDir, '43-invalid-regex.md'), ['---', 'models: ["["]', '---', 'Ignored.'].join('\n')),
    writeFile(join(promptsDir, '44-empty-body.md'), ['---', 'models: [".*"]', '---', '   '].join('\n')),
    writeFile(join(promptsDir, 'ignored.txt'), 'not markdown'),
  ]);

  const loaded = await loadModelPrompts(promptsDir);
  eq('valid files load in lexical order', loaded.definitions.map((d) => d.fileName), [
    '10-sol.md',
    '20-openai.md',
    '30-anthropic.md',
  ]);
  eq('README and non-markdown files are ignored', loaded.errors.some((e) => e.startsWith('README.md:')), false);
  eq('invalid prompt files are reported and skipped', loaded.errors.map((e) => e.split(':')[0]), [
    '40-missing-models.md',
    '41-empty-models.md',
    '42-non-string.md',
    '43-invalid-regex.md',
    '44-empty-body.md',
  ]);

  const bedrockSol = { provider: 'amazon-bedrock', id: 'global.openai.GPT-5.6-SOL' };
  eq('canonical label combines provider and model id', modelLabel(bedrockSol), 'amazon-bedrock/global.openai.GPT-5.6-SOL');

  const solMatches = matchingModelPrompts(loaded.definitions, bedrockSol);
  eq('provider and model patterns match case-insensitively', solMatches.map((d) => d.fileName), [
    '10-sol.md',
    '20-openai.md',
  ]);
  eq(
    'all matches append in lexical order and preserve the base prompt',
    appendModelPrompts('Base prompt.', solMatches),
    'Base prompt.\n\nSol guidance.\n\nOpenAI guidance.',
  );
  eq('matched filenames format in lexical order', formatMatchedPromptFiles(solMatches), '10-sol.md, 20-openai.md');

  const codexMatches = matchingModelPrompts(loaded.definitions, { provider: 'custom', id: 'codex-mini' });
  eq('patterns within a file use OR semantics', codexMatches.map((d) => d.fileName), ['20-openai.md']);

  const noMatches = matchingModelPrompts(loaded.definitions, { provider: 'custom', id: 'other-model' });
  eq('non-matching model has no prompts', noMatches.length, 0);
  eq('no matches preserve the base prompt exactly', appendModelPrompts('Base prompt.', noMatches), 'Base prompt.');
  eq('no matches format explicitly', formatMatchedPromptFiles(noMatches), 'none');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
