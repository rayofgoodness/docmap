# docmap

This project uses `docmap` to keep `.docmap/` module documentation in sync
with source. All logic lives in the CLI:

1. `npx docmap scan` — preview modules/relations, no AI calls.
2. `npx docmap generate --runner codex` — generate/refresh docs using this
   agent. Add `--module <id>` to target one module, `--force` to bypass the
   fingerprint cache.
3. Review `.docmap/` output and summarize what changed. Don't hand-edit
   `.docmap/` files — re-run `docmap generate` instead so fingerprints stay
   accurate.
4. `npx docmap status` shows missing/stale modules without generating.
