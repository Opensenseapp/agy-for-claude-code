---
description: Research a question with agy's built-in Google Search grounding, then verify the claims
argument-hint: "<question to research>"
allowed-tools: Bash(node:*)
---

Research a question using agy's native web search.

Question: $ARGUMENTS

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" research --prompt-stdin --label "research" <<'AGY_PROMPT_<random>'
<the question, verbatim>
AGY_PROMPT_<random>
```

Pass the question through stdin with that quoted heredoc rather than as a command-line argument, so a question containing quotes, backticks or `$` cannot break the command or run. Replace `<random>` with a new random suffix for every call (12 random hex digits, say) and use it on both lines. Make sure no line of the text is exactly the delimiter; if one is, pick another suffix. A line equal to the delimiter would end the heredoc early, and the shell would run the rest of the text as commands. Keep the delimiter quoted, so the shell expands nothing inside it.

agy returns an answer, a claims list, and what it could not determine. Each claim is marked VERIFIED (it opened the source) or UNVERIFIED (search snippet or prior knowledge).

Before you relay this to the user:

- Treat UNVERIFIED claims as unconfirmed. If one matters to the decision at hand, check it — usually one `WebFetch` of the cited URL.
- Watch for a claim whose own cited source contradicts it. That self-contradiction is the clearest tell that a claim was generated to fit a conclusion.
- Keep the distinction visible in your answer. Do not present an UNVERIFIED claim as settled fact.
- If sources genuinely disagree, say so and give both rather than picking one silently.

This complements `WebSearch` rather than replacing it — a second retrieval path with different coverage. For a contested or high-stakes question, running both and comparing is reasonable.
