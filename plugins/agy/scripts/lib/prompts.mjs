/**
 * Prompt templates.
 *
 * Two disciplines are baked in rather than left to the caller:
 *
 * 1. Bounded work. Open-ended "audit every consumer" instructions send an agent
 *    into repo-wide sweeps that overrun the runtime. Every template that allows
 *    tools states an explicit file and command budget.
 * 2. Honest evidence. Models routinely generate illustrative example inputs that
 *    fit a conclusion and were never executed. Each template demands an explicit
 *    VERIFIED / ILLUSTRATIVE label so the caller knows what to re-check.
 */

const EVIDENCE_RULE = `For every concrete example, input, or command you cite, label it VERIFIED (you actually ran it and observed the result) or ILLUSTRATIVE (you reasoned about it but did not run it). Never label something VERIFIED that you did not execute. If you cannot run something, say so plainly rather than inventing a plausible result.`;

function budget({ maxFiles, maxCommands }) {
  return `Work within this budget: read at most ${maxFiles} files and run at most ${maxCommands} commands, then answer. Do NOT run repo-wide rg/grep/find sweeps — they are the single most common way this kind of task overruns and returns nothing.`;
}

export function reviewPrompt({ packet, questions = [], noTools, maxFiles = 8, maxCommands = 5 }) {
  const sections = [
    `You are reviewing a code change. Report defects; do not rewrite the code.`,
    ``,
  ];

  if (noTools) {
    sections.push(
      `You have NO tool access in this run. Everything you need is in the review packet below. Answer entirely from it. Do not attempt to read files or run commands — those calls will be denied and you will produce nothing.`,
    );
  } else {
    sections.push(budget({ maxFiles, maxCommands }));
  }

  sections.push(
    ``,
    EVIDENCE_RULE,
    ``,
    `Rank findings by severity (blocking > major > minor > nit). For each, give the file, a one-sentence statement of the defect, a concrete failure scenario (inputs or state that produce the wrong result), and a suggested fix. Report only real defects — if the change looks correct, say so and return an empty findings list rather than inventing nits.`,
    ``,
  );

  if (questions.length > 0) {
    sections.push(`Answer these specific questions as well:`, ...questions.map((q, i) => `${i + 1}. ${q}`), ``);
  }

  sections.push(`--- BEGIN REVIEW PACKET ---`, packet, `--- END REVIEW PACKET ---`);
  return sections.join('\n');
}

export function lookPrompt({ files, question, transcriptPath }) {
  const list = files.map((file) => `- ${file}`).join('\n');
  const ask =
    question ??
    `Describe what this media contains, precisely and specifically. Prefer concrete detail over general impressions.`;

  return [
    `Analyze the following local media files:`,
    list,
    ``,
    ask,
    ``,
    `If a file is audio or video longer than about two minutes, write the full transcript to ${transcriptPath} and return only a timestamped digest (one line per notable moment, in mm:ss form) rather than the whole transcript.`,
    ``,
    `Describe only what is actually present in the media. If something is unclear or illegible, say so instead of guessing.`,
  ].join('\n');
}

export function researchPrompt({ question, maxSearches = 6 }) {
  return [
    `Research this question using web search, then answer it.`,
    ``,
    question,
    ``,
    `Run at most ${maxSearches} searches. Prefer primary sources (official docs, specifications, source repositories) over blog summaries.`,
    ``,
    `Structure your answer as:`,
    `1. A direct answer, in a few sentences.`,
    `2. A "Claims" list. For each substantive claim: the claim, then VERIFIED if you actually opened the source and read it, or UNVERIFIED if you are relying on a search snippet or your own prior knowledge, then the source URL.`,
    `3. What you could not determine.`,
    ``,
    `Do not present an inference as a sourced fact. If sources disagree, say so and give both.`,
  ].join('\n');
}

export function surveyPrompt({ question, repoRoot, maxFiles = 40, maxCommands = 10 }) {
  return [
    `Survey the codebase at ${repoRoot} and answer an architecture-level question.`,
    ``,
    question,
    ``,
    budget({ maxFiles, maxCommands }),
    `Use directory listings and targeted reads to build a picture; read broadly but shallowly rather than deeply into one file.`,
    ``,
    EVIDENCE_RULE,
    ``,
    `Answer with:`,
    `1. A direct answer to the question.`,
    `2. The concrete evidence: which files/directories establish it, with paths.`,
    `3. Anything that contradicts or complicates the answer.`,
    `4. What you did NOT examine, so the caller knows the blind spots.`,
    ``,
    `Cite real paths you actually opened. Do not cite a path you did not read.`,
  ].join('\n');
}

export function delegatePrompt({ task, readOnly }) {
  if (!readOnly) return task;
  return [
    task,
    ``,
    `Constraint: this is an investigation, not an implementation. Do not create, modify, or delete any files, and do not run a test suite. Report what you found and what you would change.`,
  ].join('\n');
}
