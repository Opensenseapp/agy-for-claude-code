/**
 * Media path validation for /agy:look.
 *
 * Fails fast and locally. An existence-plus-extension check is not enough: a
 * FIFO will hang a reader forever, a symlink can point outside the intended
 * scope, and a multi-gigabyte file will waste a long run before failing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './args.mjs';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic', '.tiff']);
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
export const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
export const DOCUMENT_EXTENSIONS = new Set(['.pdf']);

export const MAX_MEDIA_BYTES = Number(process.env.AGY_MAX_MEDIA_BYTES ?? 512 * 1024 * 1024);

/** Leading bytes for the formats where a cheap check is worthwhile. */
const MAGIC = [
  { ext: '.png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: '.jpg', bytes: [0xff, 0xd8, 0xff] },
  { ext: '.gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: '.pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
];

export function kindOf(extension) {
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document';
  return null;
}

export function supportedExtensions() {
  return [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...DOCUMENT_EXTENSIONS].sort();
}

/**
 * @param {string[]} inputs user-supplied paths
 * @returns {{path: string, kind: string, bytes: number}[]}
 */
export function validateMediaPaths(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new UsageError('at least one file path is required');
  }

  return inputs.map((input) => {
    let resolved;
    try {
      // realpath collapses symlinks so the scope and type checks apply to the
      // actual target rather than the link.
      resolved = fs.realpathSync(path.resolve(input));
    } catch {
      throw new UsageError(`file not found: ${input}`);
    }

    const stats = fs.statSync(resolved);
    if (!stats.isFile()) {
      throw new UsageError(
        `not a regular file: ${input}`,
        'directories, FIFOs, sockets and devices are not supported',
      );
    }
    if (stats.size === 0) {
      throw new UsageError(`file is empty: ${input}`);
    }
    if (stats.size > MAX_MEDIA_BYTES) {
      throw new UsageError(
        `file is ${formatBytes(stats.size)}, over the ${formatBytes(MAX_MEDIA_BYTES)} limit: ${input}`,
        'set AGY_MAX_MEDIA_BYTES to raise it',
      );
    }

    const extension = path.extname(resolved).toLowerCase();
    const kind = kindOf(extension);
    if (!kind) {
      throw new UsageError(
        `unsupported file type "${extension || 'none'}": ${input}`,
        `supported: ${supportedExtensions().join(' ')}`,
      );
    }

    assertMagicMatches(resolved, extension);
    return { path: resolved, kind, bytes: stats.size };
  });
}

function assertMagicMatches(filePath, extension) {
  const expected = MAGIC.find((entry) =>
    entry.ext === extension || (entry.ext === '.jpg' && extension === '.jpeg'),
  );
  if (!expected) return;

  let head;
  const fd = fs.openSync(filePath, 'r');
  try {
    head = Buffer.alloc(expected.bytes.length);
    fs.readSync(fd, head, 0, expected.bytes.length, 0);
  } finally {
    fs.closeSync(fd);
  }

  const matches = expected.bytes.every((byte, index) => head[index] === byte);
  if (!matches) {
    throw new UsageError(
      `${path.basename(filePath)} does not look like a real ${extension} file`,
      'the extension and the file contents disagree',
    );
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
