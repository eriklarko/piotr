import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repo = fileURLToPath(new URL('../', import.meta.url));
const executable = (name) => {
  const path = process.env.PATH.split(delimiter).map((dir) => join(dir, name)).find(existsSync);
  assert.ok(path, `${name} is required to run these tests`);
  return path;
};
const make = executable('make');

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pi-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'tools');
  const home = join(root, 'home');
  const log = join(root, 'commands.log');
  const archive = join(root, 'archive');
  mkdirSync(bin);
  mkdirSync(home);
  mkdirSync(join(root, 'docker-sandbox'));
  writeFileSync(join(root, 'Makefile'), readFileSync(join(repo, 'Makefile')));
  writeFileSync(join(root, 'safe-pi'), '');
  writeFileSync(join(root, 'unsafe-pi'), '');
  writeFileSync(join(root, 'docker-sandbox/Dockerfile'), 'ARG PI_VERSION=0.87.0\n');
  for (const name of ['sed', 'head', 'rm', 'mkdir', 'ln', 'dirname', 'echo']) {
    symlinkSync(executable(name), join(bin, name));
  }
  symlinkSync(make, join(bin, 'make'));
  const stub = (name, body) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('docker', `
    echo "docker $*" >> "$TEST_LOG"
    if [ "$1" = save ]; then
      echo "save:$4" >> "$TEST_LOG"
      [ -f "$4" ] || exit 9
      echo archive > "$4"
      exit "${options.saveStatus ?? 0}"
    fi
  `);
  stub('sbx', `
    echo "sbx $*" >> "$TEST_LOG"
    if [ "$1" = template ] && [ "$2" = load ]; then
      echo "load:$3" >> "$TEST_LOG"
      [ -s "$3" ] || exit 9
      exit "${options.loadStatus ?? 0}"
    fi
  `);
  // Model GNU mktemp: the old '-t pi-sandbox' template is invalid.
  stub('mktemp', `
    echo "mktemp $*" >> "$TEST_LOG"
    [ "$#" = 0 ] || exit 1
    [ "${options.tempStatus ?? 0}" = 0 ] || exit 1
    : > "$TEST_ARCHIVE"
    printf '%s\\n' "$TEST_ARCHIVE"
  `);
  if (!options.missingNode) {
    stub('node', `exec '${process.execPath}' -e 'Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION }); eval(process.argv[1]);' "$2"`);
  }
  if (!options.missingNpm) stub('npm', 'echo "npm $*" >> "$TEST_LOG"');
  const wrapperDir = join(home, options.customBin ? 'custom-bin' : '.local/bin');
  const path = options.pathMode === 'missing' ? bin
    : `${bin}:${wrapperDir}${options.pathMode === 'substring' ? '-other' : ''}`;
  return {
    root, home, archive, wrapperDir,
    log: () => existsSync(log) ? readFileSync(log, 'utf8') : '',
    run: (target) => spawnSync(make, ['--no-print-directory', target,
      ...(options.customBin ? [`BIN_DIR=${wrapperDir}`] : [])], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, MAKEFLAGS: '', MFLAGS: '', HOME: home, PATH: path,
        TEST_LOG: log, TEST_ARCHIVE: archive, TEST_NODE_VERSION: options.nodeVersion ?? '24.0.0' },
    }),
  };
}

for (const [name, options] of [
  ['successful load', {}],
  ['failed save', { saveStatus: 1 }],
  ['failed load', { loadStatus: 1 }],
]) {
  test(`image cleans up its portable temporary archive after ${name}`, (t) => {
    const f = fixture(t, options);
    const result = f.run('image');
    if (name === 'successful load') assert.equal(result.status, 0, result.stderr);
    else assert.notEqual(result.status, 0);
    assert.ok(f.log().includes(`save:${f.archive}\n`), f.log());
    if (name === 'failed save') assert.ok(!f.log().includes('load:'));
    else assert.ok(f.log().includes(`load:${f.archive}\n`), f.log());
    assert.equal(existsSync(f.archive), false);
  });
}

test('image stops before save or load when mktemp fails', (t) => {
  const f = fixture(t, { tempStatus: 1 });
  const result = f.run('image');
  assert.notEqual(result.status, 0);
  assert.ok(!f.log().includes('save:'), f.log());
  assert.ok(!f.log().includes('load:'), f.log());
  assert.equal(existsSync(f.archive), false);
});

for (const [name, options, message] of [
  ['missing Node', { missingNode: true }, /Node.js.*22\.18/],
  ['Node 20', { nodeVersion: '20.19.0' }, /Node.js.*22\.18/],
  ['Node 22.17', { nodeVersion: '22.17.0' }, /Node.js.*22\.18/],
  ['missing npm', { missingNpm: true }, /npm.*not found/],
  ['missing wrapper directory in PATH', { pathMode: 'missing' }, /PATH/],
  ['substring-only PATH match', { pathMode: 'substring' }, /PATH/],
]) {
  test(`bootstrap rejects ${name} before changing anything`, (t) => {
    const f = fixture(t, options);
    const result = f.run('bootstrap');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, message);
    assert.equal(existsSync(join(f.home, '.pi')), false);
    assert.equal(existsSync(f.wrapperDir), false);
    assert.equal(f.log(), '', 'no packages or images should be created');
    if (options.pathMode) {
      assert.ok((result.stdout + result.stderr).includes(`export PATH="${f.wrapperDir}:$PATH"`));
      assert.match(result.stdout + result.stderr, /shell startup file/);
    }
  });
}

for (const nodeVersion of ['22.18.0', '24.0.0']) {
  test(`bootstrap proceeds with Node ${nodeVersion} and a not-yet-created PATH directory`, (t) => {
    const f = fixture(t, { nodeVersion });
    assert.equal(existsSync(f.wrapperDir), false);
    const result = f.run('bootstrap');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(f.wrapperDir, 'safe-pi')));
    assert.ok(existsSync(join(f.wrapperDir, 'unsafe-pi')));
    assert.ok(existsSync(join(f.home, '.pi')));
    assert.match(f.log(), /npm install/);
    assert.match(f.log(), /sbx template load/);
  });
}

test('bootstrap accepts the configured BIN_DIR as a complete PATH entry', (t) => {
  const f = fixture(t, { customBin: true });
  const result = f.run('bootstrap');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(f.wrapperDir, 'safe-pi')));
});
