# omocop-swarm — working notes for Claude

A local archive of Foursquare/Swarm check-ins, exposed over MCP and a CLI. The archive is the point: `docs/rationale.md` explains why the raw JSONL is authoritative and SQLite is a cache. Read it before changing how anything is stored.

## Commands

- `npm run verify` — lint + typecheck + tests + stdio smoke test. The bar for every change.
- `npm run typecheck` uses `tsconfig.typecheck.json` (includes `test/`); `npm run build` stays plain `tsc` emitting only `src/`.
- `npm run auth` — the local sign-in server; one of only two things that read `.env`.
- `npm run inspect` — MCP inspector against the built server.

## Invariants — violating any of these is a bug

- stdout is the MCP transport. No `console.*` outside `src/logging.ts` and its test (eslint-enforced); `installStdoutGuard()` catches dependencies; `scripts/smoke.mjs` proves it against a real process.
- **The raw JSONL is the archive. Everything else is derived.** Nothing may edit or delete a line. Anything reconstructible by `reindex` may be thrown away; anything not in the raw files is gone forever.
- Raw is written *before* the index, and state *after* it. Any other order loses a page on a crash. See the ordering note in `docs/rationale.md`.
- `defineTool` is the whole design. Tools declare name, description, requirement, zod input/output shapes, optional policies, a handler, a renderer. The harness does the requirement gate, policies, error translation and result wrapping. A handler growing preamble means the harness is missing a feature.
- Handlers return data; `render` derives the prose from it. Never hand-build both.
- `sync` is the only tool that may declare `requires: 'api'`. `test/tools/surface.test.ts` asserts it. This project is read-only against Foursquare by decision, and that test is how the decision is enforced.
- `domain/` stays pure. No imports from `foursquare/`, `store/`, `server/`, `tools/`; no I/O. That is what makes its decisions table-testable.
- `normaliseCheckin` may throw only for a missing `id` or `createdAt`. Everything else is read defensively. One unrecognised field must never stop a sync mid-decade.
- Never log or embed the token. `redact` runs inside the logger; `sanitizeUrl` runs before any URL enters a thrown error, because errors never pass through the logger.
- Every column people search by is stored twice: the original for display, a `*_fold` copy for matching. `domain/text.ts` owns the folding, `compileFilter` folds the value, and the two must always be paired — a LIKE against an unfolded column with a folded value matches nothing at all. Never display a `_fold` column.
- The undocumented paging parameters (`afterTimestamp`, `beforeTimestamp`, `sort`) are probed and cached per API version, never assumed. Every one has an offsets-only fallback.

## Traps

- **The MCP server does not read `.env`.** It is launched by its client, so it has no shell environment. `omocop-swarm auth` writes `token.json` into the archive directory and the server reads it there. `.env` feeds `npm run auth` and the CLI only. This is the most common setup failure for any MCP server; keep the docs saying it.
- The CLI is a second adapter over the same registry and `runTool` harness. Behaviour must never fork between the MCP and CLI surfaces. CLI stdout is a product surface (the eslint `no-console` exemption covers `src/cli/` only); the stdout guard stays uninstalled there.
- `local_ts` is a wall clock encoded as seconds, not an instant. It exists to be compared against other wall clocks. Handing it to anything expecting a real timestamp is a bug that looks like a timezone bug.
- V8 `Date` ISO parsing rejects out-of-range months with NaN but silently rolls an out-of-range day over (Feb 30 becomes Mar 2), so a NaN check does not validate a date. `domain/time.ts` round-trips instead.
- The default sort is newest-first and cannot be inverted without `sort=oldestfirst`. Catch-up therefore always walks down from the top; there is no "start where I left off and go forwards".
- `compileFilter` joins clauses with AND and adds no brackets of its own, so any clause containing an OR must bracket itself. The coordinate filter does. A new one that forgets will silently widen every query it appears in.
- FTS5 throws on a stray quote or a leading `-`. `ftsQuery` turns free text into quoted terms; do not pass user input to MATCH directly.
- `test/support/fake-foursquare.ts` implements the endpoint's real paging rules on purpose. Do not weaken it to make a test pass; the paging logic is what it exists to catch.
- The schema has no migrations by design: bump `SCHEMA_VERSION` and the index is dropped and rebuilt from the raw JSONL. That is only safe because the raw files are authoritative, and it means every schema change costs the user one `reindex` (2s for ~5k check-ins).
- `checkin_categories` and `checkin_companions` exist and are essentially empty of signal: v2's checkins response carries exactly one category per check-in (verified across a full real archive) and `with` is vanishingly rare. Do not build features on them without checking the data first.
- `better-sqlite3` is a native module. It has prebuilds for Node 22 on Windows, so no build toolchain is needed, but a Node major-version change means a reinstall.
