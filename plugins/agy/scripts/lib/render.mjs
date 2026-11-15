/**
 * Human-facing rendering. Output is markdown because it is returned verbatim
 * into a Claude Code conversation.
 */

import { OK_STATUSES, STATUS } from './outcome.mjs';
import { isQuiet, quietMs } from './jobs.mjs';

const STATUS_LABEL = {
  [STATUS.SUCCEEDED]: 'succeeded',
  [STATUS.FAILED]: 'failed',
  [STATUS.DENIED]: 'denied (no tool access)',
  [STATUS.PARTIAL_DENIED]: 'partial (tool denied)',
  [STATUS.SCHEMA_VIOLATION]: 'schema violation',
  [STATUS.EMPTY]: 'empty response',
  [STATUS.CANCELLED]: 'cancelled',
  [STATUS.TIMEOUT]: 'timed out',
  starting: 'starting',
  running: 'running',
};

export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function statusLabel(record, now = Date.now()) {
  const base = STATUS_LABEL[record.status] ?? record.status;
  if (record.status === 'running' && isQuiet(record, undefined, now)) {
    return `${base} (quiet ${humanDuration(quietMs(record, now))})`;
  }
  return base;
}

export function renderStatusTable(records, { now = Date.now() } = {}) {
  if (records.length === 0) {
    return 'No agy jobs recorded for this repository yet.';
  }

  const rows = records.map((record) => {
    const started = Date.parse(record.startedAt ?? record.createdAt);
    const ended = record.finishedAt ? Date.parse(record.finishedAt) : now;
    const elapsed = Number.isFinite(started) ? humanDuration(ended - started) : '-';
    return [
      record.id,
      record.kind,
      statusLabel(record, now),
      elapsed,
      record.label ?? '-',
    ];
  });

  const header = ['Job', 'Kind', 'Status', 'Elapsed', 'Label'];
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...rows.map((row) => String(row[column]).length)),
  );

  const line = (cells) =>
    `| ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join(' | ')} |`;

  return [
    line(header),
    `|${widths.map((width) => '-'.repeat(width + 2)).join('|')}|`,
    ...rows.map(line),
  ].join('\n');
}

export function renderUsage(usage) {
  if (!usage) return null;
  const parts = [];
  if (usage.input_tokens != null) parts.push(`in ${usage.input_tokens.toLocaleString()}`);
  if (usage.output_tokens != null) parts.push(`out ${usage.output_tokens.toLocaleString()}`);
  if (usage.thinking_tokens) parts.push(`thinking ${usage.thinking_tokens.toLocaleString()}`);
  if (usage.cache_read_tokens) parts.push(`cached ${usage.cache_read_tokens.toLocaleString()}`);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * The adversarial verdict, failing closed: "approve" only for a run that fully
 * succeeded and returned that verdict. A failed, denied, partial, empty or
 * malformed run never reads as approval.
 */
export function verdictLine(record, structured) {
  if (record.status !== STATUS.SUCCEEDED) {
    return `**Verdict: not available** — the review did not complete (${record.status}). Treat the change as unreviewed.`;
  }
  if (structured?.verdict === 'approve') return '**Verdict: approve**';
  if (structured?.verdict === 'needs-attention') return '**Verdict: needs attention**';
  return '**Verdict: not available** — no verdict was returned. Treat the change as unreviewed.';
}

/** "Model: …" for a finished run, naming Carbon 4 or agy's default. */
export function modelLine(record) {
  const used = record.modelUsed;
  if (!used) return null;
  if (used === 'agy-default') return "Model: agy's default model";
  if (record.modelSource === 'carbon' && !record.fallbackNote) return `Model: ${used} (Carbon 4, the default for reviews)`;
  return `Model: ${used}`;
}

export function renderResult({ record, response, structured, stderr }) {
  const lines = [];
  const ok = OK_STATUSES.has(record.status);

  lines.push(`**agy ${record.kind}** — ${statusLabel(record)}  \`${record.id}\``);

  const modelText = modelLine(record);
  if (modelText) lines.push(modelText);
  if (record.fallbackNote) lines.push(`> ${record.fallbackNote}`);
  else if (record.modelNote) lines.push(`> ${record.modelNote}`);

  const meta = [];
  if (!modelText && record.model) meta.push(`model ${record.model}`);
  if (record.effort) meta.push(`effort ${record.effort}`);
  if (record.durationSeconds) meta.push(`${record.durationSeconds.toFixed(1)}s`);
  const usage = renderUsage(record.usage);
  if (usage) meta.push(usage);
  if (meta.length > 0) lines.push(`_${meta.join(' · ')}_`);

  if (!ok) {
    lines.push('', `> ${record.reason ?? 'no reason recorded'}`);
    if (record.hint) lines.push(`> ${record.hint}`);
  }

  for (const warning of record.warnings ?? []) {
    lines.push(`> warning: ${warning}`);
  }

  if (record.kind === 'adversarial-review') {
    lines.push('', verdictLine(record, structured));
  }

  if (structured != null) {
    lines.push('', '```json', JSON.stringify(structured, null, 2), '```');
  } else if (response) {
    lines.push('', response.trim());
  } else if (ok) {
    lines.push('', '_(no response text)_');
  }

  // Surface stderr only when it explains a failure — it is noisy otherwise.
  if (!ok && stderr && stderr.trim()) {
    const tail = stderr.trim().split('\n').slice(-8).join('\n');
    lines.push('', '<details><summary>stderr</summary>', '', '```', tail, '```', '</details>');
  }

  if (record.conversationId) {
    lines.push('', `_Continue this thread: \`--resume ${record.conversationId}\`_`);
  }

  return lines.join('\n');
}

export function renderDoctor(report) {
  const mark = (ok) => (ok ? 'ok' : 'FAIL');
  const lines = ['# agy plugin health', ''];
  for (const check of report.checks) {
    lines.push(`- [${mark(check.ok)}] **${check.name}** — ${check.detail}`);
  }
  lines.push('');
  lines.push(report.ok ? 'All checks passed.' : 'Some checks failed. Fix the items above, then re-run `/agy:setup`.');
  return lines.join('\n');
}
