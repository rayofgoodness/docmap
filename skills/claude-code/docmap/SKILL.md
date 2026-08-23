---
name: docmap
description: Generate or refresh module-level *.md documentation for this project (FE/BE), describing each module's purpose, elements, and cross-module relationships. Use when the user asks to "document this codebase", "generate docs", "update docmap", or mentions docmap/.docmap.
---

# docmap

This project uses `docmap` — a CLI that deterministically discovers modules
(via a framework adapter for Magento 2 / Nuxt 4 / a generic fallback) and
writes documentation into `.docmap/`, mirroring the project's module
structure. Each module gets a root doc plus per-element docs, and
`.docmap/index.md` holds the cross-module relationship graph.

All discovery and file-writing logic lives in the CLI — this skill only
orchestrates it:

1. Preview what will be documented, no AI calls, no writes:
   ```bash
   npx docmap scan
   ```
2. If you just changed code in a module that already has docs, run
   `docmap verify` first — BEFORE `docmap generate` — to check whether
   the change broke any documented business behavior:
   ```bash
   npx docmap verify --runner claude
   ```
   Only move on to `generate` once you understand the verdict: if it
   came back `COMPATIBLE`, or you've confirmed with the user that a
   `CHANGED`/`BREAKING` result was intentional. Don't skip straight to
   `generate` on a module `verify` flagged — that overwrites the doc
   (the eталон `verify` compares against) with the new, possibly
   regressed, behavior.
3. Generate/update docs, using this agent as the runner:
   ```bash
   npx docmap generate --runner claude
   ```
   Add `--module <id>` to target a single module, `--force` to bypass the
   fingerprint cache, `--dry-run` to preview prompts without calling out.
4. Review the written files under `.docmap/` and report a summary back to
   the user — do not hand-edit `.docmap/` content yourself; re-run
   `docmap generate` instead so the fingerprint stays in sync with source.
5. Check `docmap status` any time to see which modules are missing/stale
   without re-running generation.
