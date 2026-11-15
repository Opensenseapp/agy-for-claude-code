import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  classifyOutcome,
  hasStructuredContent,
  hasTextContent,
  parseAgyOutput,
  STATUS,
} from '../plugins/agy/scripts/lib/outcome.mjs';

/**
 * The exact stderr agy emits when headless mode auto-denies a tool. Captured
 * from a real run, not paraphrased — the whole point of this module is to
 * recognise this specific string.
 */
const REAL_DENIAL_STDERR =
  'jetski: no output produced — a tool required the "read_file" permission that headless ' +
  'mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow ' +
  'in settings.json (e.g. read_file(<target>)). Alternatively, re-run with ' +
  '--dangerously-skip-permissions to auto-approve all tools.';

const successResult = (overrides = {}) =>
  JSON.stringify({
    conversation_id: '11111111-2222-4333-8444-555555555555',
    status: 'SUCCESS',
    response: 'OK\n',
    duration_seconds: 1.46,
    num_turns: 1,
    usage: { input_tokens: 18174, output_tokens: 31, total_tokens: 18205 },
    ...overrides,
  });

describe('parseAgyOutput', () => {
  test('parses a single json-mode payload', () => {
    const { result, resultCount, malformedLines } = parseAgyOutput(successResult());
    assert.equal(result.status, 'SUCCESS');
    assert.equal(resultCount, 1);
    assert.equal(malformedLines, 0);
  });

  test('parses stream-json and takes the terminal result event', () => {
    const stream = [
      '{"event":"init","conversation_id":"abc","init":{"cwd":"/tmp"}}',
      '{"event":"step_update","step_update":{"step_index":2,"text_delta":"OK"}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"OK\\n","conversation_id":"abc"}}',
    ].join('\n');

    const { result, resultCount } = parseAgyOutput(stream);
    assert.equal(result.response, 'OK\n');
    assert.equal(resultCount, 1);
  });

  test('counts malformed lines instead of throwing', () => {
    const { result, malformedLines } = parseAgyOutput(`{"event":"result"\n${successResult()}`);
    assert.equal(malformedLines, 1);
    assert.equal(result.status, 'SUCCESS');
  });

  test('uses the last payload when several are present', () => {
    const text = [successResult({ response: 'first' }), successResult({ response: 'second' })].join('\n');
    const { result, resultCount } = parseAgyOutput(text);
    assert.equal(result.response, 'second');
    assert.equal(resultCount, 2);
  });

  test('returns nothing for empty input', () => {
    assert.deepEqual(parseAgyOutput(''), { result: null, resultCount: 0, malformedLines: 0 });
  });
});

describe('content detection', () => {
  test('whitespace-only response is not content', () => {
    assert.equal(hasTextContent({ response: '   \n ' }), false);
  });

  test('falsey structured output is still content', () => {
    // A schema may legitimately produce 0 or false. Treating those as "empty"
    // would report a perfectly good run as a failure.
    assert.equal(hasStructuredContent({ structured_output: 0 }), true);
    assert.equal(hasStructuredContent({ structured_output: false }), true);
    assert.equal(hasStructuredContent({ structured_output: '' }), true);
    assert.equal(hasStructuredContent({ structured_output: null }), false);
    assert.equal(hasStructuredContent({}), false);
  });
});

describe('classifyOutcome — terminal causes take precedence', () => {
  test('cancellation wins even with a successful payload', () => {
    const outcome = classifyOutcome({ cancelled: true, exitCode: 0, stdout: successResult() });
    assert.equal(outcome.status, STATUS.CANCELLED);
  });

  test('timeout wins over a successful payload', () => {
    const outcome = classifyOutcome({ timedOut: true, exitCode: 0, stdout: successResult() });
    assert.equal(outcome.status, STATUS.TIMEOUT);
  });

  test('signal termination is reported as failure, not success', () => {
    const outcome = classifyOutcome({ signal: 'SIGKILL', exitCode: null, stdout: successResult() });
    assert.equal(outcome.status, STATUS.FAILED);
    assert.match(outcome.reason, /SIGKILL/);
  });

  test('non-zero exit fails even when a SUCCESS payload was written', () => {
    // Regression guard: checking `exitCode !== 0 && !result` would let this
    // fall through to succeeded.
    const outcome = classifyOutcome({ exitCode: 3, stdout: successResult() });
    assert.equal(outcome.status, STATUS.FAILED);
    assert.match(outcome.reason, /code 3/);
  });
});

describe('classifyOutcome — result validity', () => {
  test('missing result payload fails', () => {
    const outcome = classifyOutcome({ exitCode: 0, stdout: '' });
    assert.equal(outcome.status, STATUS.FAILED);
    assert.match(outcome.reason, /no result payload/);
  });

  test('truncated output is called out as malformed', () => {
    const outcome = classifyOutcome({ exitCode: 0, stdout: '{"event":"result","resu' });
    assert.equal(outcome.status, STATUS.FAILED);
    assert.match(outcome.reason, /malformed or truncated/);
  });

  test("agy's own non-SUCCESS status fails", () => {
    const outcome = classifyOutcome({ exitCode: 0, stdout: successResult({ status: 'ERROR' }) });
    assert.equal(outcome.status, STATUS.FAILED);
    assert.match(outcome.reason, /ERROR/);
  });
});

describe('classifyOutcome — the silent no-op', () => {
  test('empty response plus the real denial stderr is denied, never succeeded', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: successResult({ response: '' }),
      stderr: REAL_DENIAL_STDERR,
    });
    assert.equal(outcome.status, STATUS.DENIED);
    assert.match(outcome.hint, /read_file/);
  });

  test('output plus a denial is partial, not clean success', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: successResult({ response: 'I found three things' }),
      stderr: REAL_DENIAL_STDERR,
    });
    assert.equal(outcome.status, STATUS.PARTIAL_DENIED);
  });

  test('empty response without a denial is empty', () => {
    const outcome = classifyOutcome({ exitCode: 0, stdout: successResult({ response: '' }) });
    assert.equal(outcome.status, STATUS.EMPTY);
  });

  test('unrelated stderr mentioning settings.json does not trigger a denial', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: successResult(),
      stderr: 'note: wrote permissions.allow to settings.json',
    });
    assert.equal(outcome.status, STATUS.SUCCEEDED);
  });
});

describe('classifyOutcome — schema handling', () => {
  test('requested schema with no structured output is a violation', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: successResult({ response: 'here is some prose' }),
      schemaRequested: true,
    });
    assert.equal(outcome.status, STATUS.SCHEMA_VIOLATION);
  });

  test('requested schema with structured output succeeds', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: successResult({ response: '{}', structured_output: { findings: [] } }),
      schemaRequested: true,
    });
    assert.equal(outcome.status, STATUS.SUCCEEDED);
  });

  test('structured output alone counts as content when no text is returned', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: successResult({ response: '', structured_output: { findings: [] } }),
      schemaRequested: true,
    });
    assert.equal(outcome.status, STATUS.SUCCEEDED);
  });
});

describe('classifyOutcome — warnings', () => {
  test('surfaces multiple result payloads as a warning', () => {
    const outcome = classifyOutcome({
      exitCode: 0,
      stdout: [successResult(), successResult()].join('\n'),
    });
    assert.equal(outcome.status, STATUS.SUCCEEDED);
    assert.match(outcome.warnings.join(' '), /2 result payloads/);
  });

  test('plain success carries no warnings', () => {
    const outcome = classifyOutcome({ exitCode: 0, stdout: successResult() });
    assert.equal(outcome.status, STATUS.SUCCEEDED);
    assert.deepEqual(outcome.warnings, []);
  });
});

describe('detectModelRefusal', () => {
  test('detectModelRefusal reads AGY_ERROR quota lines', async () => {
    const { detectModelRefusal } = await import('../plugins/agy/scripts/lib/outcome.mjs');
    const stderr =
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54h55m0s.\n' +
      'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54h55m0s.","status":"RESOURCE_EXHAUSTED","error_code":429,"code_kind":"http","retryable":true,"error_id":"x"}\n';
    const refusal = detectModelRefusal(stderr);
    assert.equal(refusal.code, 429);
    assert.equal(refusal.status, 'RESOURCE_EXHAUSTED');
    assert.match(refusal.message, /Individual quota reached/);
    assert.equal(detectModelRefusal('error: network unreachable\n'), null);
    assert.equal(detectModelRefusal('AGY_ERROR: {"status":"UNAVAILABLE","error_code":503}\n'), null);
  });
});
