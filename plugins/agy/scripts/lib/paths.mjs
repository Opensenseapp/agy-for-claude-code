/**
 * State layout for agy jobs.
 *
 * Keyed on the git repository root rather than the current directory's
 * basename. The codex plugin keys on the launching directory, which is why
 * `result <id>` run from a repo root cannot see a job launched inside a
 * worktree. A per-job index file makes lookup work from anywhere.
 *
 * Permissions are tight by default: prompts, diffs, and model responses all
 * land here, so directories are 0700 and files 0600.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './args.mjs';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

let checkedRoot = null;

/**
 * The state root, checked once per process: a real directory owned by this user
 * and closed to others. A symlinked or foreign root is refused, because what is
 * stored there decides which paths the plugin deletes and which processes it signals.
 */
export function stateRoot() {
  const root = rawStateRoot();
  if (checkedRoot !== root) {
    ensurePrivateRoot(root);
    checkedRoot = root;
  }
  return root;
}

function ensurePrivateRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: DIR_MODE });
  const stats = fs.lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`refusing to use the agy plugin state directory ${root}: it is not a real directory`);
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`refusing to use the agy plugin state directory ${root}: it belongs to another user`);
  }
  if ((stats.mode & 0o077) !== 0) fs.chmodSync(root, DIR_MODE);
}

function rawStateRoot() {
  if (process.env.AGY_PLUGIN_STATE_DIR) {
    return path.resolve(process.env.AGY_PLUGIN_STATE_DIR);
  }
  // Deliberately not under CLAUDE_PLUGIN_ROOT: that is a versioned cache
  // directory and is discarded when the plugin updates.
  return path.join(os.homedir(), '.claude', 'plugins', 'data', 'agy-for-claude-code', 'state');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/**
 * Stable per-repository key. 16 hex digits of SHA-256 over the real path:
 * long enough that collisions are not a practical concern.
 */
export function repoKeyFor(repoRoot) {
  const resolved = safeRealpath(repoRoot);
  const digest = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  const base = path.basename(resolved).replace(/[^A-Za-z0-9._-]/g, '_') || 'repo';
  return `${base}-${digest}`;
}

function safeRealpath(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

const REPO_KEY = /^[A-Za-z0-9._-]+-[0-9a-f]{16}$/;
const JOB_ID = /^job_\d{8}T\d{6}Z_[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{32}$/;

/** Job ids, repo keys and fingerprints become path segments, so only plugin-made shapes pass. */
export function assertJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new UsageError(`not a valid job id: "${jobId}"`, 'job ids look like job_20261115T120000Z_0123456789ab');
  return jobId;
}

function assertRepoKey(repoKey) {
  if (typeof repoKey !== 'string' || !REPO_KEY.test(repoKey) || repoKey.startsWith('.')) {
    throw new UsageError(`not a valid repo key: "${repoKey}"`);
  }
  return repoKey;
}

function assertFingerprint(fingerprint) {
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) throw new Error(`not a valid fingerprint: "${fingerprint}"`);
  return fingerprint;
}

export function repoDir(repoKey) {
  return path.join(stateRoot(), 'repos', assertRepoKey(repoKey));
}

export function indexDir() {
  return path.join(stateRoot(), 'index');
}

export function claimsDir(repoKey) {
  return path.join(repoDir(repoKey), 'claims');
}

export function newJobId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `job_${stamp}_${randomBytes(6).toString('hex')}`;
}

export function jobPaths(repoKey, jobId) {
  const dir = path.join(repoDir(repoKey), 'jobs', assertJobId(jobId));
  return {
    dir,
    record: path.join(dir, 'record.json'),
    stdout: path.join(dir, 'stdout.ndjson'),
    // Kept separate from stdout: two pipes writing one file can interleave
    // mid-line and tear the terminal JSON result.
    stderr: path.join(dir, 'stderr.log'),
    prompt: path.join(dir, 'prompt.txt'),
    packet: path.join(dir, 'packet.md'),
    cancel: path.join(dir, 'cancel.request'),
  };
}

export function writeFileSecure(filePath, contents) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, contents, { mode: FILE_MODE });
}

/** Atomic replace: write to a sibling temp file, then rename. */
export function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
  fs.renameSync(tmp, filePath);
  return filePath;
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Per-job index entries instead of one shared index.json: concurrent
 * read-modify-write on a single JSON file loses updates.
 */
export function writeIndexEntry(jobId, repoKey) {
  const dir = ensureDir(indexDir());
  fs.writeFileSync(path.join(dir, assertJobId(jobId)), assertRepoKey(repoKey), { mode: FILE_MODE });
}

export function readIndexEntry(jobId) {
  // A lookup by a malformed id is simply "not found"; no path is built from it.
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return null;
  const file = path.join(indexDir(), jobId);
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function removeIndexEntry(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return;
  const file = path.join(indexDir(), jobId);
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function listRepoKeys() {
  try {
    return fs.readdirSync(path.join(stateRoot(), 'repos'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function listJobIds(repoKey) {
  try {
    return fs.readdirSync(path.join(repoDir(repoKey), 'jobs'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Claim a dedup slot atomically. mkdir is atomic on POSIX filesystems, so the
 * winner of a race is unambiguous and no lockfile protocol is needed.
 *
 * @returns {{claimed: boolean, owner: object|null, dir: string}}
 */
export function claimFingerprint(repoKey, fingerprint, ownerMeta) {
  const dir = path.join(claimsDir(repoKey), assertFingerprint(fingerprint));
  ensureDir(claimsDir(repoKey));
  try {
    fs.mkdirSync(dir, { mode: DIR_MODE });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { claimed: false, owner: readJson(path.join(dir, 'owner.json')), dir };
  }
  writeJsonAtomic(path.join(dir, 'owner.json'), ownerMeta);
  return { claimed: true, owner: ownerMeta, dir };
}

export function releaseFingerprint(repoKey, fingerprint) {
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return;
  const dir = path.join(claimsDir(repoKey), fingerprint);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function fingerprintOf(parts) {
  return createHash('sha256').update(parts.filter(Boolean).join('\0')).digest('hex').slice(0, 32);
}
