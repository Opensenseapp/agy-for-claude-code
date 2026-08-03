import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseDuration, parseFlags, UsageError, validateFlags } from '../plugins/agy/scripts/lib/args.mjs';

describe('parseFlags', () => {
  test('handles booleans, values, and =-form together', () => {
    const { flags, positionals } = parseFlags([
      '--background',
      '--model',
      'gemini-3.1-pro-high',
      '--effort=high',
      'do',
      'the',
      'thing',
    ]);
    assert.equal(flags.background, true);
    assert.equal(flags.model, 'gemini-3.1-pro-high');
    assert.equal(flags.effort, 'high');
    assert.deepEqual(positionals, ['do', 'the', 'thing']);
  });

  test('collects repeatable flags into an array', () => {
    const { flags } = parseFlags(['--add-dir', '/a', '--add-dir', '/b']);
    assert.deepEqual(flags['add-dir'], ['/a', '/b']);
  });

  test('everything after -- is positional, even flag-like text', () => {
    const { positionals } = parseFlags(['--background', '--', '--model', 'not-a-flag']);
    assert.deepEqual(positionals, ['--model', 'not-a-flag']);
  });

  test('rejects an unknown flag rather than silently ignoring it', () => {
    assert.throws(() => parseFlags(['--totally-made-up']), UsageError);
  });

  test('rejects flags that promise behaviour the runtime does not implement', () => {
    // --isolate and --auto-cancel-stalled were designed but never wired up.
    // Accepting them silently is worse than rejecting them: a caller would
    // believe a job was sandboxed, or that a quiet job would be killed, when
    // neither happens. If either is implemented later, delete this test.
    assert.throws(() => parseFlags(['--isolate']), UsageError);
    assert.throws(() => parseFlags(['--auto-cancel-stalled']), UsageError);
  });

  test('rejects a value-taking flag with no value', () => {
    assert.throws(() => parseFlags(['--model']), UsageError);
  });

  test('rejects a value attached to a boolean flag', () => {
    assert.throws(() => parseFlags(['--background=soon']), UsageError);
  });

  test('supports explicit --flag=false', () => {
    const { flags } = parseFlags(['--background=false']);
    assert.equal(flags.background, false);
  });
});

describe('validateFlags', () => {
  test('accepts the three efforts agy actually supports', () => {
    for (const effort of ['low', 'medium', 'high']) {
      assert.doesNotThrow(() => validateFlags({ effort }));
    }
  });

  test("rejects codex's xhigh, which agy does not have", () => {
    assert.throws(() => validateFlags({ effort: 'xhigh' }), /low\|medium\|high/);
  });

  test('rejects contradictory execution modes', () => {
    assert.throws(() => validateFlags({ background: true, wait: true }), UsageError);
  });

  test('accepts resume last or a conversation uuid', () => {
    assert.doesNotThrow(() => validateFlags({ resume: 'last' }));
    assert.doesNotThrow(() => validateFlags({ resume: '11111111-2222-4333-8444-555555555555' }));
  });

  test('rejects a resume target that is neither', () => {
    assert.throws(() => validateFlags({ resume: 'yesterday' }), UsageError);
  });

  test('rejects an unparseable timeout', () => {
    assert.throws(() => validateFlags({ timeout: 'soon' }), UsageError);
  });
});

describe('parseDuration', () => {
  test('parses every supported unit', () => {
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('30s'), 30_000);
    assert.equal(parseDuration('10m'), 600_000);
    assert.equal(parseDuration('2h'), 7_200_000);
    assert.equal(parseDuration('7d'), 604_800_000);
  });

  test('treats a bare number as seconds', () => {
    assert.equal(parseDuration('45'), 45_000);
  });

  test('returns null for junk rather than NaN', () => {
    assert.equal(parseDuration('soon'), null);
    assert.equal(parseDuration(''), null);
    assert.equal(parseDuration('10x'), null);
  });
});
