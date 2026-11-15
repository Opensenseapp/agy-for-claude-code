# Changelog

## 0.2.0 (2026-11-15)

- **Carbon 4 reviews.**
  - `/agy:review` and `/agy:adversarial-review` default to `gemini-4-carbon-high` when the account lists it, then agy's own default. `--model` and `AGY_REVIEW_MODEL` override this.
  - If agy refuses an automatically chosen Carbon 4 model (quota reached, or not on the plan), the review retries once on agy's default model and says so.
  - Every result starts with a `Model:` line.
- **New `/agy:adversarial-review`.** A challenge review that questions the approach and assumptions. It ends with a verdict that never reads as approval when the run did not complete.
- **All effort levels.** `--effort low|medium|high|xhigh|max`. With Carbon 4, effort picks the Carbon variant (low, medium or high).
- **`/agy:setup`** reports which model reviews will use, and why.
- **Fix: oversized reviews.** A review packet over 300 KB is now rejected with a hint, as documented, instead of being silently truncated.
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
