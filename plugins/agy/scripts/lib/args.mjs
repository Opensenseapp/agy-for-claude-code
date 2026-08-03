/**
 * Minimal dependency-free argv parser for agy-companion.
 *
 * Supports `--flag`, `--key value`, `--key=value`, repeatable keys, and a `--`
 * terminator after which everything is positional.
 */

export const EFFORTS = ['low', 'medium', 'high'];
export const KINDS = ['task', 'review', 'look', 'research', 'survey'];

export class UsageError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'UsageError';
    this.hint = hint;
  }
}

const BOOLEANS = new Set([
  'background',
  'wait',
  'dry-run',
  'force-new',
  'json',
  'all',
  'with-tools',
  'prompt-stdin',
  'include-untracked',
  'read-only',
  'no-tools',
  'with-tools',
  'help',
]);

const ARRAYS = new Set(['add-dir']);

const STRINGS = new Set([
  'model',
  'effort',
  'resume',
  'schema',
  'timeout',
  'label',
  'kind',
  'base',
  'paths',
  'question',
  'older-than',
]);

/**
 * @param {string[]} argv raw arguments (already excluding node + script)
 * @returns {{flags: Record<string, any>, positionals: string[]}}
 */
export function parseFlags(argv) {
  const flags = Object.create(null);
  const positionals = [];
  let terminated = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (terminated) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      terminated = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);

    if (BOOLEANS.has(key)) {
      if (inlineValue !== undefined && !['true', 'false'].includes(inlineValue)) {
        throw new UsageError(`--${key} is a boolean flag and takes no value`);
      }
      flags[key] = inlineValue !== 'false';
      continue;
    }

    if (ARRAYS.has(key) || STRINGS.has(key)) {
      let value = inlineValue;
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) {
          throw new UsageError(`--${key} requires a value`);
        }
      }
      if (ARRAYS.has(key)) {
        (flags[key] ??= []).push(value);
      } else {
        flags[key] = value;
      }
      continue;
    }

    throw new UsageError(`unknown flag --${key}`, 'run with --help to see supported flags');
  }

  return { flags, positionals };
}

/** Validate cross-cutting flag combinations. Throws UsageError on bad input. */
export function validateFlags(flags) {
  if (flags.effort !== undefined && !EFFORTS.includes(flags.effort)) {
    throw new UsageError(
      `--effort must be one of ${EFFORTS.join('|')} (got "${flags.effort}")`,
      'agy only supports three reasoning levels, unlike codex',
    );
  }

  if (flags.kind !== undefined && !KINDS.includes(flags.kind)) {
    throw new UsageError(`--kind must be one of ${KINDS.join('|')} (got "${flags.kind}")`);
  }

  if (flags.background && flags.wait) {
    throw new UsageError('--background and --wait are mutually exclusive');
  }

  if (flags.resume !== undefined && flags.resume !== 'last' && !isUuidish(flags.resume)) {
    throw new UsageError(
      `--resume takes "last" or a conversation id (got "${flags.resume}")`,
    );
  }

  if (flags.timeout !== undefined && parseDuration(flags.timeout) === null) {
    throw new UsageError(
      `--timeout must look like 30s, 10m, or 1h (got "${flags.timeout}")`,
    );
  }

  return flags;
}

export function isUuidish(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Parse a duration like "45s", "10m", "2h", or a bare number of seconds.
 * @returns {number|null} milliseconds, or null when unparseable
 */
export function parseDuration(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input * 1000;
  if (typeof input !== 'string') return null;

  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(input.trim());
  if (!match) return null;

  const value = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return value;
    case 'd':
      return value * 86_400_000;
    case 'h':
      return value * 3600_000;
    case 'm':
      return value * 60_000;
    case 's':
    case undefined:
      return value * 1000;
    default:
      return null;
  }
}
