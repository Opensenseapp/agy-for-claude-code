---
description: Check that the Antigravity CLI (agy) is installed, authenticated, and usable from Claude Code
allowed-tools: Bash(node:*)
---

Run the health check:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" doctor
```

Report the output to the user as-is.

If any check fails, give the one specific next step rather than a list of possibilities:

- **agy binary not found** — install the Antigravity CLI and run `agy install` to put it on `PATH`. If it lives somewhere unusual, set `AGY_BIN` to its full path.
- **models not reachable** — the CLI is installed but not authenticated. Tell the user to run `agy` once interactively and sign in; the plugin cannot do that for them.
- **state directory not writable** — report the exact error. `AGY_PLUGIN_STATE_DIR` overrides the location.

The **review model** line is informational. It names the model `/agy:review` and `/agy:adversarial-review` will use: Carbon 4 high when the account lists it, otherwise agy's default (and why).

If every check passes, say so in one line and mention what is available: `/agy:delegate`, `/agy:review`, `/agy:adversarial-review`, `/agy:look`, `/agy:research`, `/agy:survey`.
