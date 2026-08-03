import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

let stateDir;

before(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-render-'));
  process.env.AGY_PLUGIN_STATE_DIR = stateDir;
});

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.AGY_PLUGIN_STATE_DIR;
});

const render = await import('../plugins/agy/scripts/lib/render.mjs');
const { STATUS } = await import('../plugins/agy/scripts/lib/outcome.mjs');
const { jobPaths } = await import('../plugins/agy/scripts/lib/paths.mjs');

const record = (overrides = {}) => ({
  id: 'job_20260802T165131Z_abcdef123456',
  kind: 'task',
  repoKey: 'repo-0000000000000000',
  status: STATUS.SUCCEEDED,
  createdAt: '2026-08-02T16:51:31.000Z',
  startedAt: '2026-08-02T16:51:31.000Z',
  finishedAt: '2026-08-02T16:51:41.000Z',
  label: null,
  warnings: [],
  ...overrides,
});

describe('humanDuration', () => {
  test('formats across scales', () => {
    assert.equal(render.humanDuration(5_000), '5s');
    assert.equal(render.humanDuration(90_000), '1m 30s');
    assert.equal(render.humanDuration(3_600_000), '1h 0m');
  });

  test('handles nonsense without producing NaN', () => {
    assert.equal(render.humanDuration(Number.NaN), '-');
    assert.equal(render.humanDuration(-1), '-');
  });
});

describe('renderStatusTable', () => {
  test('explains itself when there is nothing to show', () => {
    assert.match(render.renderStatusTable([]), /No agy jobs/);
  });

  test('renders one aligned row per job', () => {
    const table = render.renderStatusTable([record({ label: 'smoke' })]);
    const lines = table.split('\n');

    assert.match(lines[0], /Job\s+\| Kind/);
    assert.equal(lines.length, 3);
    assert.match(table, /smoke/);
    assert.match(table, /succeeded/);
  });

  test('shows a dash when a job has no label', () => {
    assert.match(render.renderStatusTable([record()]), /\| -\s*\|/);
  });
});

describe('statusLabel', () => {
  test('describes a denial in plain language', () => {
    assert.equal(render.statusLabel(record({ status: STATUS.DENIED })), 'denied (no tool access)');
  });

  test('annotates a long-silent running job as quiet', () => {
    const running = record({ status: 'running', finishedAt: null });
    const p = jobPaths(running.repoKey, running.id);
    fs.mkdirSync(p.dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(p.stdout, 'x');
    fs.utimesSync(p.stdout, (now - 20 * 60_000) / 1000, (now - 20 * 60_000) / 1000);

    assert.match(render.statusLabel(running, now), /quiet/);
  });
});

describe('renderUsage', () => {
  test('summarises token counts', () => {
    const text = render.renderUsage({ input_tokens: 18174, output_tokens: 31, cache_read_tokens: 8141 });
    assert.match(text, /in 18,174/);
    assert.match(text, /out 31/);
    assert.match(text, /cached 8,141/);
  });

  test('returns null when there is nothing to report', () => {
    assert.equal(render.renderUsage(null), null);
    assert.equal(render.renderUsage({}), null);
  });
});

describe('renderResult', () => {
  test('shows the response for a successful job', () => {
    const output = render.renderResult({
      record: record(),
      response: 'PIPELINE-OK',
      structured: null,
      stderr: '',
    });
    assert.match(output, /succeeded/);
    assert.match(output, /PIPELINE-OK/);
  });

  test('leads with reason and hint when the job failed', () => {
    const output = render.renderResult({
      record: record({ status: STATUS.DENIED, reason: 'every tool call was auto-denied', hint: 'grant tool access' }),
      response: null,
      structured: null,
      stderr: 'jetski: auto-denied',
    });
    assert.match(output, /auto-denied/);
    assert.match(output, /grant tool access/);
    assert.match(output, /<details><summary>stderr/);
  });

  test('hides stderr on success to avoid noise', () => {
    const output = render.renderResult({
      record: record(),
      response: 'fine',
      structured: null,
      stderr: 'some harmless chatter',
    });
    assert.ok(!output.includes('harmless chatter'));
  });

  test('prefers structured output when present', () => {
    const output = render.renderResult({
      record: record(),
      response: 'ignored prose',
      structured: { findings: [] },
      stderr: '',
    });
    assert.match(output, /"findings"/);
    assert.ok(!output.includes('ignored prose'));
  });

  test('offers the resume hint when a conversation id exists', () => {
    const output = render.renderResult({
      record: record({ conversationId: 'abc-123' }),
      response: 'ok',
      structured: null,
      stderr: '',
    });
    assert.match(output, /--resume abc-123/);
  });

  test('surfaces warnings', () => {
    const output = render.renderResult({
      record: record({ warnings: ['2 unparseable JSON line(s) in stdout'] }),
      response: 'ok',
      structured: null,
      stderr: '',
    });
    assert.match(output, /warning: 2 unparseable/);
  });
});

describe('renderDoctor', () => {
  test('marks failures and tells the user what to run next', () => {
    const output = render.renderDoctor({
      ok: false,
      checks: [{ name: 'agy binary', ok: false, detail: 'not found on PATH' }],
    });
    assert.match(output, /\[FAIL\]/);
    assert.match(output, /\/agy:setup/);
  });

  test('confirms a healthy install', () => {
    const output = render.renderDoctor({
      ok: true,
      checks: [{ name: 'agy binary', ok: true, detail: '/usr/local/bin/agy' }],
    });
    assert.match(output, /All checks passed/);
  });
});
