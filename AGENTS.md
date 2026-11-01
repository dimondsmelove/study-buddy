# Study Buddy — current context

Read `CURRENT-STATE.md` first. It identifies validated artifacts, current guides and historical context. Do not use dated ToDo/release/research statements as current facts without checking code and artifacts.

- Canonical frontend reference: `/home/diamondsepticon/Projects/OCR-AI/study-buddy/dist`. During diagnosis build candidates into `review/`, not over that reference. Check hashes when comparing releases.
- Deployed backend: `study-buddy-backend-1` on diamondserver. Inspect the running image/bundle before claiming deployment state. The server source copy has an older frontend and is not the publication source for the extension.
- No tokenizer: do not reintroduce tokenizer dependencies or vocabulary assets. Current estimation is approximate UTF-8 bytes / 4.
- Maintained checks are in `.github/workflows/ci.yml` and `docs/demo.md`. `npm run verify` is the current composed UI smoke. `scripts/archive/*.txt` is historical reference only.
- Use isolated browser profiles and local provider fixtures for automated checks. Existing-build verification supports `npm run verify -- --extension-dir /absolute/path/to/dist`; it preserves artifact bytes and redirects the gateway inside the test browser.
- Keep `CURRENT-STATE.md` and its evidence current when publishing a different artifact. Preserve the approved prompt contract in `docs/prompts-review-stage4.md`.
