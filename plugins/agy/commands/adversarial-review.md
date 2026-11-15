---
description: Challenge the current change with agy — questions the approach, design choices and assumptions, with no tool access by default
argument-hint: "[--base <ref>] [--paths a.js,b.js] [--include-untracked] [--with-tools] [--model <id>] [--effort low|medium|high] [focus ...]"
allowed-tools: Bash(node:*)
---

Run an adversarial review of the working change with agy.

Arguments: $ARGUMENTS

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" adversarial-review [flags] --prompt-stdin <<'AGY_PROMPT_<random>'
<the focus, verbatim>
AGY_PROMPT_<random>
```

Pass the focus on stdin as shown, never on the command line. Without a focus, drop `--prompt-stdin` and the heredoc. Replace `<random>` with a new random suffix for every call (12 random hex digits, say) and use it on both lines. Make sure no line of the text is exactly the delimiter; if one is, pick another suffix. A line equal to the delimiter would end the heredoc early, and the shell would run the rest of the text as commands. Keep the delimiter quoted, so the shell expands nothing inside it.

This is a challenge review: agy tries to find the strongest reasons the change should not ship yet. It questions the chosen approach, design choices, tradeoffs and assumptions, not just implementation defects. The focus is what to weight most, for example `the retry path` or `concurrent writers`.

It uses the same review packet as `/agy:review`: the committed range, staged, unstaged and untracked files, inlined into the prompt. **By default the run has no tool access**, so agy cannot read or write anything outside the packet. The flags are the same as `/agy:review`: `--base`, `--paths`, `--include-untracked`, `--with-tools`, `--model` and `--effort`. Reviews use Carbon 4 high by default when the account has it.

The result starts with a **verdict**:

- **approve** — agy found nothing it could defend as a reason not to ship.
- **needs attention** — at least one material risk. The findings follow, each with severity, file and lines, what can go wrong, a recommendation, and whether the example was `verified` or `illustrative`.
- **not available** — the run failed, was denied, or returned no verdict. Treat the change as unreviewed and say so; never present this as approval.

Handle findings as for `/agy:review`: reproduce `illustrative` findings exactly as given before acting on them, and report real risks to the user rather than padding the list.
