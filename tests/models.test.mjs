import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

const models = await import('../plugins/agy/scripts/lib/models.mjs');

// Captured from `agy models` (agy 1.5.9), including its banner line.
const LISTING = [
  'Fetching available models...',
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  '',
].join('\n');

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-models-')), name);

describe('parseModelList', () => {
  test('parseModelList ignores the fetching banner and malformed lines', () => {
    const parsed = models.parseModelList(`${LISTING}not a model line\n\tno id\nBAD ID\tx\n`);
    assert.deepEqual(parsed.map((m) => m.id), [
      'gemini-4-carbon-medium',
      'gemini-4-carbon-high',
      'gemini-4-carbon-low',
      'gemini-3.8-flash-high',
      'claude-opus-5-5-high',
    ]);
    assert.equal(parsed[1].name, 'Gemini 4 Carbon (High)');
  });
});

describe('listModels', () => {
  test('listModels caches a non-empty listing for 6 hours', () => {
    const cacheFile = tmpFile('models-cache.json');
    let calls = 0;
    const run = () => {
      calls += 1;
      return LISTING;
    };
    const t0 = 1_000_000;
    const first = models.listModels('/bin/agy', { cacheFile, run, now: t0 });
    assert.equal(first.fromCache, false);
    assert.equal(first.models.length, 5);
    const second = models.listModels('/bin/agy', { cacheFile, run, now: t0 + 5 * 3600e3 });
    assert.equal(second.fromCache, true);
    assert.equal(calls, 1);
    const third = models.listModels('/bin/agy', { cacheFile, run, now: t0 + 7 * 3600e3 });
    assert.equal(third.fromCache, false);
    assert.equal(calls, 2);
  });

  test('listModels does not cache an empty or failed listing', () => {
    const cacheFile = tmpFile('models-cache.json');
    const failed = models.listModels('/bin/agy', {
      cacheFile,
      run: () => {
        throw new Error('not signed in');
      },
    });
    assert.deepEqual(failed.models, []);
    assert.match(failed.error, /not signed in/);
    assert.equal(fs.existsSync(cacheFile), false);

    const empty = models.listModels('/bin/agy', { cacheFile, run: () => 'Fetching available models...\n' });
    assert.deepEqual(empty.models, []);
    assert.equal(fs.existsSync(cacheFile), false);
  });
});

describe('resolveReviewModel', () => {
  const listed = models.parseModelList(LISTING);

  test('resolveReviewModel prefers flag, then env, then carbon', () => {
    assert.deepEqual(
      pick(models.resolveReviewModel({ flag: 'gemini-3.8-flash-high', env: 'claude-opus-5-5-high', models: listed })),
      { model: 'gemini-3.8-flash-high', source: 'flag' },
    );
    assert.deepEqual(pick(models.resolveReviewModel({ env: 'claude-opus-5-5-high', models: listed })), {
      model: 'claude-opus-5-5-high',
      source: 'env',
    });
    assert.deepEqual(pick(models.resolveReviewModel({ env: '', models: listed })), {
      model: models.CARBON_REVIEW_MODEL,
      source: 'carbon',
    });
    assert.equal(models.CARBON_REVIEW_MODEL, 'gemini-4-carbon-high');
  });

  test('resolveReviewModel falls back to agy default when carbon is not listed', () => {
    const withoutCarbon = listed.filter((m) => !m.id.startsWith('gemini-4-carbon'));
    const choice = models.resolveReviewModel({ env: '', models: withoutCarbon });
    assert.equal(choice.model, null);
    assert.equal(choice.source, 'agy-default');
    assert.match(choice.note, /Carbon 4 is not available/i);

    const unknown = models.resolveReviewModel({ env: '', models: [] });
    assert.equal(unknown.model, null);
    assert.equal(unknown.source, 'agy-default');
  });
});

describe('resolveTaskModel', () => {
  test('resolveTaskModel uses flag, then AGY_MODEL, then agy default', () => {
    assert.deepEqual(models.resolveTaskModel({ flag: 'x-model', env: 'y-model' }), { model: 'x-model', source: 'flag' });
    assert.deepEqual(models.resolveTaskModel({ env: 'y-model' }), { model: 'y-model', source: 'env' });
    assert.deepEqual(models.resolveTaskModel({ env: '' }), { model: null, source: 'agy-default' });
  });
});

describe('agyDefaultModelId', () => {
  test('agyDefaultModelId maps the settings display name to an id', () => {
    const settingsFile = tmpFile('settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ model: 'Gemini 4 Carbon (High)' }));
    assert.equal(models.agyDefaultModelId(models.parseModelList(LISTING), { settingsFile }), 'gemini-4-carbon-high');
    assert.equal(models.agyDefaultModelId(models.parseModelList(LISTING), { settingsFile: tmpFile('missing.json') }), null);
  });
});

function pick(choice) {
  return { model: choice.model, source: choice.source };
}
