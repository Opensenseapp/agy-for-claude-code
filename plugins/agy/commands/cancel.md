---
description: Cancel a running agy job
argument-hint: "<job-id> | --all"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" cancel $ARGUMENTS
```

Cancellation writes a durable request first, then signals the job's monitor, which takes the process group down with SIGTERM and escalates to SIGKILL if needed. The monitor verifies the process is still the one it started before signalling anything, so a stale record cannot take down an unrelated process.

If the monitor is already gone, the companion terminates any surviving child and finalizes the record itself — a cancelled job never lingers as `running`.

Report the outcome. If the job had already finished, say so plainly instead of implying something was stopped.
