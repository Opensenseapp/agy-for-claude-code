/**
 * Git helpers: repository identity and review packet construction.
 *
 * A plain `git diff` shows only unstaged changes. Reviewing that alone silently
 * skips staged and untracked files, which is exactly where new code lives —
 * so the packet collects every layer explicitly and says what it collected.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './args.mjs';

const MAX_PACKET_BYTES = 300_000;
const MAX_UNTRACKED_FILE_BYTES = 40_000;

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function gitQuiet(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return '';
  }
}

export function resolveRepoRoot(cwd = process.cwd()) {
  try {
    return git(['rev-parse', '--show-toplevel'], cwd).trim() || null;
  } catch {
    return null;
  }
}

export function currentRef(cwd) {
  return gitQuiet(['rev-parse', '--short', 'HEAD'], cwd).trim() || null;
}

export function currentBranch(cwd) {
  return gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], cwd).trim() || null;
}

/**
 * Build a self-contained review packet.
 *
 * @param {object} options
 * @param {string} options.cwd
 * @param {string} [options.base] git ref to diff against; omit for working-tree review
 * @param {string[]} [options.paths] limit to these pathspecs
 * @param {boolean} [options.includeUntracked]
 * @returns {{packet: string, sections: string[], truncated: boolean, empty: boolean}}
 */
export function buildDiffPacket({ cwd, base, paths = [], includeUntracked = false }) {
  // A ref never starts with "-"; one that does would be read by git as an option
  // (e.g. --output=<file> makes git diff write a file).
  if (base != null && (typeof base !== 'string' || base.startsWith('-') || base.trim() === '')) {
    throw new UsageError(`--base must be a git ref (got "${base}")`, 'pass a branch, tag or commit, e.g. --base main');
  }
  const pathspec = paths.length > 0 ? ['--', ...paths] : [];
  const sections = [];
  const chunks = [];
  let truncated = false;

  const add = (title, body) => {
    if (!body || body.trim() === '') return;
    sections.push(title);
    chunks.push(`### ${title}\n\n\`\`\`diff\n${body.trimEnd()}\n\`\`\`\n`);
  };

  const stat = base
    ? gitQuiet(['diff', '--stat', '--end-of-options', `${base}...HEAD`, ...pathspec], cwd)
    : gitQuiet(['diff', '--stat', 'HEAD', ...pathspec], cwd);

  if (base) {
    add(`Committed changes (${base}...HEAD)`, gitQuiet(['diff', '--end-of-options', `${base}...HEAD`, ...pathspec], cwd));
  }

  add('Staged changes (git diff --cached)', gitQuiet(['diff', '--cached', ...pathspec], cwd));
  add('Unstaged changes (git diff)', gitQuiet(['diff', ...pathspec], cwd));

  const untrackedList = gitQuiet(['ls-files', '--others', '--exclude-standard', ...pathspec], cwd)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (untrackedList.length > 0) {
    if (includeUntracked) {
      const bodies = [];
      for (const relative of untrackedList) {
        const absolute = path.join(cwd, relative);
        try {
          // lstat: an untracked symlink can point outside the repository (at
          // ~/.ssh, say), and its target must never be inlined into the packet.
          const stats = fs.lstatSync(absolute);
          if (stats.isSymbolicLink()) {
            bodies.push(`--- ${relative} (symlink — not followed)`);
            continue;
          }
          if (!stats.isFile()) continue;
          if (stats.size > MAX_UNTRACKED_FILE_BYTES) {
            bodies.push(`--- ${relative} (${stats.size} bytes — omitted, too large)`);
            truncated = true;
            continue;
          }
          bodies.push(`--- ${relative}\n${fs.readFileSync(absolute, 'utf8')}`);
        } catch {
          bodies.push(`--- ${relative} (unreadable)`);
        }
      }
      if (bodies.length > 0) {
        sections.push('Untracked files (contents)');
        chunks.push(`### Untracked files (contents)\n\n\`\`\`\n${bodies.join('\n\n')}\n\`\`\`\n`);
      }
    } else {
      sections.push('Untracked files (names only)');
      chunks.push(
        `### Untracked files (names only — pass --include-untracked for contents)\n\n` +
          `${untrackedList.map((f) => `- ${f}`).join('\n')}\n`,
      );
    }
  }

  const header = [
    `# Review packet`,
    ``,
    `- Repository: ${cwd}`,
    `- Branch: ${currentBranch(cwd) ?? 'unknown'} @ ${currentRef(cwd) ?? 'unknown'}`,
    `- Base: ${base ?? 'working tree (no base ref)'}`,
    `- Sections collected: ${sections.length > 0 ? sections.join(', ') : 'none'}`,
    ``,
    stat.trim() ? `## Summary\n\n\`\`\`\n${stat.trim()}\n\`\`\`\n` : '',
  ].join('\n');

  let packet = `${header}\n${chunks.join('\n')}`;
  if (Buffer.byteLength(packet, 'utf8') > MAX_PACKET_BYTES) {
    packet = `${packet.slice(0, MAX_PACKET_BYTES)}\n\n[packet truncated at ${MAX_PACKET_BYTES} bytes — narrow with --paths or --base]\n`;
    truncated = true;
  }

  return { packet, sections, truncated, empty: chunks.length === 0 };
}
