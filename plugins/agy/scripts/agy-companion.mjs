#!/usr/bin/env node
/**
 * agy-companion — the single runtime entry point for the agy Claude Code plugin.
 *
 * Everything the slash commands do goes through here so that argument handling,
 * job bookkeeping, and outcome classification live in one tested place.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseDuration, parseFlags, UsageError, validateFlags } from './lib/args.mjs';
import { agyModels, agyVersion, resolveAgyBinary } from './lib/agy.mjs';
import { buildDiffPacket, resolveRepoRoot } from './lib/git.mjs';
import {
  claimJob,
  createJob,
  DEFAULT_TIMEOUT_MS,
  executeJob,
  findDuplicate,
  isTerminal,
  jobResult,
  listJobs,
  loadJob,
  patchJob,
  pruneJobs,
  reconcile,
  requestCancel,
  spawnMonitor,
} from './lib/jobs.mjs';
import { validateMediaPaths } from './lib/media.mjs';
import { STATUS } from './lib/outcome.mjs';
import { jobPaths, newJobId, repoKeyFor, writeFileSecure } from './lib/paths.mjs';
import { agyDefaultModelId, applyEffort, listModels, resolveReviewModel, resolveTaskModel } from './lib/models.mjs';
import {
  adversarialReviewPrompt,
  delegatePrompt,
  lookPrompt,
  researchPrompt,
  reviewPrompt,
  surveyPrompt,
} from './lib/prompts.mjs';
import { renderDoctor, renderResult, renderStatusTable } from './lib/render.mjs';

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REVIEW_SCHEMA = path.join(PLUGIN_ROOT, 'schemas', 'review-findings.schema.json');
const ADVERSARIAL_SCHEMA = path.join(PLUGIN_ROOT, 'schemas', 'adversarial-review.schema.json');

const USAGE = `agy-companion <command> [flags]

Commands:
  doctor                     Check that agy is installed, authenticated and reachable
  task <prompt>              Delegate a task to agy
  review [--base <ref>]      Review a change (no tool access by default)
  adversarial-review [focus] Challenge the change's approach and assumptions
  look <file...>             Analyze images, video, audio or PDFs
  research <question>        Web-grounded research with source labelling
  survey <question>          Long-context architecture pass over the repo
  status [--all] [--json]    List jobs
  result <job-id> [--json]   Show a job's output
  cancel <job-id|--all>      Cancel a running job
  prune [--older-than 7d]    Delete finished job records

Common flags:
  --background | --wait      Run detached, or block until done (default: wait)
  --model <id>  --effort <low|medium|high|xhigh|max>
  --resume last|<conversation-id>   Continue a previous agy conversation
  --add-dir <path>           Extra directory agy may access (repeatable)
  --timeout <30s|10m|1h>     Hard deadline enforced by the job monitor
  --label <text>             Human label shown in status output
  --prompt-stdin             Read the prompt from stdin instead of argv
  --force-new                Run even if an identical job is already in flight
  --dry-run                  Print the agy argv without running anything

Tool access:
  --read-only    (task)      Keep tool access, ask agy not to modify anything.
                             Advisory only — nothing enforces it.
  --no-tools     (task)      Remove tool access entirely. A real boundary, but
                             the prompt must be self-contained.
  --with-tools   (review)    Let review read beyond the packet. Drops review's
                             default no-tool guarantee.

review and adversarial-review flags:
  --base <ref>               Review <ref>...HEAD instead of the working tree
  --paths a.js,b.js          Narrow the packet
  --include-untracked        Inline untracked file contents
`;

async function main() {
  const [subcommand, ...rest] = process.argv.slice(2);

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }

  // Hidden: the per-job monitor re-enters here as a detached process.
  if (subcommand === '__monitor') {
    const [repoKey, jobId] = rest;
    await executeJob(repoKey, jobId);
    return 0;
  }

  const { flags, positionals } = parseFlags(rest);
  validateFlags(flags);

  if (flags.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (subcommand) {
    case 'doctor':
      return doctor();
    case 'task':
      return runKind('task', flags, positionals);
    case 'review':
      return runKind('review', flags, positionals);
    case 'adversarial-review':
      return runKind('adversarial-review', flags, positionals);
    case 'look':
      return runKind('look', flags, positionals);
    case 'research':
      return runKind('research', flags, positionals);
    case 'survey':
      return runKind('survey', flags, positionals);
    case 'status':
      return status(flags);
    case 'result':
      return showResult(flags, positionals);
    case 'cancel':
      return cancel(flags, positionals);
    case 'prune':
      return prune(flags);
    default:
      throw new UsageError(`unknown command "${subcommand}"`, 'run with --help for usage');
  }
}

function context() {
  const cwd = process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  return { cwd, repoRoot, repoKey: repoKeyFor(repoRoot ?? cwd) };
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function resolvePromptText(flags, positionals) {
  if (flags['prompt-stdin']) {
    const text = (await readStdin()).trim();
    if (text === '') throw new UsageError('--prompt-stdin was given but stdin was empty');
    return text;
  }
  const joined = positionals.join(' ').trim();
  if (joined === '') {
    throw new UsageError('a prompt is required', 'pass it as an argument or use --prompt-stdin');
  }
  return joined;
}

/**
 * Free text for review questions and adversarial focus: from stdin with
 * --prompt-stdin (the shell-safe path the commands document), else positionals.
 */
async function optionalText(flags, positionals) {
  if (flags['prompt-stdin']) return resolvePromptText(flags, []);
  return positionals.join(' ').trim();
}

/** The diff packet shared by review and adversarial-review. */
function reviewPacket(flags, ctx) {
  const paths = flags.paths ? flags.paths.split(',').map((p) => p.trim()).filter(Boolean) : [];
  const packetInfo = buildDiffPacket({
    cwd: ctx.repoRoot ?? ctx.cwd,
    base: flags.base,
    paths,
    includeUntracked: Boolean(flags['include-untracked']),
  });
  if (packetInfo.empty) {
    throw new UsageError(
      'no changes found to review',
      flags.base
        ? `nothing differs between ${flags.base} and HEAD`
        : 'the working tree is clean; pass --base <ref> to review committed work',
    );
  }
  // Never review a silently truncated diff: a review of part of a change reads
  // like a review of all of it.
  if (packetInfo.truncated) {
    throw new UsageError(
      'the change is too large to review in one packet (over 300 KB)',
      'narrow it with --paths a.js,b.js or review a smaller range with --base <ref>',
    );
  }
  return packetInfo;
}

/** Build the (prompt, tools, schema) triple for each command kind. */
async function buildRequest(kind, flags, positionals, ctx) {
  switch (kind) {
    case 'review': {
      const packetInfo = reviewPacket(flags, ctx);
      const question = await optionalText(flags, positionals);
      const questions = question ? [question] : [];
      const withTools = Boolean(flags['with-tools']);
      return {
        prompt: reviewPrompt({ packet: packetInfo.packet, questions, noTools: !withTools }),
        tools: withTools,
        schemaPath: REVIEW_SCHEMA,
        packet: packetInfo,
      };
    }

    case 'adversarial-review': {
      const packetInfo = reviewPacket(flags, ctx);
      const withTools = Boolean(flags['with-tools']);
      return {
        prompt: adversarialReviewPrompt({ packet: packetInfo.packet, focus: await optionalText(flags, positionals), noTools: !withTools }),
        tools: withTools,
        schemaPath: ADVERSARIAL_SCHEMA,
        packet: packetInfo,
      };
    }

    case 'look': {
      // Positionals are file paths; the question rides on --question so a
      // multi-word question can never be mistaken for a filename.
      const files = validateMediaPaths(positionals);
      const question = flags['prompt-stdin'] ? await resolvePromptText(flags, []) : flags.question ?? null;
      return {
        prompt: lookPrompt({
          files: files.map((file) => file.path),
          question,
          transcriptPath: path.join(ctx.cwd, 'agy-transcript.txt'),
        }),
        // Reading local media requires tool access; there is no read-only lever.
        tools: true,
        schemaPath: null,
        addDirs: [...new Set(files.map((file) => path.dirname(file.path)))],
      };
    }

    case 'research':
      return {
        prompt: researchPrompt({ question: await resolvePromptText(flags, positionals) }),
        tools: true,
        schemaPath: null,
      };

    case 'survey':
      return {
        prompt: surveyPrompt({
          question: await resolvePromptText(flags, positionals),
          repoRoot: ctx.repoRoot ?? ctx.cwd,
        }),
        tools: true,
        schemaPath: null,
      };

    case 'task':
    default:
      // --read-only and --no-tools are deliberately different things.
      // --read-only keeps tool access (an investigation has to read the repo)
      // and asks the model not to modify anything: advisory, not enforced.
      // --no-tools removes tool access entirely: a real boundary, but only
      // useful when the prompt already contains everything needed.
      return {
        prompt: delegatePrompt({
          task: await resolvePromptText(flags, positionals),
          readOnly: Boolean(flags['read-only']),
        }),
        tools: !flags['no-tools'],
        schemaPath: flags.schema ?? null,
      };
  }
}

const REVIEW_KINDS = new Set(['review', 'adversarial-review']);

/**
 * Choose the model and effort for a run. Reviews default to Carbon 4 high when
 * this account lists it; other commands keep agy's default unless asked.
 */
function selectModel(kind, flags) {
  if (REVIEW_KINDS.has(kind)) {
    const binary = resolveAgyBinary();
    const { models } = binary ? listModels(binary) : { models: [] };
    const choice = resolveReviewModel({ flag: flags.model, models });
    const applied = applyEffort({ model: choice.model, source: choice.source, effort: flags.effort, models });
    return { ...applied, source: choice.source, note: choice.note, fallbackModel: agyDefaultModelId(models) };
  }
  const choice = resolveTaskModel({ flag: flags.model });
  const applied = applyEffort({ model: choice.model, source: choice.source, effort: flags.effort });
  return { ...applied, source: choice.source, note: null, fallbackModel: null };
}

async function runKind(kind, flags, positionals) {
  const ctx = context();
  const request = await buildRequest(kind, flags, positionals, ctx);

  const background = Boolean(flags.background);
  const timeoutMs = flags.timeout ? parseDuration(flags.timeout) : DEFAULT_TIMEOUT_MS;
  const selection = selectModel(kind, flags);

  const spec = {
    repoRoot: ctx.repoRoot,
    cwd: ctx.cwd,
    kind,
    label: flags.label ?? null,
    prompt: request.prompt,
    tools: request.tools,
    // Background jobs stream so the log grows continuously and quiet periods
    // are visible; foreground waits for a single JSON payload.
    stream: background,
    model: selection.model,
    modelSource: selection.source,
    modelNote: selection.note,
    fallbackModel: selection.fallbackModel,
    effort: selection.effort,
    resume: flags.resume ?? null,
    schemaPath: request.schemaPath,
    addDirs: [...(flags['add-dir'] ?? []), ...(request.addDirs ?? [])],
    timeoutMs,
  };

  if (flags['dry-run']) {
    const { buildAgyArgs } = await import('./lib/agy.mjs');
    const args = buildAgyArgs({
      prompt: spec.prompt,
      tools: spec.tools,
      stream: spec.stream,
      model: spec.model,
      effort: spec.effort,
      resume: spec.resume,
      schemaPath: spec.schemaPath,
      addDirs: spec.addDirs,
      timeoutMs: spec.timeoutMs,
    });
    const shown = args.map((arg) =>
      arg === spec.prompt ? `<prompt: ${Buffer.byteLength(spec.prompt, 'utf8')} bytes>` : arg,
    );
    process.stdout.write(`${['agy', ...shown].join(' ')}\n`);
    process.stdout.write(`\nmodel: ${spec.model ?? 'agy default'} (${spec.modelSource})\n`);
    if (spec.modelNote) process.stdout.write(`${spec.modelNote}\n`);
    if (request.packet) {
      process.stdout.write(`\npacket sections: ${request.packet.sections.join(', ') || 'none'}\n`);
    }
    return 0;
  }

  let record = createJob(spec);

  if (!flags['force-new']) {
    const duplicate = findDuplicate(record.repoKey, record.fingerprint);
    if (duplicate) {
      // Drop the record we just created so it cannot masquerade as a real job.
      fs.rmSync(jobPaths(record.repoKey, record.id).dir, { recursive: true, force: true });
      process.stdout.write(
        `An identical ${kind} job is already running: ${duplicate.id}\n` +
          `Check it with \`result ${duplicate.id}\`, or pass --force-new to run another.\n`,
      );
      return 0;
    }
    const claim = claimJob(record);
    if (!claim.claimed) {
      fs.rmSync(jobPaths(record.repoKey, record.id).dir, { recursive: true, force: true });
      process.stdout.write(
        `An identical ${kind} job was claimed moments ago${claim.owner?.jobId ? `: ${claim.owner.jobId}` : ''}.\n` +
          `Pass --force-new to run another anyway.\n`,
      );
      return 0;
    }
  }

  if (request.packet) {
    writeFileSecure(jobPaths(record.repoKey, record.id).packet, request.packet.packet);
  }

  if (background) {
    record = spawnMonitor(record);
    process.stdout.write(
      `Started ${kind} job \`${record.id}\` in the background.\n` +
        `Check progress with \`status\`, fetch output with \`result ${record.id}\`.\n`,
    );
    return 0;
  }

  patchJob(record.id, { monitorPid: process.pid });
  const finished = await executeJob(record.repoKey, record.id);
  process.stdout.write(`${renderResult(jobResult(finished))}\n`);
  return isTerminal(finished.status) && finished.status !== STATUS.SUCCEEDED && finished.status !== STATUS.PARTIAL_DENIED
    ? 1
    : 0;
}

function status(flags) {
  const ctx = context();
  const records = listJobs({ repoKey: ctx.repoKey, all: Boolean(flags.all) });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }

  const header = flags.all
    ? 'agy jobs (all repositories)'
    : `agy jobs for ${ctx.repoRoot ?? ctx.cwd}`;
  process.stdout.write(`${header}\n\n${renderStatusTable(records)}\n`);
  return 0;
}

function showResult(flags, positionals) {
  const jobId = positionals[0];
  if (!jobId) throw new UsageError('a job id is required', 'run `status` to list job ids');

  const record = loadJob(jobId);
  if (!record) {
    throw new UsageError(
      `no job found with id ${jobId}`,
      'ids are indexed globally, so this means the record was pruned or never created',
    );
  }

  const settled = reconcile(record);
  if (!isTerminal(settled.status)) {
    process.stdout.write(`Job \`${settled.id}\` is still ${settled.status}. Check back with \`status\`.\n`);
    return 0;
  }

  const payload = jobResult(settled);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${renderResult(payload)}\n`);
  return 0;
}

function cancel(flags, positionals) {
  const ctx = context();

  if (flags.all) {
    const running = listJobs({ repoKey: ctx.repoKey }).filter((record) => !isTerminal(record.status));
    if (running.length === 0) {
      process.stdout.write('No running jobs to cancel.\n');
      return 0;
    }
    for (const record of running) {
      const outcome = requestCancel(record.id);
      process.stdout.write(`${record.id}: ${outcome.reason}\n`);
    }
    return 0;
  }

  const jobId = positionals[0];
  if (!jobId) throw new UsageError('a job id is required', 'or pass --all to cancel every running job');
  const outcome = requestCancel(jobId);
  process.stdout.write(`${outcome.reason}\n`);
  return outcome.ok ? 0 : 1;
}

function prune(flags) {
  const ctx = context();
  const olderThanMs = parseDuration(flags['older-than'] ?? '7d') ?? 7 * 24 * 3600_000;
  const removed = pruneJobs({ repoKey: ctx.repoKey, olderThanMs, all: Boolean(flags.all) });
  process.stdout.write(`Removed ${removed} finished job record(s).\n`);
  return 0;
}

function doctor() {
  const checks = [];
  const binary = resolveAgyBinary();

  checks.push({
    name: 'agy binary',
    ok: Boolean(binary),
    detail: binary ?? 'not found on PATH (install the Antigravity CLI, or set AGY_BIN)',
  });

  if (binary) {
    const version = agyVersion(binary);
    checks.push({
      name: 'agy version',
      ok: Boolean(version),
      detail: version ?? 'could not run `agy --version`',
    });

    const models = agyModels(binary);
    checks.push({
      name: 'models reachable',
      ok: models.length > 0,
      detail: models.length > 0 ? `${models.length} available (${models[0]}…)` : 'no models returned — check authentication',
    });

    const { models: listed } = listModels(binary);
    const review = resolveReviewModel({ models: listed });
    checks.push({
      name: 'review model',
      ok: true,
      detail:
        review.source === 'carbon'
          ? `${review.model} (Carbon 4, the default for reviews)`
          : review.model
            ? `${review.model} (from ${review.source === 'env' ? 'AGY_REVIEW_MODEL' : review.source})`
            : `agy's default — ${review.note}`,
    });
  }

  const ctx = context();
  checks.push({
    name: 'repository',
    // Informational: commands also work outside a repository (review needs one).
    ok: true,
    detail: ctx.repoRoot ? `${ctx.repoRoot} → ${ctx.repoKey}` : `not a git repository; jobs will key on ${ctx.cwd}`,
  });

  let stateOk = true;
  let stateDetail;
  try {
    const probe = jobPaths(ctx.repoKey, newJobId());
    writeFileSecure(probe.record, '{}');
    fs.rmSync(probe.dir, { recursive: true, force: true });
    stateDetail = 'writable';
  } catch (error) {
    stateOk = false;
    stateDetail = `not writable: ${error.message}`;
  }
  checks.push({ name: 'state directory', ok: stateOk, detail: stateDetail });

  const report = { ok: checks.every((check) => check.ok), checks };
  process.stdout.write(`${renderDoctor(report)}\n`);
  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`error: ${error.message}\n`);
      if (error.hint) process.stderr.write(`hint: ${error.hint}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`error: ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
