# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`docmap` (`@ray_of_goodness_/docmap`) — an AI-agent-agnostic CLI that deterministically discovers a codebase's module structure via framework adapters (Magento 2, Nuxt 4, NestJS, Vue 3, generic fallback), then delegates writing per-module business-logic documentation to a headless AI agent (Claude Code, Codex, or Gemini CLI). Output is a `.docmap/` tree mirroring the source structure. It is a Node CLI, not a web app.

## Commands

- `npm run dev` — run the CLI without building (`tsx src/cli.ts`)
- `npm run build` — bundle via `tsup` (`src/cli.ts` → `dist/cli.js`, ESM, node18 target)
- `npm test` — `vitest run`; `npm run test:watch` for watch mode
- Single test file: `npx vitest run test/core/promptBuilder.test.ts`
- `npm run typecheck` and `npm run lint` are both literally `tsc --noEmit` — there is no separate lint tool and no formatter (no prettier/biome config, no format script)

## Release

Version bump commits (`Release vX.Y.Z`) are created via `npm version <patch|minor|major>`; `npm publish` is run manually afterward. There is no CI publish step — `.github/workflows/ci.yml` only runs build+test on Node 18/20/22.

## Structure

- `src/core/` — orchestration: discovery, prompt building, fingerprinting, doc writing, relationship graph, concurrency, retry
- `src/adapters/` — per-framework module discovery (`magento2/`, `nuxt4/`, `vue3/`, `nestjs/`, `generic/`)
- `src/runners/` — shells out to agent CLIs (`claude.ts`, `codex.ts`, `gemini.ts`, `mock.ts`) via `execa`
- `src/commands/` — CLI subcommands (`init`, `scan`, `generate`, `status`, `clean`, `installSkills`)
- `src/config/` — cosmiconfig-based config loading
- `src/docFormat/` — frontmatter schema, parsing, rendering
- `test/` mirrors `src/`; `test/fixtures/` holds fake sample projects per adapter; `test/e2e/smoke.test.ts` is the end-to-end smoke test
- `skills/` — thin agent-integration wrappers this project *ships as a product* (installed into consumer projects by `docmap install-skills`) — not instructions for working on this repo itself

## Gotchas

- Tests run entirely against the `mock` runner in `src/runners/mock.ts` — no live LLM calls, no API keys needed to build/test.
- `src/runners/claude.ts` has a deliberate auth-conflict workaround: if `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`CLAUDE_CODE_OAUTH_TOKEN` conflict, it retries the `claude` CLI invocation with a stripped env (`extendEnv: false`).
- `tsconfig.json` is strict: `strict: true`, `noUncheckedIndexedAccess: true` — index access on arrays/objects returns `T | undefined`.
- `plans/` at the repo root holds local Ukrainian-language planning docs (roadmap/backlog) and is gitignored — not shared with other contributors or CI.

## Commits

Imperative, descriptive commit messages, no conventional-commit prefixes (`feat:`/`fix:`) — see `git log` for style.
