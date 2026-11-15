/**
 * Job lifecycle.
 *
 * Every background job gets its own short-lived monitor process. The monitor —
 * not a daemon, not the Claude session — spawns agy, owns the timeout deadline,
 * captures the exit code and terminating signal, classifies the outcome, and
 * finalizes the record atomically.
 *
 * Without a monitor there is nobody to reap the child: once the launching
 * process exits, the exit code is lost forever and the runtime can only guess
 * from an absent PID, which PID reuse makes unreliable. That guessing game is
 * how a finished job ends up reported as permanently "running".
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgyArgs, resolveAgyBinary } from './agy.mjs';
import { STATUS, TERMINAL_STATUSES, classifyOutcome, detectModelRefusal } from './outcome.mjs';
import {
  claimFingerprint,
  ensureDir,
  fingerprintOf,
  jobPaths,
  listJobIds,
  listRepoKeys,
  newJobId,
  readIndexEntry,
  readJson,
  releaseFingerprint,
  removeIndexEntry,
  repoKeyFor,
  writeFileSecure,
  writeIndexEntry,
  writeJsonAtomic,
} from './paths.mjs';
import { delay, identityMatches, isAlive, signalGroup, signalPid } from './process.mjs';

const COMPANION = path.resolve(fileURLToPath(new URL('../agy-companion.mjs', import.meta.url)));
const MONITOR_MARKER = 'agy-companion.mjs';

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_STALL_MS = Number(process.env.AGY_STALL_MS ?? 600_000);
export const DEFAULT_DEDUP_WINDOW_MS = Number(process.env.AGY_DEDUP_WINDOW_MS ?? 300_000);

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Create the on-disk record for a job. Uses a non-recursive mkdir so that a
 * colliding job id fails loudly instead of silently sharing a directory.
 */
export function createJob(spec) {
  const {
    repoRoot,
    cwd,
    kind = 'task',
    label = null,
    prompt,
    tools,
    stream,
    model = null,
    modelSource = null,
    fallbackModel = null,
    modelNote = null,
    effort = null,
    resume = null,
    schemaPath = null,
    addDirs = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = spec;

  const repoKey = repoKeyFor(repoRoot ?? cwd);
  const id = newJobId();
  const paths = jobPaths(repoKey, id);

  ensureDir(path.dirname(paths.dir));
  fs.mkdirSync(paths.dir, { mode: 0o700 });

  // The prompt lives in its own 0600 file and is deliberately not duplicated
  // into the record — records are read and rendered far more often.
  writeFileSecure(paths.prompt, prompt);

  const record = {
    id,
    kind,
    label,
    repoRoot: repoRoot ?? null,
    repoKey,
    cwd,
    status: 'starting',
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    monitorPid: null,
    agyPid: null,
    agyPgid: null,
    model,
    modelSource,
    modelNote,
    fallbackModel,
    modelUsed: null,
    fallbackNote: null,
    attempts: [],
    effort,
    resume,
    tools: Boolean(tools),
    stream: Boolean(stream),
    schemaRequested: Boolean(schemaPath),
    schemaPath,
    addDirs,
    timeoutMs,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    fingerprint: fingerprintOf([kind, repoRoot ?? cwd, prompt, model, effort, resume]),
    conversationId: null,
    exitCode: null,
    signal: null,
    reason: null,
    hint: null,
    warnings: [],
    usage: null,
  };

  writeJsonAtomic(paths.record, record);
  writeIndexEntry(id, repoKey);
  return record;
}

export function loadJob(jobId) {
  const repoKey = readIndexEntry(jobId);
  if (!repoKey) return null;
  return readJson(jobPaths(repoKey, jobId).record);
}

export function saveJob(record) {
  writeJsonAtomic(jobPaths(record.repoKey, record.id).record, record);
  return record;
}

export function patchJob(jobId, patch) {
  const current = loadJob(jobId);
  if (!current) return null;
  return saveJob({ ...current, ...patch });
}

/**
 * Look for an already-running job with the same fingerprint.
 *
 * The codex plugin's forwarder subagent retries on failure and each retry
 * launches a fresh task; one dispatch produced three concurrent jobs burning
 * tokens in parallel. An atomic claim makes that structurally impossible.
 */
export function findDuplicate(repoKey, fingerprint, windowMs = DEFAULT_DEDUP_WINDOW_MS) {
  const now = Date.now();
  for (const jobId of listJobIds(repoKey)) {
    const record = readJson(jobPaths(repoKey, jobId).record);
    if (!record || record.fingerprint !== fingerprint) continue;
    if (isTerminal(record.status)) continue;
    const age = now - Date.parse(record.createdAt);
    if (Number.isFinite(age) && age <= windowMs && isAlive(record.monitorPid)) {
      return record;
    }
  }
  return null;
}

export function claimJob(record) {
  return claimFingerprint(record.repoKey, record.fingerprint, {
    jobId: record.id,
    createdAt: record.createdAt,
    monitorPid: record.monitorPid,
  });
}

/** Spawn the detached monitor that will own this job for its lifetime. */
export function spawnMonitor(record) {
  const child = spawn(process.execPath, [COMPANION, '__monitor', record.repoKey, record.id], {
    detached: true,
    stdio: 'ignore',
    cwd: record.cwd,
    env: process.env,
  });
  child.unref();
  return patchJob(record.id, { monitorPid: child.pid, status: 'running', startedAt: new Date().toISOString() });
}

/**
 * Run agy to completion and finalize the record. Executed by the monitor
 * process (background) or inline (foreground).
 */
export async function executeJob(repoKey, jobId) {
  const paths = jobPaths(repoKey, jobId);
  let record = readJson(paths.record);
  if (!record) throw new Error(`no record for job ${jobId}`);

  const binary = resolveAgyBinary();
  if (!binary) {
    return finalize(record, {
      status: STATUS.FAILED,
      reason: 'agy binary not found on PATH',
      hint: 'install the Antigravity CLI, or set AGY_BIN',
    });
  }

  const prompt = fs.readFileSync(paths.prompt, 'utf8');
  // One deadline for the whole job, shared by a fallback attempt.
  const deadlineAt = Date.now() + record.timeoutMs;
  const attempts = [];
  let fallbackNote = null;
  let model = record.model;
  let attempt;
  let outcome;

  for (let index = 0; index < 2; index += 1) {
    attempt = await runAttempt(record, paths, binary, prompt, model, deadlineAt);
    record = attempt.record;
    outcome = classifyOutcome({
      cancelled: attempt.cancelled,
      timedOut: attempt.timedOut,
      exitCode: attempt.code,
      signal: attempt.signal,
      stdout: attempt.stdout,
      stderr: attempt.stderr,
      schemaRequested: record.schemaRequested,
    });
    attempts.push({ model: model ?? 'agy-default', status: outcome.status, reason: outcome.reason });

    // Fall back once, and only from a model the plugin chose itself (Carbon 4)
    // that agy refused: never from a model the user asked for, and not when
    // agy's own default is that same model.
    const refusal = outcome.status === STATUS.FAILED ? detectModelRefusal(attempt.stderr) : null;
    const canFallBack =
      index === 0 &&
      refusal &&
      record.modelSource === 'carbon' &&
      model &&
      record.fallbackModel !== model &&
      !attempt.cancelled &&
      !attempt.timedOut &&
      Date.now() < deadlineAt;
    if (!canFallBack) break;
    fallbackNote = `${model} was refused (${refusal.message}); retried on agy's default model.`;
    model = null;
  }

  return finalize(readJson(paths.record) ?? record, {
    status: outcome.status,
    reason: outcome.reason,
    hint: outcome.hint,
    warnings: outcome.warnings,
    exitCode: attempt.code,
    signal: attempt.signal ?? null,
    conversationId: outcome.result?.conversation_id ?? null,
    usage: outcome.result?.usage ?? null,
    durationSeconds: outcome.result?.duration_seconds ?? null,
    attempts,
    modelUsed: model ?? 'agy-default',
    fallbackNote,
  });
}

/**
 * Run agy once with the given model. Output is appended to the job's logs; the
 * returned stdout/stderr hold only this attempt's part, so a fallback attempt is
 * classified on its own output.
 */
async function runAttempt(record, paths, binary, prompt, model, deadlineAt) {
  const args = buildAgyArgs({
    prompt,
    tools: record.tools,
    stream: record.stream,
    model,
    effort: record.effort,
    resume: record.resume,
    schemaPath: record.schemaPath,
    addDirs: record.addDirs,
    timeoutMs: Math.max(1000, deadlineAt - Date.now()),
  });

  const stdoutStart = sizeOf(paths.stdout);
  const stderrStart = sizeOf(paths.stderr);
  const stdoutFd = fs.openSync(paths.stdout, 'a', 0o600);
  const stderrFd = fs.openSync(paths.stderr, 'a', 0o600);

  const child = spawn(binary, args, {
    cwd: record.cwd,
    // Own process group so the whole tree can be signalled together. The
    // monitor deliberately stays OUTSIDE this group so it survives to record
    // the outcome after killing the child.
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: process.env,
  });

  record = saveJob({
    ...record,
    status: 'running',
    startedAt: record.startedAt ?? new Date().toISOString(),
    agyPid: child.pid,
    agyPgid: child.pid,
    argv: args.map((arg) => (arg === prompt ? `<prompt:${record.promptBytes}b>` : arg)),
  });

  let timedOut = false;
  let cancelled = false;

  const deadline = setTimeout(() => {
    timedOut = true;
    void terminateTree(child.pid);
  }, Math.max(0, deadlineAt - Date.now()));
  deadline.unref?.();

  // The cancel path writes a request file; poll for it so a cancel issued while
  // the monitor is mid-run is honored even if the signal is missed.
  const cancelPoll = setInterval(() => {
    if (fs.existsSync(paths.cancel)) {
      cancelled = true;
      clearInterval(cancelPoll);
      void terminateTree(child.pid);
    }
  }, 1000);
  cancelPoll.unref?.();

  const onTerm = () => {
    cancelled = true;
    void terminateTree(child.pid);
  };
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onTerm);

  const { code, signal } = await new Promise((resolve) => {
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
    child.on('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
  });

  clearTimeout(deadline);
  clearInterval(cancelPoll);
  process.off('SIGTERM', onTerm);
  process.off('SIGINT', onTerm);
  try {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  } catch {
    /* already closed */
  }

  if (fs.existsSync(paths.cancel)) cancelled = true;

  return {
    record,
    code,
    signal,
    timedOut,
    cancelled,
    stdout: readFrom(paths.stdout, stdoutStart),
    stderr: readFrom(paths.stderr, stderrStart),
  };
}

function sizeOf(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readFrom(filePath, offset) {
  const text = readFileSafe(filePath);
  return Buffer.from(text, 'utf8').subarray(offset).toString('utf8');
}

function finalize(record, patch) {
  const finalRecord = {
    ...record,
    ...patch,
    finishedAt: new Date().toISOString(),
  };
  saveJob(finalRecord);
  // Cleanup is part of finalization rather than a later polling pass, so an
  // abandoned claim cannot block future jobs indefinitely.
  releaseFingerprint(finalRecord.repoKey, finalRecord.fingerprint);
  try {
    fs.rmSync(jobPaths(finalRecord.repoKey, finalRecord.id).cancel, { force: true });
  } catch {
    /* best effort */
  }
  return finalRecord;
}

async function terminateTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (!signalGroup(pid, 'SIGTERM')) signalPid(pid, 'SIGTERM');
  await delay(5000);
  if (isAlive(pid)) {
    if (!signalGroup(pid, 'SIGKILL')) signalPid(pid, 'SIGKILL');
  }
}

/**
 * Request cancellation. Writes the request first so it is durable, then nudges
 * the monitor. Identity is verified before signalling so a stale PID cannot
 * take down an unrelated process.
 */
export function requestCancel(jobId) {
  const record = loadJob(jobId);
  if (!record) return { ok: false, reason: `no job found with id ${jobId}` };
  if (isTerminal(record.status)) {
    return { ok: false, reason: `job is already ${record.status}` };
  }

  const paths = jobPaths(record.repoKey, record.id);
  writeFileSecure(paths.cancel, `${new Date().toISOString()}\n`);

  if (record.monitorPid && identityMatches(record.monitorPid, MONITOR_MARKER)) {
    signalPid(record.monitorPid, 'SIGTERM');
    return { ok: true, reason: 'cancellation signalled to the job monitor' };
  }

  // Monitor is gone. Take the child down directly if it is still identifiable,
  // then finalize the record ourselves so it cannot linger as "running".
  if (record.agyPgid && isAlive(record.agyPgid)) {
    signalGroup(record.agyPgid, 'SIGTERM');
  }
  saveJob({
    ...record,
    status: STATUS.CANCELLED,
    reason: 'cancelled after its monitor had exited',
    finishedAt: new Date().toISOString(),
  });
  releaseFingerprint(record.repoKey, record.fingerprint);
  return { ok: true, reason: 'job had no live monitor; record finalized as cancelled' };
}

/**
 * Reconcile a record whose monitor died without finalizing it (machine reboot,
 * SIGKILL to the monitor). Classifies from whatever the logs captured.
 */
export function reconcile(record) {
  if (isTerminal(record.status)) return record;
  if (record.monitorPid && isAlive(record.monitorPid)) return record;
  if (record.status === 'starting' && !record.monitorPid) return record;

  const paths = jobPaths(record.repoKey, record.id);
  const outcome = classifyOutcome({
    cancelled: fs.existsSync(paths.cancel),
    stdout: readFileSafe(paths.stdout),
    stderr: readFileSafe(paths.stderr),
    schemaRequested: record.schemaRequested,
  });

  const status = outcome.status === STATUS.SUCCEEDED ? STATUS.SUCCEEDED : outcome.status;
  const finalRecord = {
    ...record,
    status,
    reason:
      outcome.status === STATUS.SUCCEEDED
        ? outcome.reason
        : `${outcome.reason} (monitor exited without finalizing)`,
    hint: outcome.hint,
    warnings: outcome.warnings,
    conversationId: outcome.result?.conversation_id ?? record.conversationId,
    usage: outcome.result?.usage ?? record.usage,
    finishedAt: new Date().toISOString(),
  };
  saveJob(finalRecord);
  releaseFingerprint(finalRecord.repoKey, finalRecord.fingerprint);
  return finalRecord;
}

/** Milliseconds since the job last wrote output, or null if it never has. */
export function quietMs(record, now = Date.now()) {
  const paths = jobPaths(record.repoKey, record.id);
  let newest = 0;
  for (const file of [paths.stdout, paths.stderr]) {
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
    } catch {
      /* not written yet */
    }
  }
  if (newest === 0) return null;
  return Math.max(0, now - newest);
}

/**
 * A job is only *reported* as quiet — never auto-finalized. Long silent
 * stretches are normal: a document review can legitimately think for minutes
 * without writing a byte, so a short threshold produces false stalls.
 */
export function isQuiet(record, stallMs = DEFAULT_STALL_MS, now = Date.now()) {
  if (isTerminal(record.status)) return false;
  const quiet = quietMs(record, now);
  return quiet !== null && quiet >= stallMs;
}

export function listJobs({ repoKey, all = false } = {}) {
  const keys = all ? listRepoKeys() : [repoKey].filter(Boolean);
  const records = [];
  for (const key of keys) {
    for (const jobId of listJobIds(key)) {
      const record = readJson(jobPaths(key, jobId).record);
      if (record) records.push(reconcile(record));
    }
  }
  return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function jobResult(record) {
  const paths = jobPaths(record.repoKey, record.id);
  const stdout = readFileSafe(paths.stdout);
  const { result } = classifyOutcome({ stdout, stderr: readFileSafe(paths.stderr) });
  return {
    record,
    result,
    response: result?.response ?? null,
    structured: result?.structured_output ?? null,
    stderr: readFileSafe(paths.stderr),
  };
}

export function pruneJobs({ repoKey, olderThanMs, all = false }) {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const record of listJobs({ repoKey, all })) {
    if (!isTerminal(record.status)) continue;
    const finished = Date.parse(record.finishedAt ?? record.createdAt);
    if (Number.isFinite(finished) && finished < cutoff) {
      fs.rmSync(jobPaths(record.repoKey, record.id).dir, { recursive: true, force: true });
      removeIndexEntry(record.id);
      removed++;
    }
  }
  return removed;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}
