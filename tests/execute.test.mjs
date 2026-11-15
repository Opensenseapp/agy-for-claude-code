// End-to-end: executeJob against a fake agy (tests/fixtures/fake-agy.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const FAKE_AGY = fileURLToPath(new URL('./fixtures/fake-agy.mjs', import.meta.url));
process.env.AGY_BIN = FAKE_AGY;

const jobs = await import('../plugins/agy/scripts/lib/jobs.mjs');
const { STATUS } = await import('../plugins/agy/scripts/lib/outcome.mjs');

let counter = 0;
function runFake(env, spec) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-exec-')), 'calls.jsonl');
  Object.assign(process.env, { FAKE_AGY_LOG: log, FAKE_AGY_REFUSE_MODELS: '', ...env });
  const record = jobs.createJob({
    repoRoot: `/fake/exec-${counter++}`,
    cwd: os.tmpdir(),
    kind: 'review',
    prompt: 'review this',
    tools: false,
    stream: false,
    timeoutMs: 30_000,
    ...spec,
  });
  return jobs.executeJob(record.repoKey, record.id).then((finished) => ({
    finished,
    calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [],
  }));
}

const modelOf = (argv) => (argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : null);

describe('refusal fallback', () => {
  test('auto-chosen model refused is retried once on agy default', async () => {
    const { finished, calls } = await runFake(
      { FAKE_AGY_REFUSE_MODELS: 'gemini-4-carbon-high' },
      { model: 'gemini-4-carbon-high', modelSource: 'carbon', fallbackModel: null },
    );
    assert.deepEqual(calls.map(modelOf), ['gemini-4-carbon-high', null]);
    assert.equal(finished.status, STATUS.SUCCEEDED);
    assert.equal(finished.attempts.length, 2);
    assert.equal(finished.modelUsed, 'agy-default');
    assert.match(finished.fallbackNote, /quota/i);
  });

  test('explicit model is never retried', async () => {
    const { finished, calls } = await runFake(
      { FAKE_AGY_REFUSE_MODELS: 'gemini-4-carbon-high' },
      { model: 'gemini-4-carbon-high', modelSource: 'flag', fallbackModel: null },
    );
    assert.equal(calls.length, 1);
    assert.equal(finished.status, STATUS.FAILED);
    assert.match(`${finished.reason} ${finished.hint}`, /Individual quota reached/);
  });

  test('no retry when agy default is the same model', async () => {
    const { finished, calls } = await runFake(
      { FAKE_AGY_REFUSE_MODELS: 'gemini-4-carbon-high' },
      { model: 'gemini-4-carbon-high', modelSource: 'carbon', fallbackModel: 'gemini-4-carbon-high' },
    );
    assert.equal(calls.length, 1);
    assert.equal(finished.status, STATUS.FAILED);
  });

  test("a second refusal fails with agy's message", async () => {
    const { finished, calls } = await runFake(
      { FAKE_AGY_REFUSE_MODELS: 'gemini-4-carbon-high,default' },
      { model: 'gemini-4-carbon-high', modelSource: 'carbon', fallbackModel: null },
    );
    assert.equal(calls.length, 2);
    assert.equal(finished.status, STATUS.FAILED);
    assert.match(`${finished.reason} ${finished.hint}`, /Individual quota reached/);
    assert.equal(finished.attempts.length, 2);
  });

  test('a succeeding first attempt runs once and records the model used', async () => {
    const { finished, calls } = await runFake({}, { model: 'gemini-4-carbon-high', modelSource: 'carbon', fallbackModel: null });
    assert.equal(calls.length, 1);
    assert.equal(finished.status, STATUS.SUCCEEDED);
    assert.equal(finished.modelUsed, 'gemini-4-carbon-high');
    assert.equal(finished.fallbackNote, null);
  });
});
