# Audit repair verification

The original [audit report](report.md) records the baseline. This document records the implementation and verification that followed. All application checks use disposable synthetic accounts, databases and EPUBs. No production library was modified.

## Coverage and limits

| Surface                       | Verification performed                                                                                                                                         | Remaining limits                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Authentication and visibility | Live HTTP tests with separate users, foreign book IDs, bulk and single assignment, search, entity details, ratings and owner mutations                         | No external identity-provider test                                                                       |
| Owner bootstrap               | Live fresh-database concurrent signups and durable completion after synthetic owner removal                                                                    | No automatic owner transfer; deletion and demotion are denied                                            |
| Metadata and status           | Live rollback injection, duplicate identities, imports, rating values, cursor traversal, concurrent status changes and contiguous ranks                        | Existing historical bad ratings and metadata are not guessed or rewritten                                |
| Files and recovery            | Automated failure injection, process termination, restart reconciliation, matching and differing copy cases                                                    | No power-cut, real Unraid union-filesystem or storage hardware failure test                              |
| Reader                        | Real browser upload, pages and scroll modes, untrusted script marker, exact displayed CFI saved on rapid exit                                                  | No mobile device, every EPUB variant, or browser-termination delivery guarantee                          |
| Client ownership              | Deferred responses for list/grid/search, delayed location generation, settings merge and account reset tests                                                   | Source harnesses exercise extracted application code; they do not replace every full browser interaction |
| Accessibility                 | Native browser keyboard activation, named range controls, selected search/palette result IDs and dialog focus containment                                      | No assistive-technology or screen-reader certification                                                   |
| Remote images                 | Real controlled DNS/HTTP transport tests, selected-IP connection, redirects, mapped/private addresses, SVG rejection, raster decode, deadlines and byte limits | Synthetic transport targets; no arbitrary public provider availability claim                             |
| Upload/archive bounds         | Real HTTP 413/408 before EOF, file bounds and crafted ZIP inflated-size checks                                                                                 | Not a full memory stress test or aggregate concurrent request quota                                      |
| Entity indexes                | SQL pagination, per-entity preview bounds, privacy, accented and literal search tests                                                                          | No claimed latency or memory speedup; representative production load remains unmeasured                  |
| Dependencies and runtime      | Frozen install, advisory scan, complete test runner, typecheck, lint and production build                                                                      | One low advisory remains in Nuxt tooling; no available patched deepmerge version                         |
| CI and publishing             | Publishing depends on the reusable verification job for the triggering revision; production API checks are included                                            | GitHub-hosted results are separate from local checks; local Docker daemon unavailable                    |
| Container context             | Explicit exclusions for credentials, runtime data, Calibre and review fixtures; static workflow review                                                         | Actual Docker context/build is delegated to CI                                                           |

## Reproducible commands

Run these from a fresh checkout with the Node version in CI and no real library or `.env` files.

```sh
pnpm install --frozen-lockfile
pnpm prepare:nuxt
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:integration
```

`pnpm test` discovers application, server, EPUB and review regression tests. `pnpm test:integration` creates separate temporary production databases for bootstrap and API tests, starts only its own loopback server, then removes its own fixtures. It refuses an occupied port 4317. It requires the production build first.

The native Chrome driver is [browser-regression.mjs](browser-regression.mjs). It requires the isolated demo server, a Chrome debug endpoint on 9231, and the harmless script-marker EPUB produced by `node review/audits/2026-10-27/prepare-browser-fixture.mjs` after demo setup. Its [recorded results](browser-results.json) are live browser evidence. Temporary public fixture links are removed before the production build.

## Independent review dispositions

Two review seats examined the integrated changes, followed by focused reviews of storage and web boundaries. Their material findings led to these additional repairs.

- Recovery journals are initialized and synced under preparation names before publication. Recovery never sees an uninitialized operation directory.
- A busy live mutation makes startup recovery retry; it does not permanently poison readiness.
- Verified matching copy leftovers can roll back or finalize. Differing uncommitted copies retain both files, the journal and an actionable failed-move marker, while allowing unrelated requests to proceed.
- Same-path cover updates record the database decision. A matching backup copied before an interruption is reconciled safely.
- Reader saves carry a session sequence. An older request from that session cannot overwrite a later CFI. Saving a CFI without a computed percentage preserves the previous percentage.
- A settings pull preserves concurrent local edits. Millisecond timestamp storage orders rapid edits without advancing the clock by seconds per event. Push acknowledgement guards prevent old replies from marking newer state saved. Rejected writes rebase changed fields onto the returned remote record and retry up to two times; a delayed GET cannot replace an acknowledged newer revision. Persisted timestamp strings are normalized after reload.
- Initial process-identity lock ownership was rejected because container recreation and PID reuse can strand ownership. The final lock design is documented in the storage recovery guide.

The installed `deslop`, Cursor UI-control and Comment Sicko integrations were unavailable. Direct diff review, ESLint/Prettier, native Chrome CDP and independent reviewers supplied the applicable checks. No claim of executing those unavailable integrations is made.

## Principles applied

| Principle                                | Choice it changed                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Model the Domain                         | Storage journals and transaction decisions encode recovery phases rather than scattered cleanup guards.             |
| Boundary Discipline                      | HTTP body and remote-image validation run before parsers or canonical mutations.                                    |
| Type System Discipline                   | Shared status transitions and explicit journal/claim shapes carry invariants between callers.                       |
| Separate Before Serializing Shared State | Independent workers used separate worktrees; only same-book mutations share a lock.                                 |
| Sequence Work into Verifiable Units      | Ordered commits keep authorization, storage, client, transport and tooling repairs reviewable.                      |
| Attack the Premise                       | Failed ownership and timestamp designs were replaced after direct process and persistence evidence challenged them. |
| Test Behavior, Not Implementation        | Tests assert bytes retained, visible records, stored values and selected keyboard results.                          |
| Prove It Works                           | Production startup, live HTTP, native Chrome and process-kill checks supplement static review and unit tests.       |
