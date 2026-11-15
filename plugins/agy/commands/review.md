---
description: Review the current change with agy — bounded by construction, with no tool access by default
argument-hint: "[--base <ref>] [--paths a.js,b.js] [--include-untracked] [--with-tools] [--model <id>] [--effort low|medium|high] [specific question]"
allowed-tools: Bash(node:*)
---

Review the working change with agy.

Arguments: $ARGUMENTS

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review [flags] --label "review"
```

When the user asked a specific question, pass it on stdin rather than on the command line:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" review [flags] --label "review" --prompt-stdin <<'AGY_PROMPT_<random>'
<the question, verbatim>
AGY_PROMPT_<random>
```

Replace `<random>` with a new random suffix for every call (12 random hex digits, say) and use it on both lines. Make sure no line of the text is exactly the delimiter; if one is, pick another suffix. A line equal to the delimiter would end the heredoc early, and the shell would run the rest of the text as commands. Keep the delimiter quoted, so the shell expands nothing inside it.

The companion assembles the review packet itself — committed range, staged, unstaged, and untracked files — and inlines it in the prompt. **By default the run has no tool access at all**, so agy physically cannot read or write anything outside the packet. That is a real boundary, not an instruction it might ignore.

Flag guidance:

- `--base <ref>` reviews `<ref>...HEAD`. Without it, only the working tree is reviewed.
- `--paths a.js,b.js` narrows the packet. Use it when the diff is large — the packet is capped and an oversized one is rejected rather than silently truncated.
- `--include-untracked` inlines untracked file contents. Without it they are listed by name only.
- `--with-tools` grants tool access so agy can open files beyond the packet. Only use it when the user asks for a deeper pass, and say plainly that this drops the read-only guarantee.
- The question (on stdin, as above) is appended to the review.
- `--model <id>` picks the model. Otherwise, `AGY_REVIEW_MODEL` if set, then **Carbon 4 high** (`gemini-4-carbon-high`) when the account lists it, then agy's own default. If Carbon 4 was chosen automatically and agy refuses it (quota reached, for example), the review is retried once on agy's default model, and the result header says so.
- `--effort low|medium|high` picks the Carbon 4 variant. Carbon 4 has no `xhigh` or `max`; to use those, pass `--model` for a model that supports them.

Results come back as structured findings against the plugin's schema, each labelled `verified` (agy actually ran it) or `illustrative` (it did not).

**Handling the findings — this part matters:**

- Findings marked `illustrative` are unverified hypotheses. Before you act on one, reproduce it against the real code. Reproduce the example *exactly* as given, not a paraphrase — a near-miss variant can lack the very precondition the mechanism needs.
- A failed reproduction does not automatically refute a finding; it tells you about the setup you built. If it does not fire, ask what precondition the mechanism requires and test that.
- Findings marked `verified` still deserve a check when they hinge on specific input/output values.
- If the run reports `denied`, agy tried to use a tool it does not have. Either the packet was insufficient or the question needed file access — re-run with `--with-tools`.
- Report real defects to the user. Do not pad the list with nits to look thorough.
