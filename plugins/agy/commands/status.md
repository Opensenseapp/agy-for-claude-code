---
description: List agy jobs for this repository and their current state
argument-hint: "[--all] [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" status $ARGUMENTS
```

Show the table to the user.

Reading it:

- Jobs are keyed on the **git repository root**, so a job started inside a worktree is still visible from the main checkout. `--all` widens to every repository.
- `running (quiet 12m)` means the job is alive but has not written output for a while. That is information, not a verdict — long silent stretches are normal while a model reads or thinks, and a job frequently resumes after minutes of nothing. Do not cancel on quiet alone. Every job streams its output, so a job that is reading files or thinking keeps writing; quiet for the whole run since it started is the stronger hint of a hang.
- `denied (no tool access)` means agy tried to use a tool it was not granted. The job finished; it just could not do anything.
- Records reconcile lazily, so a job whose monitor died is settled the moment you list it rather than lingering as `running` forever.

Fetch output with `/agy:result <job-id>`.
