import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

let stateDir;

before(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-jobs-'));
  process.env.AGY_PLUGIN_STATE_DIR = stateDir;
});

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.AGY_PLUGIN_STATE_DIR;
});

const jobs = await import('../plugins/agy/scripts/lib/jobs.mjs');
const paths = await import('../plugins/agy/scripts/lib/paths.mjs');
const { STATUS } = await import('../plugins/agy/scripts/lib/outcome.mjs');
const { startTimeOf } = await import('../plugins/agy/scripts/lib/process.mjs');

// This test process stands in for a live monitor. Its start time is recorded the
// way spawnMonitor and the foreground path record the real monitor's.
const liveMonitor = () => ({ monitorPid: process.pid, monitorStartedAt: startTimeOf(process.pid) });

let counter = 0;
const makeJob = (overrides = {}) =>
  jobs.createJob({
    repoRoot: `/fake/repo-${counter++}`,
    cwd: '/fake/repo',
    kind: 'task',
    prompt: 'do the thing',
    tools: true,
    stream: false,
    ...overrides,
  });

describe('createJob', () => {
  test('writes a record, an index entry, and the prompt file', () => {
    const record = makeJob();
    const p = paths.jobPaths(record.repoKey, record.id);

    assert.ok(fs.existsSync(p.record));
    assert.equal(paths.readIndexEntry(record.id), record.repoKey);
    assert.equal(fs.readFileSync(p.prompt, 'utf8'), 'do the thing');
  });

  test('keeps the prompt out of the record itself', () => {
    // Records are rendered constantly; the prompt is kept in one 0600 file.
    const record = makeJob({ prompt: 'a very secret prompt' });
    const raw = fs.readFileSync(paths.jobPaths(record.repoKey, record.id).record, 'utf8');
    assert.ok(!raw.includes('a very secret prompt'));
    assert.equal(record.promptBytes, 'a very secret prompt'.length);
  });

  test('loadJob finds a job by id alone', () => {
    const record = makeJob();
    assert.equal(jobs.loadJob(record.id)?.id, record.id);
  });

  test('loadJob returns null for an unknown id', () => {
    assert.equal(jobs.loadJob('job_nope'), null);
  });

  test('identical requests share a fingerprint; different ones do not', () => {
    const a = makeJob({ repoRoot: '/same', prompt: 'x' });
    const b = makeJob({ repoRoot: '/same', prompt: 'x' });
    const c = makeJob({ repoRoot: '/same', prompt: 'y' });

    assert.equal(a.fingerprint, b.fingerprint);
    assert.notEqual(a.fingerprint, c.fingerprint);
  });

  test('model and effort are part of the fingerprint', () => {
    const a = makeJob({ repoRoot: '/same2', prompt: 'x' });
    const b = makeJob({ repoRoot: '/same2', prompt: 'x', model: 'gemini-3.1-pro-high' });
    assert.notEqual(a.fingerprint, b.fingerprint);
  });
});

describe('findDuplicate', () => {
  test('finds a live running job with the same fingerprint', () => {
    const record = makeJob({ repoRoot: '/dup' });
    jobs.saveJob({ ...record, status: 'running', ...liveMonitor() });

    const found = jobs.findDuplicate(record.repoKey, record.fingerprint);
    assert.equal(found?.id, record.id);
  });

  test('ignores jobs that have already finished', () => {
    const record = makeJob({ repoRoot: '/dup-done' });
    jobs.saveJob({ ...record, status: STATUS.SUCCEEDED, monitorPid: process.pid });
    assert.equal(jobs.findDuplicate(record.repoKey, record.fingerprint), null);
  });

  test('ignores jobs whose monitor is gone', () => {
    const record = makeJob({ repoRoot: '/dup-dead' });
    // PID 0 is never a live monitor process.
    jobs.saveJob({ ...record, status: 'running', monitorPid: 0 });
    assert.equal(jobs.findDuplicate(record.repoKey, record.fingerprint), null);
  });

  test('ignores a job whose monitor pid now belongs to another process', () => {
    const record = makeJob({ repoRoot: '/dup-reused' });
    // A live pid with a different start time: the monitor exited and the pid was reused.
    jobs.saveJob({ ...record, status: 'running', monitorPid: process.pid, monitorStartedAt: 'Thu Jan  1 00:00:00 1970' });
    assert.equal(jobs.findDuplicate(record.repoKey, record.fingerprint), null);
  });

  test('ignores jobs older than the dedup window', () => {
    const record = makeJob({ repoRoot: '/dup-old' });
    jobs.saveJob({
      ...record,
      status: 'running',
      ...liveMonitor(),
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    assert.equal(jobs.findDuplicate(record.repoKey, record.fingerprint), null);
  });
});

describe('quiet detection', () => {
  const touchLog = (record, mtimeMs) => {
    const p = paths.jobPaths(record.repoKey, record.id);
    fs.writeFileSync(p.stdout, 'partial output\n');
    const seconds = mtimeMs / 1000;
    fs.utimesSync(p.stdout, seconds, seconds);
  };

  test('reports null before any output exists', () => {
    const record = makeJob({ repoRoot: '/quiet-none' });
    assert.equal(jobs.quietMs(record), null);
  });

  test('measures time since the last write', () => {
    const record = makeJob({ repoRoot: '/quiet-some' });
    const now = Date.now();
    touchLog(record, now - 120_000);
    const quiet = jobs.quietMs(record, now);
    assert.ok(quiet >= 119_000 && quiet <= 121_000, `unexpected quiet=${quiet}`);
  });

  test('a two-minute silence is not treated as stalled', () => {
    // A short threshold produces false stalls: document reviews routinely think
    // for minutes without writing a byte.
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/quiet-ok' }), status: 'running' });
    const now = Date.now();
    touchLog(record, now - 120_000);
    assert.equal(jobs.isQuiet(record, jobs.DEFAULT_STALL_MS, now), false);
  });

  test('a fifteen-minute silence is reported as quiet', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/quiet-bad' }), status: 'running' });
    const now = Date.now();
    touchLog(record, now - 15 * 60_000);
    assert.equal(jobs.isQuiet(record, jobs.DEFAULT_STALL_MS, now), true);
  });

  test('a finished job is never reported as quiet', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/quiet-done' }), status: STATUS.SUCCEEDED });
    const now = Date.now();
    touchLog(record, now - 60 * 60_000);
    assert.equal(jobs.isQuiet(record, jobs.DEFAULT_STALL_MS, now), false);
  });
});

describe('reconcile', () => {
  test('finalizes a running job whose monitor died', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/rec-dead' }), status: 'running', monitorPid: 0 });
    const settled = jobs.reconcile(record);

    assert.ok(jobs.isTerminal(settled.status));
    assert.match(settled.reason, /monitor exited without finalizing/);
  });

  test('recovers a real result the dead monitor never recorded', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/rec-out' }), status: 'running', monitorPid: 0 });
    fs.writeFileSync(
      paths.jobPaths(record.repoKey, record.id).stdout,
      JSON.stringify({ status: 'SUCCESS', response: 'done', conversation_id: 'abc' }),
    );

    const settled = jobs.reconcile(record);
    assert.equal(settled.status, STATUS.SUCCEEDED);
    assert.equal(settled.conversationId, 'abc');
  });

  test('leaves an already-terminal record untouched', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/rec-done' }), status: STATUS.SUCCEEDED, reason: 'completed' });
    assert.equal(jobs.reconcile(record).reason, 'completed');
  });

  test('does not disturb a job whose monitor is alive', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/rec-live' }), status: 'running', ...liveMonitor() });
    assert.equal(jobs.reconcile(record).status, 'running');
  });

  test('finalizes a job whose monitor pid was reused (start time differs)', () => {
    const record = jobs.saveJob({
      ...makeJob({ repoRoot: '/rec-reused' }),
      status: 'running',
      monitorPid: process.pid,
      monitorStartedAt: 'Thu Jan  1 00:00:00 1970',
    });
    const settled = jobs.reconcile(record);
    assert.ok(jobs.isTerminal(settled.status));
    assert.match(settled.reason, /monitor exited without finalizing/);
  });

  test('finalizes an older record (no start time) whose pid is not a companion process', () => {
    // Records written before monitorStartedAt existed fall back to the command
    // line. This test runner's command line is not agy-companion.mjs.
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/rec-legacy' }), status: 'running', monitorPid: process.pid });
    assert.ok(jobs.isTerminal(jobs.reconcile(record).status));
  });
});

describe('requestCancel', () => {
  test('reports a missing job rather than throwing', () => {
    const outcome = jobs.requestCancel('job_missing');
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /no job found/);
  });

  test('refuses to cancel a finished job', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/cancel-done' }), status: STATUS.SUCCEEDED });
    const outcome = jobs.requestCancel(record.id);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /already succeeded/);
  });

  test('finalizes a job whose monitor has vanished', () => {
    const record = jobs.saveJob({ ...makeJob({ repoRoot: '/cancel-orphan' }), status: 'running', monitorPid: 0 });
    const outcome = jobs.requestCancel(record.id);

    assert.equal(outcome.ok, true);
    assert.equal(jobs.loadJob(record.id).status, STATUS.CANCELLED);
  });
});

describe('listJobs', () => {
  test('returns newest first', () => {
    const repoRoot = '/list-order';
    const first = makeJob({ repoRoot });
    const second = makeJob({ repoRoot });
    jobs.saveJob({ ...first, createdAt: '2026-01-01T00:00:00.000Z', status: STATUS.SUCCEEDED });
    jobs.saveJob({ ...second, createdAt: '2026-06-01T00:00:00.000Z', status: STATUS.SUCCEEDED });

    const listed = jobs.listJobs({ repoKey: first.repoKey });
    assert.equal(listed[0].id, second.id);
  });

  test('scopes to one repository unless all is set', () => {
    const mine = makeJob({ repoRoot: '/scoped-mine' });
    jobs.saveJob({ ...mine, status: STATUS.SUCCEEDED });
    makeJob({ repoRoot: '/scoped-other' });

    const scoped = jobs.listJobs({ repoKey: mine.repoKey });
    assert.ok(scoped.every((record) => record.repoKey === mine.repoKey));
    assert.ok(jobs.listJobs({ all: true }).length > scoped.length);
  });
});
