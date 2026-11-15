# Changelog

## 0.2.1 (2026-11-15)

- **Fix: dead jobs no longer read "running" forever.** A job whose monitor died without finalizing (reboot, SIGKILL) was kept as `running` whenever its pid had been reused by another process. `status` showed one such job as `running (quiet 603h)`. Records now carry the monitor's start time, and `status`, `result` and duplicate detection check it. Older records fall back to matching the companion script in the process's command line.
- **Foreground jobs stream too.** A `--wait` job (the default) asked agy for a single JSON payload, so its log stayed empty until the end, and `status` could not tell a job that was reading files from a hung one. Every job now uses `stream-json`, and results are parsed the same way as before.

## 0.2.0 (2026-11-15)

- **Carbon 4 reviews.**
  - `/agy:review` and `/agy:adversarial-review` default to `gemini-4-carbon-high` when the account lists it, then agy's own default. `--model` and `AGY_REVIEW_MODEL` override this.
  - If agy refuses an automatically chosen Carbon 4 model (quota reached, or not on the plan), the review retries once on agy's default model and says so.
  - Every result starts with a `Model:` line.
- **New `/agy:adversarial-review`.** A challenge review that questions the approach and assumptions. It ends with a verdict that never reads as approval when the run did not complete.
- **All effort levels.** `--effort low|medium|high|xhigh|max`. With Carbon 4, effort picks the Carbon variant (low, medium or high).
- **`/agy:setup`** reports which model reviews will use, and why.
- **Fix: oversized reviews.** A review packet over 300 KB is now rejected with a hint, as documented, instead of being silently truncated.
- **Fix: mistyped `--base`.** A `--base` that is not a commit is now an error. It used to silently review only the working tree.
- **`/agy:setup` outside a git repository** no longer reports a failure.
- **Fix: binary-looking source.** `paths.mjs` no longer contains a raw NUL byte, which made git and scanners treat it as binary.
- **Security fixes** (from a security review of the plugin):
  - Prompts, questions and focus text go to agy through a quoted heredoc with a fresh random delimiter, read from stdin. A line in the text can no longer end the heredoc early and run as a shell command, and `/agy:review`, `/agy:adversarial-review` and `/agy:look` no longer put free text on the command line.
  - An untracked symlink is never followed into a review packet.
  - `--base` can no longer be read by git as an option.
  - Job ids, repo keys and fingerprints are validated before a path is built from them. The state directory must be a private directory owned by you.
  - `/agy:cancel` signals agy only while its recorded start time still matches, and never pid 0 or 1.
- **Project moved.** The repository is now [Opensenseapp/agy-for-claude-code](https://github.com/Opensenseapp/agy-for-claude-code), and the old URL redirects. There are new Privacy, Tool access and Troubleshooting sections in the README. CI runs on macOS and Linux.

## 0.1.0 (2026-08-02)

- First release: `delegate`, `review`, `look`, `research`, `survey`, `status`, `result`, `cancel` and `setup`.
