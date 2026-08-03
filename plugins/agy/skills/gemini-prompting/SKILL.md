---
name: gemini-prompting
description: How to shape a request for the Antigravity CLI (agy) so it returns bounded, verifiable work instead of an open-ended sweep
user-invocable: false
---

# Prompting agy

Use when composing the task text forwarded to agy. Reshaping the request is the only Claude-side work allowed before forwarding — do not solve the problem yourself and hand over your answer.

## Bound the work explicitly

An unbounded instruction ("audit every consumer", "check all call sites") sends the agent into repo-wide sweeps. That is the single most common way a delegated task burns many minutes and returns nothing useful.

State a budget in the prompt: how many files it may read, how many commands it may run, and that it must not run repo-wide `rg`/`grep`/`find` sweeps. Ten named files beat "the whole repo" nearly every time.

## Pre-compute, then ask it to validate

If you already know the call sites, the failing test output, or the diff, **put that in the prompt** and ask agy to check specific questions against it. Asking it to re-derive what you already have is where the time goes.

Compare:

- Weak: "Does this refactor break anything?"
- Strong: "Here are the 6 call sites (pasted below) and the failing test output. For each call site, answer yes/no: does the new signature break it? Read at most 3 files."

## Demand honest evidence

Models generate example inputs that fit their conclusion and never execute them. A finding can be correct while every example illustrating it is fabricated.

Always require: label each concrete example VERIFIED (actually executed) or ILLUSTRATIVE (not executed). Then treat ILLUSTRATIVE examples as hypotheses — reproduce them verbatim before acting. A near-miss variant of an example can lack the exact precondition the mechanism depends on, so "I tried it and it didn't reproduce" is not a refutation until you have reproduced the example *as written*.

## Ask for the shape you want

- Structured output: pass `--schema <path>` and agy returns a parsed object rather than prose you have to re-parse.
- Ask for what it did **not** examine. Without that, a partial answer is indistinguishable from an exhaustive one.
- Ask for file paths with claims. A claim with no path is unverifiable.

## Pick the right knob

- `--effort` accepts `low`, `medium`, `high` only. Leave it unset unless the user asked; the default is well-calibrated.
- Leave `--model` unset by default. agy routes Gemini models plus `claude-sonnet-4-6`, `claude-opus-4-6-thinking`, and `gpt-oss-120b-medium` — worth naming one only when the user wants a specific second opinion.
- Reach for agy specifically when the task needs something Claude Code lacks: multimodal input (video, audio), Google Search grounding, or a very large context in one pass. For ordinary code work the main thread is usually the better tool.

## Keep the user's words

Strip routing flags, add the bounding and evidence rules, and otherwise forward the request intact. Rewriting the task into your own summary loses detail the user cared about.
