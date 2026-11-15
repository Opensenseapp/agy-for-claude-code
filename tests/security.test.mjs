// Regression tests for the v0.2 security review (findings AGY-01..05) and cancel safety.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = path.join(ROOT, 'plugins', 'agy');
const COMPANION = path.join(PLUGIN, 'scripts', 'agy-companion.mjs');
const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
const sleepers = new Set();

// Never write into the real plugin state, even under plain `npm test`.
process.env.AGY_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-state-'));
const { buildDiffPacket } = await import('../plugins/agy/scripts/lib/git.mjs');
const paths = await import('../plugins/agy/scripts/lib/paths.mjs');
const processLib = await import('../plugins/agy/scripts/lib/process.mjs');

test.after(() => {
  for (const pid of sleepers) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

function repoWithChange(extra = () => {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-sec-'));
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

function companion(args, { cwd = repoWithChange(), env = {}, input } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    input,
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

// Start a sleeper that leads its own process group (like an agy child) through a
// short-lived node process, so init reaps it when it dies: a direct child would
// linger as a zombie and still answer kill(pid, 0).
function spawnSleeper() {
  const launcher = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); c.unref(); process.stdout.write(String(c.pid));`;
  const result = spawnSync(process.execPath, ['-e', launcher], { encoding: 'utf8' });
  const pid = Number(result.stdout.trim());
  sleepers.add(pid);
  return pid;
}

describe('AGY-01: heredoc delimiter', () => {
  const files = ['skills/agy-cli-runtime/SKILL.md', 'agents/agy-delegate.md', 'commands/research.md', 'commands/survey.md'];

  test('no instruction uses the fixed __AGY_PROMPT__ delimiter', () => {
    for (const file of files) {
      assert.doesNotMatch(fs.readFileSync(path.join(PLUGIN, file), 'utf8'), /__AGY_PROMPT__/, file);
    }
  });

  test('the runtime skill asks for a fresh random delimiter that no line of the text equals', () => {
    const skill = fs.readFileSync(path.join(PLUGIN, 'skills', 'agy-cli-runtime', 'SKILL.md'), 'utf8');
    assert.match(skill, /<<'AGY_PROMPT_<random>'/);
    assert.match(skill, /new random suffix for every call/i);
    assert.match(skill, /no line of the text is exactly the delimiter/i);
  });
});

describe('AGY-02: untracked symlinks', () => {
  test('an untracked symlink is never followed into the review packet', () => {
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-outside-')), 'secret.txt');
    fs.writeFileSync(outside, 'TOP-SECRET-CONTENT\n');
    const repo = repoWithChange((dir) => fs.symlinkSync(outside, path.join(dir, 'link.txt')));
    const { packet } = buildDiffPacket({ cwd: repo, includeUntracked: true });
    assert.doesNotMatch(packet, /TOP-SECRET-CONTENT/);
    assert.match(packet, /link\.txt.*symlink/);
  });
});

describe('AGY-03: question and focus text through stdin', () => {
  const tricky = 'Is $(touch PWNED) safe, and `whoami`, and $HOME?';

  for (const kind of ['review', 'adversarial-review']) {
    test(`${kind} reads its question from stdin with --prompt-stdin`, () => {
      const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-log-')), 'calls.jsonl');
      const result = companion([kind, '--prompt-stdin'], { input: tricky, env: { FAKE_AGY_LOG: log } });
      assert.ok([0, 1].includes(result.status), result.stderr);
      const call = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).find((argv) => argv.includes('-p'));
      assert.ok(call[call.indexOf('-p') + 1].includes(tricky), 'the stdin text reaches agy verbatim');
    });
  }

  test('the review and look commands document passing free text on stdin', () => {
    for (const file of ['review.md', 'adversarial-review.md', 'look.md']) {
      const text = fs.readFileSync(path.join(PLUGIN, 'commands', file), 'utf8');
      assert.match(text, /--prompt-stdin/, file);
      assert.match(text, /<<'AGY_PROMPT_<random>'/, file);
    }
  });
});

describe('AGY-05: --base cannot become a git option', () => {
  test('a --base value that starts with "-" is rejected and writes nothing', () => {
    const repo = repoWithChange();
    const target = path.join(repo, 'pwned.txt');
    assert.throws(() => buildDiffPacket({ cwd: repo, base: `--output=${target}` }), /--base/);
    assert.equal(fs.existsSync(`${target}...HEAD`), false);
    assert.equal(fs.existsSync(target), false);
  });
});

describe('AGY-04: job ids, repo keys and the state root', () => {
  test('jobPaths rejects ids and repo keys that are not plugin-shaped', () => {
    assert.throws(() => paths.jobPaths('repo-0123456789abcdef', '../../etc'), /job id/);
    assert.throws(() => paths.jobPaths('../../x', paths.newJobId()), /repo key/);
    assert.doesNotThrow(() => paths.jobPaths('repo-0123456789abcdef', paths.newJobId()));
  });

  test('result with a path-shaped job id is a usage error', () => {
    const result = companion(['result', '../../etc']);
    assert.equal(result.status, 2, result.stderr);
  });

  test('a state root that is a symlink is refused', () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-real-'));
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-link-')), 'state');
    fs.symlinkSync(real, link);
    const result = companion(['review', '--dry-run'], { env: { AGY_PLUGIN_STATE_DIR: link } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /state (root|directory)/i);
    assert.deepEqual(fs.readdirSync(real), []);
  });
});

describe('cancel and signalling safety', () => {
  test('signalGroup and signalPid never signal pid 0 or 1', () => {
    for (const pid of [0, 1, -1]) {
      assert.equal(processLib.signalGroup(pid, 0), false);
      assert.equal(processLib.signalPid(pid, 0), false);
    }
  });

  test('cancel does not signal a recorded agy process group that now belongs to another process', async () => {
    const jobs = await import('../plugins/agy/scripts/lib/jobs.mjs');
    process.env.AGY_PLUGIN_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cancel-'));
    const sleeper = spawnSleeper();
    const record = jobs.createJob({ repoRoot: '/fake/cancel', cwd: os.tmpdir(), kind: 'task', prompt: 'p', tools: false, stream: false });
    jobs.saveJob({ ...record, status: 'running', monitorPid: null, agyPgid: sleeper, agyPid: sleeper, agyStartedAt: 'Thu Jan  1 00:00:00 1970' });
    jobs.requestCancel(record.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(processLib.isAlive(sleeper), true, 'a reused pid must not be signalled');
  });
});
