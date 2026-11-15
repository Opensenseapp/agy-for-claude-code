// /agy:adversarial-review: request building, rendering that fails closed, and the CLI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const prompts = await import('../plugins/agy/scripts/lib/prompts.mjs');
const render = await import('../plugins/agy/scripts/lib/render.mjs');
const { STATUS } = await import('../plugins/agy/scripts/lib/outcome.mjs');
const { KINDS } = await import('../plugins/agy/scripts/lib/args.mjs');

const COMPANION = fileURLToPath(new URL('../plugins/agy/scripts/agy-companion.mjs', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const SCHEMA = fileURLToPath(new URL('../plugins/agy/schemas/adversarial-review.schema.json', import.meta.url));

function repoWithChange(extra = () => {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-adv-'));
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 1;\n');
  git('add', 'a.js');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'a.js'), 'export const a = 2;\n');
  extra(repo);
  return repo;
}

function companion(args, { cwd = repoWithChange(), env = {} } = {}) {
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

const baseRecord = (overrides) => ({
  id: 'job_test',
  kind: 'adversarial-review',
  status: STATUS.SUCCEEDED,
  createdAt: new Date().toISOString(),
  warnings: [],
  ...overrides,
});

describe('adversarial review request', () => {
  test('adversarial-review is a command kind', () => {
    assert.ok(KINDS.includes('adversarial-review'));
  });

  test('adversarial review builds a no-tools request with its own schema', () => {
    const result = companion(['adversarial-review', '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /--dangerously-skip-permissions/);
    assert.match(result.stdout, /--json-schema \S*adversarial-review\.schema\.json/);
    assert.ok(fs.existsSync(SCHEMA));
  });

  test('adversarial review passes focus text into the prompt', () => {
    const text = prompts.adversarialReviewPrompt({ packet: 'DIFF', focus: 'the retry path', noTools: true });
    assert.match(text, /the retry path/);
    assert.match(text, /break confidence in the change/i);
    assert.match(text, /NO tool access/);
    assert.match(text, /--- BEGIN REVIEW PACKET ---\nDIFF\n--- END REVIEW PACKET ---/);
  });

  test('adversarial review uses carbon and the adversarial schema', () => {
    const result = companion(['adversarial-review', '--dry-run', 'is', 'this', 'safe?']);
    assert.match(result.stdout, /--model gemini-4-carbon-high/);
  });

  test('adversarial review over the size cap points at --paths and --base', () => {
    // A large change to a tracked file; untracked files are capped separately by the packet builder.
    const cwd = repoWithChange((repo) => fs.writeFileSync(path.join(repo, 'a.js'), `${'// filler line\n'.repeat(40_000)}`));
    const result = companion(['adversarial-review'], { cwd });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--paths/);
    assert.match(result.stderr, /--base/);
  });
});

test('review over the size cap is rejected rather than silently truncated', () => {
  const cwd = repoWithChange((repo) => fs.writeFileSync(path.join(repo, 'a.js'), `${'// filler line\n'.repeat(40_000)}`));
  const result = companion(['review'], { cwd });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /too large to review/);
  assert.match(result.stderr, /--paths/);
});

describe('adversarial review rendering fails closed', () => {
  const approve = { verdict: 'approve', summary: 'ship it', findings: [] };

  test('adversarial review renders needs-attention or an error, never approve, when the run did not succeed', () => {
    for (const status of [STATUS.FAILED, STATUS.DENIED, STATUS.EMPTY, STATUS.SCHEMA_VIOLATION, STATUS.PARTIAL_DENIED]) {
      const text = render.renderResult({
        record: baseRecord({ status, reason: 'something went wrong' }),
        structured: status === STATUS.PARTIAL_DENIED ? approve : null,
      });
      assert.doesNotMatch(text, /Verdict: approve/, `status ${status} must not render approve`);
      assert.match(text, /Verdict: (not available|needs attention)/, `status ${status}`);
    }
  });

  test('adversarial review renders approve only for a succeeded run whose structured verdict is approve', () => {
    assert.match(render.renderResult({ record: baseRecord({}), structured: approve }), /Verdict: approve/);
    assert.match(
      render.renderResult({ record: baseRecord({}), structured: { verdict: 'needs-attention', summary: 'no', findings: [] } }),
      /Verdict: needs attention/,
    );
    assert.match(render.renderResult({ record: baseRecord({}), structured: { summary: 'missing verdict' } }), /Verdict: not available/);
  });
});
