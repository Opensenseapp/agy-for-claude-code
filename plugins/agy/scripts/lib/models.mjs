/**
 * Which model a run uses.
 *
 * Reviews default to Carbon 4 high when the account lists it, and otherwise to
 * agy's own default. A friend's plan may not include Carbon 4, and a review must
 * still work. Other commands keep agy's default unless a model is asked for.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { UsageError } from './args.mjs';
import { readJson, stateRoot, writeJsonAtomic } from './paths.mjs';

export const CARBON_REVIEW_MODEL = 'gemini-4-carbon-high';
export const MODEL_CACHE_MAX_AGE_MS = 6 * 3600 * 1000;

const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** Parse `agy models` output: `<id>\t<display name>` lines, skipping banners and noise. */
export function parseModelList(text) {
  const models = [];
  for (const line of String(text ?? '').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    const name = line.slice(tab + 1).trim();
    if (MODEL_ID.test(id) && name) models.push({ id, name });
  }
  return models;
}

/**
 * List the models this account can use. A non-empty listing is cached for six
 * hours; a failed or empty one is never cached, so a later run retries.
 * Never throws.
 */
export function listModels(
  binary,
  {
    cacheFile = path.join(stateRoot(), 'models-cache.json'),
    maxAgeMs = MODEL_CACHE_MAX_AGE_MS,
    now = Date.now(),
    run = (bin) => execFileSync(bin, ['models'], { encoding: 'utf8', timeout: 20_000 }),
  } = {},
) {
  const cached = readJson(cacheFile);
  if (
    cached &&
    Array.isArray(cached.models) &&
    cached.models.length > 0 &&
    Number.isFinite(cached.fetchedAt) &&
    now - cached.fetchedAt >= 0 &&
    now - cached.fetchedAt < maxAgeMs
  ) {
    return { models: cached.models, fromCache: true, error: null };
  }

  let text;
  try {
    text = run(binary);
  } catch (error) {
    return { models: [], fromCache: false, error: error?.message ?? String(error) };
  }
  const models = parseModelList(text);
  if (models.length === 0) {
    return { models: [], fromCache: false, error: 'agy listed no models (is it signed in?)' };
  }
  try {
    writeJsonAtomic(cacheFile, { fetchedAt: now, models });
  } catch {
    /* an unwritable cache only costs a re-fetch next time */
  }
  return { models, fromCache: false, error: null };
}

/** Map the display name in agy's settings (e.g. "Gemini 4 Carbon (High)") to a model id. */
export function agyDefaultModelId(
  models,
  { settingsFile = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json') } = {},
) {
  const settings = readJson(settingsFile);
  const name = typeof settings?.model === 'string' ? settings.model.trim() : '';
  if (!name) return null;
  const match = models.find((m) => m.name === name || m.id === name);
  return match ? match.id : null;
}

/** Review kinds: --model, then AGY_REVIEW_MODEL, then Carbon 4 high if listed, then agy's default. */
export function resolveReviewModel({ flag, env = process.env.AGY_REVIEW_MODEL, models = [] } = {}) {
  if (flag) return { model: flag, source: 'flag', note: null };
  if (env && env.trim()) return { model: env.trim(), source: 'env', note: null };
  if (models.some((m) => m.id === CARBON_REVIEW_MODEL)) {
    return { model: CARBON_REVIEW_MODEL, source: 'carbon', note: null };
  }
  const note =
    models.length > 0
      ? `Carbon 4 is not available on this account; using agy's default model.`
      : `Could not list agy's models; using agy's default model.`;
  return { model: null, source: 'agy-default', note };
}

/** Other kinds: --model, then AGY_MODEL, then agy's default. */
export function resolveTaskModel({ flag, env = process.env.AGY_MODEL } = {}) {
  if (flag) return { model: flag, source: 'flag' };
  if (env && env.trim()) return { model: env.trim(), source: 'env' };
  return { model: null, source: 'agy-default' };
}

const EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

/**
 * Reconcile --effort with a model id that already names an effort. agy rejects
 * `--model gemini-4-carbon-high --effort max` outright ("conflicts with
 * --effort"), and Carbon 4 picks its effort through the model variant.
 * - auto-chosen Carbon: switch to the gemini-4-carbon-<effort> variant if listed
 * - effort equal to the model's suffix: drop --effort as redundant
 * - anything else that conflicts: a usage error before agy runs
 */
export function applyEffort({ model, source, effort, models = [] }) {
  if (!effort || !model) return { model, effort: effort ?? null };
  const suffix = EFFORT_SUFFIX.exec(model);
  if (!suffix) return { model, effort };
  if (suffix[1] === effort) return { model, effort: null };

  const family = model.slice(0, suffix.index);
  if (source === 'carbon') {
    const variant = `${family}-${effort}`;
    if (models.some((m) => m.id === variant)) return { model: variant, effort: null };
    const offered = models
      .map((m) => m.id)
      .filter((id) => id.startsWith(`${family}-`))
      .map((id) => EFFORT_SUFFIX.exec(id)?.[1])
      .filter(Boolean);
    const order = ['low', 'medium', 'high', 'xhigh', 'max'];
    offered.sort((x, y) => order.indexOf(x) - order.indexOf(y));
    throw new UsageError(
      `Carbon 4 offers efforts ${offered.join(', ') || 'low, medium, high'}; --effort ${effort} is not one of them`,
      `pass --model <id> for a model that supports ${effort} (see \`agy models\`)`,
    );
  }
  throw new UsageError(
    `--model ${model} already sets effort ${suffix[1]}; it conflicts with --effort ${effort}`,
    `drop --effort, or use --model ${family}-${effort} if agy lists it`,
  );
}
