---
name: agy-cli-runtime
description: Internal contract for calling the agy-companion runtime from Claude Code
user-invocable: false
---

# agy runtime contract

Use this skill only inside the `agy:agy-delegate` subagent.

## The one call

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" task --prompt-stdin [flags] <<'__AGY_PROMPT__'
<task text, verbatim>
__AGY_PROMPT__
```

The subagent is a forwarder, not an orchestrator. One `task` invocation, return stdout unchanged.

## Flags

| Flag | When |
|---|---|
| `--background` | open-ended or long-running work |
| `--read-only` | investigation without edits (advisory — agy still has tool access) |
| `--no-tools` | hard boundary: no tool access at all. Only useful when the prompt is fully self-contained |
| `--model <id>` | the user named a model |
| `--effort low\|medium\|high\|xhigh\|max` | the user asked for a reasoning level. With a Carbon 4 model, effort picks the Carbon variant, which only offers low, medium and high |
| `--resume last\|<id>` | the user is continuing previous agy work |
| `--label <text>` | a short handle for `status` output |
| `--timeout <30s\|10m\|1h>` | the default 30-minute deadline is wrong for this task |

Leave `--model` and `--effort` unset unless asked. Reviews choose their own model (Carbon 4 high when the account has it), and the companion explains its choice.

## Rules that exist for a reason

- **Never add `--resume` on your own initiative.** Resuming returns the earlier conversation's answer, which reads as a fresh result and is often about entirely different code.
- **Never retry.** A failed call returns its error; a retry starts a second job doing identical work. The companion's dedup guard will usually catch it, but do not rely on that.
- **Never interpolate task text into the command line.** Always the quoted heredoc.
- **Do not call** `review`, `look`, `research`, `survey`, `status`, `result`, `cancel`, or `doctor` from this subagent. Those belong to their own commands.

## Reading the outcome

The companion classifies every run. `succeeded` and `partial (tool denied)` carry usable output; everything else does not:

- `denied (no tool access)` — agy tried a tool it was not granted and produced nothing. agy itself reports `SUCCESS` with an empty response and exit code 0 in this case, which is why the classification exists.
- `empty response` — it ran cleanly and returned nothing.
- `schema violation` — structured output was requested, prose came back.
- `timed out` / `cancelled` / `failed` — self-explanatory; the reason line carries the detail.

Return the output as-is either way. Do not interpret, summarize, or fix it — that is the main thread's job.
