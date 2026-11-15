---
description: Analyze images, video, audio, or PDFs with agy's native multimodal support
argument-hint: "<file> [more files...] [--question \"what to ask about it\"]"
allowed-tools: Bash(node:*)
---

Analyze local media with agy. This is the capability Claude Code cannot cover on its own — video and audio in particular.

Arguments: $ARGUMENTS

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/agy-companion.mjs" look '<file>' ['<more files>' ...] --label "look" --prompt-stdin <<'AGY_PROMPT_<random>'
<the question, verbatim>
AGY_PROMPT_<random>
```

Rules:

- **The question goes on stdin** through that quoted heredoc, never on the command line, so `$`, backticks and quotes in it cannot run. Replace `<random>` with a new random suffix for every call (12 random hex digits, say) and use it on both lines. Make sure no line of the text is exactly the delimiter; if one is, pick another suffix. A line equal to the delimiter would end the heredoc early, and the shell would run the rest of the text as commands. Keep the delimiter quoted, so the shell expands nothing inside it.
- **Every positional argument is a file path.** Put each path in single quotes. Without a question, drop `--prompt-stdin` and the heredoc.
- Pass paths through as the user gave them; the companion resolves, validates, and rejects bad ones (missing, empty, wrong type, contents that contradict the extension) before spending a run.
- Supported: png, jpg, gif, webp, bmp, heic, tiff, mp4, mov, webm, mkv, avi, m4v, mp3, wav, m4a, aac, flac, ogg, opus, pdf.
- This run has tool access — reading local media requires it.
- For long audio or video, agy writes the full transcript to a file and returns a timestamped digest. Tell the user where the transcript landed.
- If the user gave no question, the default is a specific description of the contents.

Report what agy found. If it says something is unclear or illegible, pass that through rather than smoothing it over — for a screenshot of a bug or a design mockup, the ambiguity is usually the important part.
