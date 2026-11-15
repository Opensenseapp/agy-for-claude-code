/**
 * Building blocks for invoking the agy CLI.
 *
 * `buildAgyArgs` is pure so the exact argv can be asserted in tests and shown
 * by `--dry-run` without spawning anything or spending tokens.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './args.mjs';
import { parseModelList } from './models.mjs';

/**
 * agy receives the prompt as a single argv entry. Review packets are inlined
 * (no-tools mode cannot read a file), so guard against ARG_MAX. macOS reports
 * 1 MiB; this leaves generous headroom for the rest of the command.
 */
export const MAX_PROMPT_BYTES = 400_000;

const CANDIDATE_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'agy'),
  '/usr/local/bin/agy',
  '/opt/homebrew/bin/agy',
];

/**
 * @param {object} options
 * @param {string} options.prompt
 * @param {boolean} [options.tools]   allow agy to use tools (implies --dangerously-skip-permissions)
 * @param {boolean} [options.stream]  use stream-json (background jobs) instead of json
 * @param {string} [options.model]
 * @param {string} [options.effort]
 * @param {string} [options.resume]   'last' or a conversation id
 * @param {string} [options.schemaPath]
 * @param {string[]} [options.addDirs]
 * @param {number} [options.timeoutMs] passed to agy as a secondary guard
 * @returns {string[]}
 */
export function buildAgyArgs(options) {
  const {
    prompt,
    tools = false,
    stream = false,
    model,
    effort,
    resume,
    schemaPath,
    addDirs = [],
    timeoutMs,
  } = options;

  assertPromptSize(prompt);

  const args = ['--output-format', stream ? 'stream-json' : 'json'];

  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);

  // Resume is never implicit. The codex plugin defaults to --resume-last, which
  // silently returns a previous session's findings as if they were fresh.
  if (resume === 'last') {
    args.push('--continue');
  } else if (resume) {
    args.push('--conversation', resume);
  }

  if (schemaPath) args.push('--json-schema', schemaPath);
  for (const dir of addDirs) args.push('--add-dir', dir);

  // Without this flag every tool — including read_file — is auto-denied in
  // headless mode. There is no finer-grained CLI lever: --mode plan does NOT
  // prevent writes (verified). Commands that must not touch the filesystem run
  // with tools disabled entirely, which is a real boundary rather than a
  // prompt-level request.
  if (tools) args.push('--dangerously-skip-permissions');

  if (timeoutMs) args.push('--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`);

  args.push('-p', prompt);
  return args;
}

export function assertPromptSize(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new UsageError('a prompt is required');
  }
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) {
    throw new UsageError(
      `prompt is ${bytes} bytes, over the ${MAX_PROMPT_BYTES} byte limit`,
      'narrow the diff with --paths or --base, or split the task',
    );
  }
  return bytes;
}

export function resolveAgyBinary() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;

  try {
    // `sh -c` rather than execFileSync's `shell` option: passing args alongside
    // shell:true concatenates them unescaped (Node DEP0190).
    const found = execFileSync('/bin/sh', ['-c', 'command -v agy'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (found) return found;
  } catch {
    /* fall through to well-known locations */
  }

  for (const candidate of CANDIDATE_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function agyVersion(binary) {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

/** Model ids agy lists right now (no cache). Used by the health check. */
export function agyModels(binary) {
  try {
    return parseModelList(execFileSync(binary, ['models'], { encoding: 'utf8', timeout: 20_000 })).map((m) => m.id);
  } catch {
    return [];
  }
}
