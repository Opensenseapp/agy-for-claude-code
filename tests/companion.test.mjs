// The companion CLI end to end, with a fake agy and a private state directory per test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const COMPANION = fileURLToPath(new URL('../plugins/agy/scripts/agy-companion.mjs', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const NO_CARBON = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';

function repoWithChange() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-repo-'));
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  return repo;
}

function companion(args, { cwd = repoWithChange(), env = {} } = {}) {
  const result = spawnSync(process.execPath, [COMPANION, ...args], {
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
  return { ...result, cwd };
}

const modelArg = (stdout) => {
  const match = /--model (\S+)/.exec(stdout);
  return match ? match[1] : null;
};

describe('review model selection', () => {
  test('review without --model passes --model gemini-4-carbon-high when listed', () => {
    const result = companion(['review', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(modelArg(result.stdout), 'gemini-4-carbon-high');
    assert.match(result.stdout, /model: gemini-4-carbon-high \(carbon\)/);
  });

  test('review passes no --model when carbon is not listed', () => {
    const result = companion(['review', '--dry-run'], { env: { FAKE_AGY_MODELS: NO_CARBON } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(modelArg(result.stdout), null);
    assert.match(result.stdout, /model: agy default \(agy-default\)/);
  });

  test('review --effort low switches to the Carbon low variant', () => {
    const result = companion(['review', '--dry-run', '--effort', 'low']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(modelArg(result.stdout), 'gemini-4-carbon-low');
    assert.doesNotMatch(result.stdout, /--effort/);
  });

  test('AGY_REVIEW_MODEL overrides the Carbon default', () => {
    const result = companion(['review', '--dry-run'], { env: { AGY_REVIEW_MODEL: 'gemini-3.8-flash-high' } });
    assert.equal(modelArg(result.stdout), 'gemini-3.8-flash-high');
  });

  test('delegate keeps agy default unless asked', () => {
    const result = companion(['task', '--dry-run', 'do a thing']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(modelArg(result.stdout), null);
  });

  test('foreground jobs stream, so status can tell a working job from a hung one', () => {
    const result = companion(['task', '--dry-run', 'do a thing']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--output-format stream-json/);
  });
});

describe('setup', () => {
  test('doctor reports the review model and its source', () => {
    const result = companion(['doctor']);
    assert.match(result.stdout, /review model.*gemini-4-carbon-high/i);
    const without = companion(['doctor'], { env: { FAKE_AGY_MODELS: NO_CARBON } });
    assert.match(without.stdout, /review model.*agy's default.*Carbon 4 is not available/i);
  });
});

describe('output hygiene', () => {
  test("agy's model-listing banner does not leak into command output", () => {
    const result = companion(['review', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /Fetching available models/);
    const doctor = companion(['doctor']);
    assert.doesNotMatch(`${doctor.stdout}${doctor.stderr}`, /Fetching available models/);
  });
});
