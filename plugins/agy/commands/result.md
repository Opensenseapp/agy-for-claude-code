---
description: Show the output of a finished agy job
argument-hint: "<job-id> [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" result $ARGUMENTS
```

Job ids are indexed globally, so this works from any directory — including a different worktree than the one that launched the job.

Relay the output. If the job did not succeed, lead with the reason and the hint rather than the raw payload:

- `denied` — agy had no tool access and needed it.
- `empty` — it ran cleanly and produced nothing. Usually the prompt, not a fault.
- `schema violation` — structured output was requested and it answered in prose.
- `timeout` — it hit the job deadline. Re-run narrower, or raise `--timeout`.
- `cancelled` — someone stopped it.

If the job is still running, say so and suggest checking back. Do not poll in a loop.
