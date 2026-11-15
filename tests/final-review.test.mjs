// Fixes from the v0.2.0 final review.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPANION = path.join(ROOT, 'plugins', 'agy', 'scripts', 'agy-companion.mjs');
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
// Never write into the real plugin state, even under plain `npm test`.
process.env.AGY_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-state-'));
const paths = await import('../plugins/agy/scripts/lib/paths.mjs');

function makeRepo(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-fr-')), extra = () => {}) {
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 1;\n');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const a = 2;\n');
  extra(dir);
  return dir;
}

function companion(args, { cwd = makeRepo(), env = {} } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AGY_BIN: FAKE_AGY,
      AGY_PLUGIN_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-state-')),
      ...env,
    },
  });
}

describe('setup', () => {
  test('/agy:setup passes in a healthy repository', () => {
    const result = companion(['doctor']);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /All checks passed/);
  });

  test('/agy:setup outside a git repository is not a failure', () => {
    const result = companion(['doctor'], { cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norepo-')) });
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /not a git repository/);
  });
});

describe('repository names', () => {
  test('a repository in a dot-named folder can run jobs', () => {
    const key = paths.repoKeyFor('/x/.dotfiles');
    assert.match(key, /^\.dotfiles-[0-9a-f]{16}$/);
    assert.doesNotThrow(() => paths.jobPaths(key, paths.newJobId()));
    const repo = makeRepo(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dot-')), '.dotfiles'));
    const result = companion(['task', 'say hi'], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
  });
});

describe('review packet limits', () => {
  test('one large untracked file is listed as omitted, not treated as an oversized change', () => {
    const repo = makeRepo(undefined, (dir) => fs.writeFileSync(path.join(dir, 'fixture.json'), 'x'.repeat(50_000)));
    const result = companion(['review', '--include-untracked', '--dry-run'], { cwd: repo });
    assert.equal(result.status, 0, result.stderr);
  });

  test('a --base that is not a commit is a usage error, not a silent working-tree review', () => {
    const result = companion(['review', '--base', 'no-such-branch']);
    assert.equal(result.status, 2, result.stdout);
    assert.match(result.stderr, /no-such-branch/);
  });
});

describe('docs and repository hygiene', () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

  test('review.md states the same model precedence as the code', () => {
    assert.match(read('plugins/agy/commands/review.md'), /`--model <id>` picks the model\. Otherwise, `AGY_REVIEW_MODEL` if set, then \*\*Carbon 4 high\*\*/);
  });

  test('no skill limits effort to low, medium and high only', () => {
    assert.doesNotMatch(read('plugins/agy/skills/gemini-prompting/SKILL.md'), /low, medium, high only/i);
    assert.doesNotMatch(read('plugins/agy/scripts/lib/args.mjs'), /three reasoning levels/);
  });

  test('README explains how to run prune', () => {
    assert.match(read('README.md'), /scripts\/agy-companion\.mjs" prune --older-than 7d/);
  });

  test('no tracked file mentions a private local path', () => {
    const files = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().split('\n');
    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      assert.doesNotMatch(text, /\bmymac\b|\/Users\/[a-z]/, file);
    }
  });
});
