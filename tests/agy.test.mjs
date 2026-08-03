import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { assertPromptSize, buildAgyArgs, MAX_PROMPT_BYTES } from '../plugins/agy/scripts/lib/agy.mjs';
import { UsageError } from '../plugins/agy/scripts/lib/args.mjs';

const base = { prompt: 'do the thing' };

describe('buildAgyArgs', () => {
  test('defaults to json output with no tool access', () => {
    const args = buildAgyArgs(base);
    assert.deepEqual(args.slice(0, 2), ['--output-format', 'json']);
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  test('streams for background jobs so the log keeps growing', () => {
    const args = buildAgyArgs({ ...base, stream: true });
    assert.deepEqual(args.slice(0, 2), ['--output-format', 'stream-json']);
  });

  test('grants tool access only when explicitly asked', () => {
    const args = buildAgyArgs({ ...base, tools: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  test('never resumes implicitly', () => {
    // The codex plugin defaults to --resume-last, which silently returns a
    // previous session's findings as though they were new.
    const args = buildAgyArgs(base);
    assert.ok(!args.includes('--continue'));
    assert.ok(!args.includes('--conversation'));
  });

  test('maps resume last to --continue', () => {
    assert.ok(buildAgyArgs({ ...base, resume: 'last' }).includes('--continue'));
  });

  test('maps a conversation id to --conversation', () => {
    const args = buildAgyArgs({ ...base, resume: '11111111-2222-4333-8444-555555555555' });
    const index = args.indexOf('--conversation');
    assert.ok(index >= 0);
    assert.equal(args[index + 1], '11111111-2222-4333-8444-555555555555');
  });

  test('passes model, effort, schema and add-dirs through', () => {
    const args = buildAgyArgs({
      ...base,
      model: 'gemini-3.1-pro-high',
      effort: 'high',
      schemaPath: '/tmp/schema.json',
      addDirs: ['/a', '/b'],
    });
    assert.ok(args.includes('gemini-3.1-pro-high'));
    assert.ok(args.includes('high'));
    assert.equal(args[args.indexOf('--json-schema') + 1], '/tmp/schema.json');
    assert.equal(args.filter((arg) => arg === '--add-dir').length, 2);
  });

  test('converts the timeout to whole seconds for --print-timeout', () => {
    const args = buildAgyArgs({ ...base, timeoutMs: 90_000 });
    assert.equal(args[args.indexOf('--print-timeout') + 1], '90s');
  });

  test('puts the prompt last, after -p', () => {
    const args = buildAgyArgs(base);
    assert.equal(args.at(-2), '-p');
    assert.equal(args.at(-1), 'do the thing');
  });
});

describe('assertPromptSize', () => {
  test('rejects an empty prompt', () => {
    assert.throws(() => assertPromptSize('   '), UsageError);
  });

  test('rejects a prompt over the argv budget', () => {
    // Review packets are inlined because no-tools mode cannot read a file,
    // so an oversized diff has to fail locally rather than at exec time.
    assert.throws(() => assertPromptSize('x'.repeat(MAX_PROMPT_BYTES + 1)), /over the/);
  });

  test('accepts a prompt at exactly the limit', () => {
    assert.equal(assertPromptSize('x'.repeat(MAX_PROMPT_BYTES)), MAX_PROMPT_BYTES);
  });

  test('measures bytes rather than characters', () => {
    // Four-byte emoji: a length check would let ~4x too much through.
    const emoji = '🚀'.repeat(MAX_PROMPT_BYTES / 4 + 1);
    assert.throws(() => assertPromptSize(emoji), UsageError);
  });
});
