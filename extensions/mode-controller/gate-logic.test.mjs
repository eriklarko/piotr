// Regression test for the mode tool allowlist.
//
// The whole point of this file is the bug it locks down: `bash` used to be
// callable in ask and plan mode because the old gate only blocked tools that
// appeared in *some* mode file ("managed" tools). A tool named nowhere was
// waved through. The allow decision is now deny-by-default, and these tests
// assert that.
//
// Imports the real implementation from utils.ts -- no copies to drift.
// Run: node --experimental-strip-types gate-logic.test.mjs

import {
  checkPatternIsBounded,
  checkPatternPrivilege,
  expandToolPatterns,
  isToolAllowed,
  resolvePlanReview,
  sortedModeNames,
} from './utils.ts';

// The tool names actually registered in this setup: builtins, scoped-tools,
// and @samfp/pi-memory. pi-tldr registers no tools.
const REGISTERED = [
  'bash', 'read', 'edit', 'write', 'grep', 'find', 'ls',
  'git_status', 'git_log', 'git_diff', 'git_add', 'git_commit', 'git_push', 'make',
  'memory_search', 'memory_remember', 'memory_forget', 'memory_lessons', 'memory_stats',
];

const ASK = { tools: ['read', 'grep', 'find', 'ls', 'git_status', 'git_log', 'git_diff', 'memory_*'] };
const BUILD = {
  tools: [
    'read', 'edit', 'write', 'grep', 'find', 'ls',
    'git_status', 'git_log', 'git_diff', 'git_add', 'git_commit', 'git_push', 'make', 'memory_*',
  ],
};

let fail = 0;
function eq(name, got, want) {
  const ok = got === want;
  if (!ok) { fail++; console.log('FAIL', name, 'got', JSON.stringify(got), 'want', JSON.stringify(want)); }
  else console.log('ok  ', name);
}

// --- the original bug -------------------------------------------------------
// `bash` is in no mode file. Under the old union-of-all-modes logic it was
// therefore "unmanaged" and allowed everywhere. It must now be denied.
eq('bash blocked in ask', isToolAllowed(ASK, 'bash'), false);
eq('bash blocked in build', isToolAllowed(BUILD, 'bash'), false);

// --- literal entries -------------------------------------------------------
eq('listed tool allowed', isToolAllowed(ASK, 'grep'), true);
eq('unlisted tool blocked', isToolAllowed(ASK, 'write'), false);
eq('unknown tool blocked', isToolAllowed(ASK, 'no_such_tool'), false);

// A tool listed in another mode gets no credit for it. This is the exact
// concept ("managed" tools) that the old gate got wrong.
eq('git_commit listed in build is blocked in ask', isToolAllowed(ASK, 'git_commit'), false);
eq('git_commit allowed in build', isToolAllowed(BUILD, 'git_commit'), true);

// --- glob entries ----------------------------------------------------------
eq('memory_* matches memory_search', isToolAllowed(ASK, 'memory_search'), true);
eq('memory_* matches memory_stats', isToolAllowed(ASK, 'memory_stats'), true);
eq('memory_* does not match bash', isToolAllowed(ASK, 'bash'), false);
eq('memory_* does not match git_commit', isToolAllowed(ASK, 'git_commit'), false);
eq('memory_* does not match bare memory', isToolAllowed(ASK, 'memory'), false);
eq('memory_* does not match x_memory_y', isToolAllowed(ASK, 'x_memory_search'), false);

// --- unbounded patterns rejected at load ----------------------------------
eq('bare * rejected', checkPatternIsBounded('*') !== undefined, true);
eq('bare ** rejected', checkPatternIsBounded('**') !== undefined, true);
eq('memory_* accepted', checkPatternIsBounded('memory_*'), undefined);
eq('literal name accepted', checkPatternIsBounded('read'), undefined);

// --- privilege-split namespaces may not be globbed ------------------------
eq('git_* rejected', checkPatternPrivilege('git_*', REGISTERED).length > 0, true);
eq('*_commit rejected', checkPatternPrivilege('*_commit', REGISTERED).length > 0, true);
eq('memory_* not flagged', checkPatternPrivilege('memory_*', REGISTERED).length, 0);
eq('literal git_commit not flagged', checkPatternPrivilege('git_commit', REGISTERED).length, 0);

// --- expansion feeds setActiveTools ---------------------------------------
const askActive = expandToolPatterns(ASK.tools, REGISTERED).sort();
eq('ask expands memory family', askActive.filter((t) => t.startsWith('memory_')).length, 5);
eq('ask active excludes bash', askActive.includes('bash'), false);
eq('ask active excludes write', askActive.includes('write'), false);
eq('ask active excludes git_push', askActive.includes('git_push'), false);
eq('pattern matching nothing expands empty', expandToolPatterns(['zzz_*'], REGISTERED).length, 0);

// --- mode ordering ---------------------------------------------------------
// One helper decides cycle position, the /mode list, and the startup mode
// (names[0]). Four separate .sort() calls used to decide this independently.
const modeMap = (entries) => new Map(entries.map(([name, order]) => [name, { order }]));

eq(
  'ordered modes follow order, not the alphabet',
  sortedModeNames(modeMap([['ask', 10], ['plan', 20], ['build', 30], ['danger', 40]])).join(','),
  'ask,plan,build,danger',
);
eq(
  'the shipped four cycle by escalating privilege',
  sortedModeNames(modeMap([['ask', 10], ['build', 30], ['danger', 40], ['plan', 20]]))[0],
  'ask',
);
eq(
  'no order anywhere falls back to alphabetical',
  sortedModeNames(modeMap([['plan', undefined], ['ask', undefined], ['build', undefined]])).join(','),
  'ask,build,plan',
);
eq(
  'unordered modes sink below ordered ones, alphabetical among themselves',
  sortedModeNames(modeMap([['zeta', undefined], ['alpha', undefined], ['build', 30], ['ask', 10]])).join(','),
  'ask,build,alpha,zeta',
);
eq(
  'duplicate order values tie-break by name',
  sortedModeNames(modeMap([['plan', 10], ['ask', 10]])).join(','),
  'ask,plan',
);
eq('empty map yields no names', sortedModeNames(new Map()).length, 0);

// --- plan review: display never clobbered by assistant text ---------------
const PLAN_WITH_CHECKLIST = [
  '# My plan',
  'blah',
  '## Task checklist',
  '1. First thing',
  '2. Second thing',
].join('\n');
const PLAN_NO_CHECKLIST = '# My plan\n\nJust prose, no checklist heading.';
const ASSISTANT_WITH_STEPS = [
  'Here is a summary.',
  '## Task checklist',
  '1. Alpha',
  '2. Beta',
  '3. Gamma',
].join('\n');

// plan file has a valid checklist -> file is displayed, steps from file
const r1 = resolvePlanReview(PLAN_WITH_CHECKLIST, ASSISTANT_WITH_STEPS);
eq('file checklist: display is the file', r1.displayContent, PLAN_WITH_CHECKLIST);
eq('file checklist: steps from file', r1.steps.map((s) => s.text).join(','), 'First thing,Second thing');

// plan file present but unparseable, assistant has steps -> file still shown,
// steps come from the assistant text
const r2 = resolvePlanReview(PLAN_NO_CHECKLIST, ASSISTANT_WITH_STEPS);
eq('unparseable file: display is still the file', r2.displayContent, PLAN_NO_CHECKLIST);
eq('unparseable file: steps from assistant', r2.steps.map((s) => s.text).join(','), 'Alpha,Beta,Gamma');

// no plan file, assistant has steps -> assistant text is shown, steps from it
const r3 = resolvePlanReview(undefined, ASSISTANT_WITH_STEPS);
eq('no file: display is assistant text', r3.displayContent, ASSISTANT_WITH_STEPS);
eq('no file: steps from assistant', r3.steps.length, 3);

// neither has steps -> steps empty; display is the plan file if present
const r4 = resolvePlanReview(PLAN_NO_CHECKLIST, 'no steps here');
eq('neither steps: empty steps', r4.steps.length, 0);
eq('neither steps: display is the file', r4.displayContent, PLAN_NO_CHECKLIST);

const r5 = resolvePlanReview(undefined, 'no steps here');
eq('neither steps, no file: display undefined', r5.displayContent, undefined);
eq('neither steps, no file: empty steps', r5.steps.length, 0);

console.log(fail ? `\n${fail} FAILED` : '\nALL PASS');
process.exit(fail ? 1 : 0);
