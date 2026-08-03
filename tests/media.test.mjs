import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';

import { formatBytes, kindOf, validateMediaPaths } from '../plugins/agy/scripts/lib/media.mjs';
import { UsageError } from '../plugins/agy/scripts/lib/args.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let dir;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-media-'));
});

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (name, contents) => {
  const target = path.join(dir, name);
  fs.writeFileSync(target, contents);
  return target;
};

describe('kindOf', () => {
  test('classifies each supported family', () => {
    assert.equal(kindOf('.png'), 'image');
    assert.equal(kindOf('.mp4'), 'video');
    assert.equal(kindOf('.mp3'), 'audio');
    assert.equal(kindOf('.pdf'), 'document');
    assert.equal(kindOf('.txt'), null);
  });
});

describe('validateMediaPaths', () => {
  test('accepts a real png and reports its kind and size', () => {
    const file = write('good.png', PNG_HEADER);
    const [result] = validateMediaPaths([file]);
    assert.equal(result.kind, 'image');
    assert.equal(result.bytes, PNG_HEADER.length);
  });

  test('requires at least one path', () => {
    assert.throws(() => validateMediaPaths([]), UsageError);
  });

  test('reports a missing file clearly', () => {
    assert.throws(() => validateMediaPaths([path.join(dir, 'nope.png')]), /file not found/);
  });

  test('rejects a directory', () => {
    assert.throws(() => validateMediaPaths([dir]), /not a regular file/);
  });

  test('rejects an empty file', () => {
    assert.throws(() => validateMediaPaths([write('empty.png', '')]), /empty/);
  });

  test('rejects an unsupported extension and lists what is supported', () => {
    assert.throws(() => validateMediaPaths([write('notes.txt', 'hello')]), /unsupported file type/);
  });

  test('rejects a file whose contents contradict its extension', () => {
    // A .png that is not a PNG would otherwise waste a whole model run.
    assert.throws(() => validateMediaPaths([write('liar.png', 'this is plain text')]), /does not look like/);
  });

  test('resolves symlinks to their target', () => {
    const real = write('real.png', PNG_HEADER);
    const link = path.join(dir, 'link.png');
    fs.symlinkSync(real, link);
    const [result] = validateMediaPaths([link]);
    assert.equal(result.path, fs.realpathSync(real));
  });

  test('rejects a FIFO, which would otherwise hang a reader', () => {
    const fifo = path.join(dir, 'pipe.png');
    try {
      fs.mkfifoSync?.(fifo);
    } catch {
      return; // platform without mkfifo support
    }
    if (!fs.existsSync(fifo)) return;
    assert.throws(() => validateMediaPaths([fifo]), /not a regular file/);
  });

  test('validates every path, not just the first', () => {
    const good = write('ok.png', PNG_HEADER);
    assert.throws(() => validateMediaPaths([good, path.join(dir, 'missing.png')]), /file not found/);
  });
});

describe('formatBytes', () => {
  test('scales through the units', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  });
});
