---
description: Ask an architecture-level question across the whole repo using agy's long context
argument-hint: "[--add-dir <path>] [--background] <architecture question>"
allowed-tools: Bash(node:*)
---

Use agy's long context window for a question that spans many files at once — where targeted reads would mean a dozen round trips.

Question: $ARGUMENTS

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" survey --prompt-stdin --label "survey" <<'AGY_PROMPT_<random>'
<the question, verbatim>
AGY_PROMPT_<random>
```

Replace `<random>` with a new random suffix for every call (12 random hex digits, say) and use it on both lines. Make sure no line of the text is exactly the delimiter; if one is, pick another suffix. A line equal to the delimiter would end the heredoc early, and the shell would run the rest of the text as commands. Keep the delimiter quoted, so the shell expands nothing inside it.

Add `--background` when the repo is large; a survey is the most likely command to run long. Add `--add-dir <path>` for directories outside the repo root that the question depends on.

Good fits: "how does authentication flow from the edge to the database", "which modules would a change to the job runner touch", "where is retry logic implemented and do the implementations agree".

Poor fits: anything answerable with one grep. Do that yourself — a survey is slower and costs more.

The answer comes back with the evidence paths agy actually opened, anything that complicates the answer, and an explicit list of what it did **not** examine. Relay that last part: it tells the user where the answer is thin, and dropping it makes a partial survey read as an exhaustive one.

Spot-check the cited paths exist before building on the answer. A survey that cites a file it never opened is worth catching early.
