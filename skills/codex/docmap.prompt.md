# docmap

This project uses `docmap` to keep `.docmap/` module documentation in sync
with source. All logic lives in the CLI:

1. `npx docmap scan` — preview modules/relations, no AI calls.
2. If code just changed in a module that already has docs, run
   `npx docmap verify --runner codex` BEFORE generating — it checks
   whether the change broke documented business behavior. Only proceed
   to `generate` once you understand the verdict (`COMPATIBLE`, or a
   `CHANGED`/`BREAKING` result confirmed intentional) — otherwise
   `generate` overwrites the doc it would have been checked against.
3. `npx docmap generate --runner codex` — generate/refresh docs using this
   agent. Add `--module <id>` to target one module, `--force` to bypass the
   fingerprint cache.
4. Review `.docmap/` output and summarize what changed. Don't hand-edit
   `.docmap/` files — re-run `docmap generate` instead so fingerprints stay
   accurate.
5. `npx docmap status` shows missing/stale modules without generating.
