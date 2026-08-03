# agy-for-claude-code

A [Claude Code](https://claude.com/claude-code) plugin that delegates work to the **Google Antigravity CLI** (`agy`) — code review, multimodal analysis, web-grounded research, and long-context repo surveys, driven from inside your Claude Code session.

Community project. Not affiliated with Google or Anthropic.

---

## Why

Claude Code is good at most of what you need. `agy` covers three things it structurally cannot:

- **Multimodal input.** Gemini natively reads video and audio, not just images.
- **Google Search grounding.** A second retrieval path with different coverage than `WebSearch`.
- **A very large context window**, useful for questions that span a whole repo in one pass.

Plus the ordinary value of a second model: an independent review of a change you just wrote, from something that did not write it.

## Install

Requires the Antigravity CLI on `PATH` and Node 20+.

```bash
# in Claude Code
/plugin marketplace add amit777/agy-for-claude-code
/plugin install agy@agy-for-claude-code
/agy:setup
```

`/agy:setup` checks the binary, version, authentication, and state directory, and tells you the single next step if something is missing.

## Commands

| Command | What it does |
|---|---|
| `/agy:delegate` | Hand a task to agy — implementation, diagnosis, or a second opinion |
| `/agy:review` | Review the current change. **No tool access by default** |
| `/agy:look` | Analyze images, video, audio, or PDFs |
| `/agy:research` | Web-grounded research with per-claim source labelling |
| `/agy:survey` | Architecture-level question across the whole repo |
| `/agy:status` | List jobs and their state |
| `/agy:result` | Fetch a finished job's output |
| `/agy:cancel` | Stop a running job |
| `/agy:setup` | Health check |

## Design notes

Most of this exists because of things that go wrong in practice.

### A "successful" run that did nothing

In headless mode `agy` auto-denies every tool permission — including `read_file` — and then reports:

```json
{"status":"SUCCESS","response":"","duration_seconds":0.8}
```

Exit code `0`. The only signal that anything went wrong is a line on **stderr**. Any wrapper that trusts `status` reports a job that did absolutely nothing as a success.

So the runtime classifies every run itself, checking terminal causes before content: cancellation, timeout, signal, non-zero exit, result validity, agy's own status, permission denial, schema compliance, then content. An empty response with the denial diagnostic on stderr comes back as **denied**, naming the exact permission that was refused.

### Review runs with no tools at all

There is no CLI flag that means "reads allowed, writes denied" — `--mode plan` does **not** prevent writes (verified: it happily created a file). Permissions are all-or-nothing.

So `/agy:review` inlines the entire diff into the prompt and runs with **no tool access whatsoever**. agy cannot read or write anything outside the packet, because it has no tools to do it with. That is an enforced boundary, not an instruction it might ignore — and it still reviews perfectly well, since everything it needs is in the packet.

`--with-tools` opts out when you want a deeper pass. It says so plainly rather than pretending otherwise.

### Every job has a monitor

Each background job gets its own short-lived monitor process — not a daemon. The monitor spawns agy, owns the timeout deadline, captures the exit code and terminating signal, classifies the outcome, and finalizes the record.

Without one, nothing reaps the child: the exit code is lost the moment the launching process exits, and the runtime can only infer completion from an absent PID, which PID reuse makes unreliable. That is how jobs end up stuck at `running` forever. If a monitor dies anyway, the record reconciles from its logs the next time you list it.

### Duplicate jobs are structurally impossible

Jobs are fingerprinted over kind, repo, prompt, model, effort, and resume target, and claimed with an atomic `mkdir`. An identical job already in flight returns the existing job id instead of starting a second one. `--force-new` overrides.

### Resume is never implicit

`/agy:delegate` always starts a fresh conversation. Continuing requires `--resume last` or `--resume <conversation-id>`. An implicitly resumed thread returns the *previous* question's findings, which read as new results and are often about entirely different code.

### State is keyed on the repo root

Not the working directory's name. A job launched inside a git worktree is visible from the main checkout, and `result <id>` resolves from anywhere via a global index.

### Evidence has to be labelled

Review findings carry `evidence: "verified" | "illustrative"` — did agy actually run the example, or just reason about it? Models routinely generate example inputs that fit a conclusion and were never executed. The finding can be right while every example illustrating it is invented. Treat `illustrative` as a hypothesis and reproduce it verbatim before acting.

## Honest limitations

- **`--read-only` on `/agy:delegate` is advisory.** It keeps tool access (an investigation has to read the repo) and asks agy not to modify anything. Nothing enforces that. `--no-tools` is the enforced version, but only works when the prompt is self-contained.
- **Native Windows is unsupported.** macOS, Linux, and WSL only — the job monitor relies on POSIX process groups.
- **Review packets are capped** at 300 KB, and prompts at 400 KB. Oversized input is rejected with a suggestion to narrow, never silently truncated.
- **Costs money.** Every command spends tokens on your Antigravity account.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGY_BIN` | resolved from `PATH` | Path to the agy binary |
| `AGY_PLUGIN_STATE_DIR` | `~/.claude/plugins/data/agy-for-claude-code/state` | Where job records live |
| `AGY_STALL_MS` | `600000` | Silence before a job is *reported* as quiet (never auto-cancelled) |
| `AGY_DEDUP_WINDOW_MS` | `300000` | Window in which an identical job is treated as a duplicate |
| `AGY_MAX_MEDIA_BYTES` | `536870912` | Largest file `/agy:look` will accept |

Job state is stored with `0700` directories and `0600` files — prompts, diffs, and model responses all live there. `agy-companion.mjs prune --older-than 7d` clears finished records.

## Development

```bash
npm test                       # 133 unit tests, no network or auth needed
node plugins/agy/scripts/agy-companion.mjs doctor
node plugins/agy/scripts/agy-companion.mjs task --dry-run "hello"   # prints argv, spawns nothing
```

`--dry-run` prints the exact `agy` argv without spawning anything, which is what makes the command layer testable without spending tokens.

## License

MIT
