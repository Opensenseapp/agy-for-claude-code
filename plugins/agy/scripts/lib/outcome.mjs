/**
 * Outcome classification for an agy run.
 *
 * This is the most important module in the plugin. agy exits 0 with
 * `{"status":"SUCCESS","response":""}` when headless mode auto-denies a tool
 * permission, so a runtime that trusts `status` alone reports success on a job
 * that did precisely nothing. Everything here exists to make that impossible.
 *
 * Pure functions only — no fs, no spawn — so every branch is unit testable.
 */

export const STATUS = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  DENIED: 'denied',
  PARTIAL_DENIED: 'partial_denied',
  SCHEMA_VIOLATION: 'schema_violation',
  EMPTY: 'empty',
  CANCELLED: 'cancelled',
  TIMEOUT: 'timeout',
};

export const TERMINAL_STATUSES = new Set(Object.values(STATUS));

/** Statuses that mean the caller got usable output. */
export const OK_STATUSES = new Set([STATUS.SUCCEEDED, STATUS.PARTIAL_DENIED]);

/**
 * Matches agy's headless auto-deny diagnostic, e.g.
 *   jetski: no output produced — a tool required the "read_file" permission
 *   that headless mode cannot prompt for, so it was auto-denied.
 *
 * Deliberately narrow: matching on `permissions.allow` alone would also fire on
 * unrelated advice text that merely mentions the settings key.
 */
const DENIAL_PATTERN = /auto-denied|cannot prompt for/i;
const DENIED_PERMISSION_PATTERN = /required the "([^"]+)" permission/i;

/**
 * Extract the terminal result payload from agy stdout.
 *
 * Handles both output formats:
 *   --output-format json        → one JSON object
 *   --output-format stream-json → NDJSON, terminal line is {"event":"result",...}
 *
 * @param {string} text raw stdout
 * @returns {{result: object|null, resultCount: number, malformedLines: number}}
 */
export function parseAgyOutput(text) {
  const out = { result: null, resultCount: 0, malformedLines: 0 };
  if (typeof text !== 'string' || text.trim() === '') return out;

  // Fast path: the whole payload is a single (possibly pretty-printed) object.
  const whole = tryParse(text);
  if (whole && isResultPayload(whole)) {
    return { result: whole, resultCount: 1, malformedLines: 0 };
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Non-JSON lines are expected: agy writes human notices to the same stream
    // in some modes, and we merge nothing else into this file.
    if (!trimmed.startsWith('{')) continue;

    const parsed = tryParse(trimmed);
    if (!parsed) {
      out.malformedLines++;
      continue;
    }

    if (parsed.event === 'result' && parsed.result && typeof parsed.result === 'object') {
      out.result = parsed.result;
      out.resultCount++;
    } else if (isResultPayload(parsed)) {
      out.result = parsed;
      out.resultCount++;
    }
  }

  return out;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function isResultPayload(obj) {
  return (
    typeof obj.status === 'string' &&
    (Object.hasOwn(obj, 'response') || Object.hasOwn(obj, 'conversation_id'))
  );
}

export function hasTextContent(result) {
  return typeof result?.response === 'string' && result.response.trim() !== '';
}

export function hasStructuredContent(result) {
  // Explicit null/undefined check: a schema may legitimately yield falsey
  // values (0, false, "") and those are real content, not emptiness.
  return result?.structured_output !== undefined && result?.structured_output !== null;
}

export function deniedPermissionName(stderrText) {
  return DENIED_PERMISSION_PATTERN.exec(stderrText ?? '')?.[1] ?? null;
}

/**
 * Classify a finished agy run.
 *
 * Terminal causes are checked before content so that a cancelled or crashed job
 * can never be reported as a success just because it happened to flush a result
 * line first.
 *
 * @param {object} input
 * @param {boolean} [input.cancelled]  cancellation was requested for this job
 * @param {boolean} [input.timedOut]   the monitor's deadline fired
 * @param {number|null} [input.exitCode]
 * @param {string|null} [input.signal] e.g. 'SIGKILL'
 * @param {string} [input.stdout]      raw stdout (NDJSON or single JSON)
 * @param {string} [input.stderr]      raw stderr, kept separate to avoid tearing
 * @param {boolean} [input.schemaRequested] a --json-schema was passed
 * @returns {{status: string, reason: string, hint: string|null, warnings: string[], result: object|null}}
 */
export function classifyOutcome(input = {}) {
  const {
    cancelled = false,
    timedOut = false,
    exitCode = null,
    signal = null,
    stdout = '',
    stderr = '',
    schemaRequested = false,
  } = input;

  const { result, resultCount, malformedLines } = parseAgyOutput(stdout);
  const warnings = [];
  if (resultCount > 1) {
    warnings.push(`stdout contained ${resultCount} result payloads; used the last one`);
  }
  if (malformedLines > 0) {
    warnings.push(`${malformedLines} unparseable JSON line(s) in stdout`);
  }

  const done = (status, reason, hint = null) => ({ status, reason, hint, warnings, result });

  // 1. Explicit cancellation always wins.
  if (cancelled) {
    return done(STATUS.CANCELLED, 'cancelled by request');
  }

  // 2. Deadline.
  if (timedOut) {
    return done(STATUS.TIMEOUT, 'exceeded the job deadline', 'raise --timeout or narrow the task');
  }

  // 3. Killed by a signal.
  if (signal) {
    return done(STATUS.FAILED, `terminated by signal ${signal}`, 'the process was killed externally');
  }

  // 4. Non-zero exit, even if a result payload was written.
  if (exitCode !== 0 && exitCode !== null) {
    return done(STATUS.FAILED, `agy exited with code ${exitCode}`, tailOf(stderr));
  }

  // 5. Result validity.
  if (!result) {
    const reason =
      malformedLines > 0
        ? 'no valid result payload (output was malformed or truncated)'
        : 'no result payload in agy output';
    return done(STATUS.FAILED, reason, tailOf(stderr));
  }

  // 6. agy's own status field.
  if (result.status !== 'SUCCESS') {
    return done(STATUS.FAILED, `agy reported status ${result.status}`, tailOf(stderr));
  }

  // 7. Permission denial. Partial output still counts as a denial signal because
  //    the run is incomplete even though it produced text.
  if (DENIAL_PATTERN.test(stderr)) {
    const permission = deniedPermissionName(stderr);
    const hint = permission
      ? `re-run with tool access (the "${permission}" permission was auto-denied)`
      : 're-run with tool access, or make the prompt self-contained';
    const anyContent = hasTextContent(result) || hasStructuredContent(result);
    return anyContent
      ? done(STATUS.PARTIAL_DENIED, 'produced output but a tool permission was auto-denied', hint)
      : done(STATUS.DENIED, 'every tool call was auto-denied in headless mode', hint);
  }

  // 8. Structured output was requested but not produced.
  if (schemaRequested && !hasStructuredContent(result)) {
    return done(
      STATUS.SCHEMA_VIOLATION,
      'a JSON schema was requested but no structured_output was returned',
      'the model answered in prose; retry or relax the schema',
    );
  }

  // 9. Content validity.
  if (!hasTextContent(result) && !hasStructuredContent(result)) {
    return done(STATUS.EMPTY, 'agy returned an empty response', 'the prompt produced no output');
  }

  return done(STATUS.SUCCEEDED, 'completed');
}

function tailOf(text, lines = 3) {
  if (!text) return null;
  const kept = text.trim().split('\n').filter(Boolean).slice(-lines).join(' | ');
  return kept === '' ? null : kept;
}

/** agy statuses that mean "this model is not available to you right now". */
const REFUSAL_STATUSES = new Set(['RESOURCE_EXHAUSTED', 'PERMISSION_DENIED', 'NOT_FOUND', 'FAILED_PRECONDITION']);

/**
 * Read agy's `AGY_ERROR: {...}` stderr line and report a model refusal (quota
 * reached, or the plan does not include the model). Other errors return null.
 */
export function detectModelRefusal(stderrText) {
  for (const line of String(stderrText ?? '').split('\n').reverse()) {
    if (!line.startsWith('AGY_ERROR: ')) continue;
    let error;
    try {
      error = JSON.parse(line.slice('AGY_ERROR: '.length));
    } catch {
      return null;
    }
    if (!REFUSAL_STATUSES.has(error?.status)) return null;
    return {
      code: Number.isFinite(error.error_code) ? error.error_code : null,
      status: error.status,
      message: typeof error.short_error === 'string' ? error.short_error : error.status,
    };
  }
  return null;
}
