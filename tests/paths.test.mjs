import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

let stateDir;

before(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-paths-'));
  process.env.AGY_PLUGIN_STATE_DIR = stateDir;
});

after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  delete process.env.AGY_PLUGIN_STATE_DIR;
});

const paths = await import('../plugins/agy/scripts/lib/paths.mjs');

describe('repoKeyFor', () => {
  test('is stable for the same path', () => {
    assert.equal(paths.repoKeyFor('/tmp'), paths.repoKeyFor('/tmp'));
  });

  test('differs for different paths', () => {
    assert.notEqual(paths.repoKeyFor('/tmp'), paths.repoKeyFor(os.homedir()));
  });

  test('keeps the basename readable and appends a long digest', () => {
    const key = paths.repoKeyFor('/tmp');
    // 16 hex digits: short keys collide far too readily across many repos.
    assert.match(key, /-[0-9a-f]{16}$/);
  });

  test('sanitises characters that are unsafe in a directory name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weird name#'));
    try {
      const key = paths.repoKeyFor(dir);
      assert.ok(!key.includes('#'), `unexpected # in ${key}`);
      assert.ok(!key.includes(' '), `unexpected space in ${key}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('index entries', () => {
  test('round-trip a job id to its repo key from any directory', () => {
    // This is what lets `result <id>` work when run from a different cwd than
    // the one the job was launched in.
    paths.writeIndexEntry('job_abc', 'repo-1234567890abcdef');
    assert.equal(paths.readIndexEntry('job_abc'), 'repo-1234567890abcdef');
  });

  test('returns null for an unknown job', () => {
    assert.equal(paths.readIndexEntry('job_missing'), null);
  });

  test('removal is idempotent', () => {
    paths.writeIndexEntry('job_gone', 'repo-x');
    paths.removeIndexEntry('job_gone');
    assert.doesNotThrow(() => paths.removeIndexEntry('job_gone'));
    assert.equal(paths.readIndexEntry('job_gone'), null);
  });
});

describe('claimFingerprint', () => {
  test('first caller wins and the second is told who owns it', () => {
    const first = paths.claimFingerprint('repo-a', 'fp1', { jobId: 'job_1' });
    const second = paths.claimFingerprint('repo-a', 'fp1', { jobId: 'job_2' });

    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.owner.jobId, 'job_1');
  });

  test('releasing lets a later job claim the same fingerprint', () => {
    paths.claimFingerprint('repo-b', 'fp2', { jobId: 'job_1' });
    paths.releaseFingerprint('repo-b', 'fp2');
    assert.equal(paths.claimFingerprint('repo-b', 'fp2', { jobId: 'job_3' }).claimed, true);
  });

  test('different fingerprints do not block each other', () => {
    assert.equal(paths.claimFingerprint('repo-c', 'fpA', {}).claimed, true);
    assert.equal(paths.claimFingerprint('repo-c', 'fpB', {}).claimed, true);
  });
});

describe('file permissions', () => {
  test('written files are owner-only', () => {
    // Prompts, diffs and model responses all live here.
    const target = path.join(stateDir, 'perm-probe', 'file.txt');
    paths.writeFileSecure(target, 'secret');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  });

  test('created directories are owner-only', () => {
    const dir = paths.ensureDir(path.join(stateDir, 'perm-dir'));
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });
});

describe('writeJsonAtomic', () => {
  test('round-trips and leaves no temp files behind', () => {
    const target = path.join(stateDir, 'atomic', 'record.json');
    paths.writeJsonAtomic(target, { a: 1 });
    assert.deepEqual(paths.readJson(target), { a: 1 });
    const leftovers = fs.readdirSync(path.dirname(target)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  test('readJson returns null for missing or corrupt files', () => {
    assert.equal(paths.readJson(path.join(stateDir, 'nope.json')), null);
    const bad = path.join(stateDir, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.equal(paths.readJson(bad), null);
  });
});

describe('newJobId', () => {
  test('is sortable by time and collision-resistant', () => {
    const id = paths.newJobId(new Date('2026-08-02T16:51:31Z'));
    assert.match(id, /^job_20260802T165131Z_[0-9a-f]{12}$/);
  });

  test('two ids generated together differ', () => {
    assert.notEqual(paths.newJobId(), paths.newJobId());
  });
});
