# agy-for-claude-code

A [Claude Code](https://claude.com/claude-code) plugin that brings **Google's Antigravity CLI (`agy`)** into your Claude Code session. Use it for second-opinion code reviews on Gemini's **Carbon 4** model, adversarial "should this ship?" reviews, multimodal analysis, web-grounded research and whole-repo surveys.

Maintained by [Opensense](https://github.com/Opensenseapp). It is a community project, not affiliated with Google or Anthropic.

## Why

Claude Code is good at most of what you need. `agy` adds:

- **An independent reviewer.** A different model family reviews the change you just wrote. By default reviews run on **Carbon 4 high** when your account has it.
- **Multimodal input.** Gemini natively reads video and audio, not just images.
- **Google Search grounding.** A second retrieval path, with different coverage from `WebSearch`.
- **A very large context window**, useful for questions that span a whole repo in one pass.

## Requirements

- The [Antigravity CLI](https://antigravity.google/) installed and signed in. Run `agy` once interactively to sign in, then check that `agy models` lists models. Usage counts against your Antigravity plan.
- Node.js 20 or later.
- macOS or Linux (WSL works). Native Windows is untested: the job monitor relies on POSIX process groups.

## Install

```bash
# in Claude Code
/plugin marketplace add Opensenseapp/agy-for-claude-code
/plugin install agy@agy-for-claude-code
/agy:setup
```

`/agy:setup` checks the binary, version, sign-in and state directory, and reports which model reviews will use. If something is missing, it names the one next step.

To stay on a reviewed release, pin the marketplace to a tag: `/plugin marketplace add Opensenseapp/agy-for-claude-code#v0.2.0`.

## Commands

| Command | What it does |
|---|---|
| `/agy:review` | Review the current change. **No tool access by default** |
| `/agy:adversarial-review` | Challenge the change: the strongest reasons it should not ship yet. Ends with a verdict |
| `/agy:delegate` | Hand a task to agy: implementation, diagnosis or a second opinion |
| `/agy:look` | Analyze images, video, audio or PDFs |
| `/agy:research` | Web-grounded research with per-claim source labelling |
| `/agy:survey` | An architecture-level question across the whole repo |
| `/agy:status` | List jobs and their state |
| `/agy:result` | Fetch a finished job's output |
| `/agy:cancel` | Stop a running job |
| `/agy:setup` | Health check |

Examples:

```text
/agy:review                                  # review the working tree
/agy:review --base main                      # review everything since main
/agy:adversarial-review --base main the retry and timeout paths
/agy:review --paths src/api.ts --effort low  # a quick pass on one file
/agy:look screenshot.png --question "why is the layout broken on mobile?"
/agy:research "current guidance on SameSite cookie defaults"
```

## How the review model is chosen

`/agy:review` and `/agy:adversarial-review` pick their model in this order:

1. `--model <id>`.
2. The `AGY_REVIEW_MODEL` environment variable.
3. **Carbon 4 high** (`gemini-4-carbon-high`), if `agy models` lists it for your account.
4. Otherwise agy's own default model, and the result says Carbon 4 isn't available.

The model list is cached for six hours.

**If agy refuses Carbon 4 at run time,** for example because your quota is used up, a review that chose Carbon 4 automatically retries **once** on agy's default model. The result header says so. A model you named yourself is never swapped. Each result starts with a `Model:` line, so you always know which model reviewed your code.

`--effort low|medium|high` picks the Carbon 4 variant; Carbon 4 has no `xhigh` or `max`. Other models accept `--effort low|medium|high|xhigh|max`. Commands other than the two reviews use agy's default model unless you pass `--model` or set `AGY_MODEL`.

## Privacy

Everything you send through these commands goes to Google through your Antigravity account: the review packet (your diff, staged and unstaged changes and, with `--include-untracked`, untracked file contents), your prompts and questions, and any files you pass to `/agy:look`. Don't use it on code or data you aren't allowed to share with Google.

Job records, including prompts, diffs and responses, are kept locally under `~/.claude/plugins/data/agy-for-claude-code/state` with `0700` directories and `0600` files. `prune --older-than 7d` removes finished ones.

## Tool access

- **`/agy:review` and `/agy:adversarial-review` run with no tools at all.** agy sees only the packet and cannot read or write anything else. `--with-tools` removes that guarantee for one run.
- **`/agy:research`, `/agy:survey`, `/agy:look` and `/agy:delegate` let agy run commands and write files without asking.** agy has no read-only tool mode to offer instead. `/agy:delegate --no-tools` is the exception.
  - Text agy reads during these commands, whether a web page, a file or a document, could try to steer it into running commands on your machine.
  - Use them on sources you trust, in a repository you're prepared to have changed, and review what agy did afterwards.
  - `/agy:look` also adds the folder of each file you pass to agy's workspace. `/agy:research` runs with your repository as its working directory.

## Troubleshooting

| Symptom | What to do |
|---|---|
| `agy binary not found` | Install the Antigravity CLI and run `agy install`. If it lives somewhere unusual, set `AGY_BIN`. |
| `no models returned` | agy isn't signed in. Run `agy` once interactively and sign in. |
| Result says "Carbon 4 is not available on this account" | Your plan doesn't include Carbon 4; reviews use agy's default model. Set `AGY_REVIEW_MODEL` to pick another. |
| "quota reached" / `RESOURCE_EXHAUSTED` | Your Antigravity quota is used up. Reviews that chose Carbon 4 automatically retry on agy's default model; otherwise wait for the reset shown in the message. |
| "the change is too large to review" | The packet is over 300 KB. Narrow it with `--paths a.js,b.js` or `--base <ref>`. |
| A job stays `running` | Check it with `/agy:status`. Stop it with `/agy:cancel <id>`. |

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

## Limitations

- **`--read-only` on `/agy:delegate` is advisory.** It keeps tool access (an investigation has to read the repo) and asks agy not to modify anything. Nothing enforces that. `--no-tools` is the enforced version, but it only works when the prompt is self-contained.
- **Review packets are capped** at 300 KB, and prompts at 400 KB. Oversized input is rejected with a suggestion to narrow it, never silently truncated.
- **It costs money.** Every command spends tokens on your Antigravity account.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AGY_BIN` | resolved from `PATH` | Path to the agy binary |
| `AGY_REVIEW_MODEL` | Carbon 4 high if listed | Model for `/agy:review` and `/agy:adversarial-review` |
| `AGY_MODEL` | agy's default | Model for the other commands |
| `AGY_PLUGIN_STATE_DIR` | `~/.claude/plugins/data/agy-for-claude-code/state` | Where job records live |
| `AGY_STALL_MS` | `600000` | Silence before a job is *reported* as quiet (never auto-cancelled) |
| `AGY_DEDUP_WINDOW_MS` | `300000` | Window in which an identical job is treated as a duplicate |
| `AGY_MAX_MEDIA_BYTES` | `536870912` | Largest file `/agy:look` will accept |

Job state is stored with `0700` directories and `0600` files — prompts, diffs, and model responses all live there. `agy-companion.mjs prune --older-than 7d` clears finished records.

## Development

```bash
npm test                                                        # unit and end-to-end tests with a fake agy; no network or sign-in needed
node plugins/agy/scripts/agy-companion.mjs doctor
node plugins/agy/scripts/agy-companion.mjs review --dry-run     # prints the agy argv and chosen model; spawns nothing
```

`--dry-run` prints the exact `agy` argv without spawning anything, which is what makes the command layer testable without spending tokens. End-to-end tests drive `tests/fixtures/fake-agy.mjs` through `AGY_BIN`.

## License

MIT. See [LICENSE](LICENSE).
