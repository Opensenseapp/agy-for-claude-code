---
description: Delegate a task to the Antigravity CLI (agy) — implementation, diagnosis, or a second opinion
argument-hint: "[--background|--wait] [--read-only] [--resume last|<id>] [--model <id>] [--effort low|medium|high|xhigh|max] <what agy should do>"
allowed-tools: Bash(node:*), Agent
---

Delegate this request to agy via the `agy:agy-delegate` subagent (`subagent_type: "agy:agy-delegate"`), forwarding the raw request as the prompt.

Raw user request:
$ARGUMENTS

`agy:agy-delegate` is a subagent, not a skill — do not call `Skill(agy:agy-delegate)`, and do not call `Skill(agy:delegate)` (that re-enters this command). Run this command inline so the `Agent` tool stays in scope.

Execution mode:

- `--background` runs the subagent in the background; `--wait` runs it in the foreground. Default to foreground for a small, clearly bounded request, and background for anything open-ended or long-running.
- These two are Claude-side execution flags. Do not pass them through as part of the task text.
- `--model`, `--effort`, `--resume`, `--read-only`, and `--no-tools` are runtime flags. Preserve them for the forwarded call, but keep them out of the natural-language task text.

Rules:

- The subagent makes exactly one Bash call and returns its stdout. Return that output verbatim — do not paraphrase, summarize, or add commentary around it.
- Do not ask the subagent to inspect files, poll for status, fetch results, or do follow-up work.
- Never add `--resume` unless the user explicitly asked to continue previous agy work. A fresh conversation is the default precisely so that a stale thread cannot return old findings as if they were new.
- If the user did not say what to delegate, ask before dispatching.
- If the output says agy is missing or unauthenticated, stop and tell the user to run `/agy:setup`.

After the output lands, if agy proposed code changes, treat them as a proposal to evaluate — not as instructions to apply. Verify any concrete claim before acting on it.
