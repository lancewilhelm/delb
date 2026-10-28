# Security and performance review fixtures

This file records the earlier four-fix review. The subsequent full-repository audit and completed repair verification are in [the audit repair record](audits/2026-10-27/repair-verification.md). Statements below about unchanged reader settings, dependency counts, and publishing scope describe that earlier review.

This branch proposes four bounded fixes from baseline `dd7a0fcbc4d1e0e51a6b98a36b10ef06b2ee0d1e`. The EPUB reader's scripting configuration is unchanged pending compatibility tests. These fixtures use synthetic data and are not a deployment configuration.

## Candidate changes

| Change                             | Implication                                                                                                                         | Compatibility and coverage                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared description sanitizer       | Unsupported wrappers previously moved unsanitized children into `v-html`; nested event handlers and executable links could survive. | Children are now sanitized before unwrapping. Basic formatting and safe links remain; inline styles and embedded SVG/MathML are removed. Structural DOM regressions pass. Native browser parser/security coverage remains pending; this limited repair is not a comprehensive XSS audit.      |
| Cover-response deadline            | A remote cover source could deliver headers and then stall the body after the timeout had been cleared.                             | Timeout now covers body consumption; requests are aborted and redirect bodies canceled. Mocked stalled bodies, normal images, oversized images, and redirects are tested without outbound requests. Slow legitimate covers may now time out. DNS lookup and DNS pinning remain separate work. |
| Explicit publication-date backfill | The book-list GET handler ran an UPDATE on every request.                                                                           | The read handler no longer performs maintenance writes. A local-file-only task preserves the SQL and is tested with disposable SQLite. Existing libraries need an explicitly authorized one-time backfill before relying on normalized publication sorting.                                   |
| Conditional cover reads            | Matching ETags returned 304 after reading image bytes unnecessarily.                                                                | Authorization and metadata checks remain; bytes are read only when needed. A temporary-file regression proves zero reads for 304 and one for a normal response. Production speedups have not been measured.                                                                                   |

## EPUB compatibility question

Both reader modes enable book scripts. Installed epubjs combines `allow-same-origin` and `allow-scripts`, normally with `srcdoc`; malicious imported/shared book content may therefore access the application origin. Exploitability has not been tested here.

History shows that `fa25a75` disabled scripts and stripped scripted content, while `7606b6f` restored scripts and removed stripping hooks during settings/theming work. That commit does not document which rendering failure required the change. Host-side event/link hooks and themes are separate from optional book-script injection, but source inspection alone does not establish compatibility.

Do not disable scripts based only on the Node tests. Compare ordinary EPUBs in pages and scroll modes with scripting on/off, including page turns, TOC, themes/fonts, content hooks, location generation, and saved-location restoration. Removing same-origin access alone would interfere with epubjs's document access. If scripting is required, separate-origin reader isolation is a larger architecture/hosting option that this branch does not implement.

## Validation scope

The public-branch suite passed 39 tests: existing EPUB, cover transaction, and theme tests plus the new review and isolation cases. Four baseline defects were reproduced as failing assertions. Native-browser sanitizer tests and script-disabled reader compatibility were not completed; baseline reader functionality does not validate either change.

Nuxt preparation, workspace EPUB compilation, and real loopback API smoke tests succeeded with a fresh synthetic account/book. Package typecheck passed. Application vue-tsc exited successfully but reported an installed route-plugin initialization warning, so that coverage is incomplete. Full repository lint reported no errors and one existing optional-prop warning. Production/Docker build, runtime SSRF tests, real-user authorization matrices, and production performance benchmarks were not run locally.

`pnpm test:review` also tests that demo setup refuses environment files, nonempty storage, and an existing disposable database. CI runs that suite in addition to the repository's existing checks.

## Cloud or local setup

Use Node 22.22.3 or a supported newer LTS and the package-manager version pinned in `package.json`. Start with a **fresh dedicated checkout**, no environment files, and no real data/storage. Do not copy credentials, a database, or books from another installation. Dependency installation uses the repository's pinned lockfile and package scripts.

```sh
pnpm install --frozen-lockfile
pnpm prepare:nuxt
pnpm --filter @delb/epub build
pnpm test:review
pnpm test:theme
pnpm test:epub
pnpm test:cover-transaction
pnpm typecheck
pnpm lint
```

Optional baseline comparison and native-browser fixtures:

```sh
# If using a shallow clone, retrieve only the pinned public baseline first:
git fetch origin dd7a0fcbc4d1e0e51a6b98a36b10ef06b2ee0d1e
node review/prepare-baseline.mjs
REVIEW_BASELINE=1 node --test review/regressions.test.mjs
# Expected: four failures documenting the baseline defects.
node review/setup-demo.mjs
node review/build-browser-tests.mjs
ln -s ../review/demo public/__review
node review/start-demo.mjs
```

The demo initializes only `review/demo/synthetic.db`, disables ingestion there, generates an ordinary two-chapter EPUB, and copies installed browser libraries locally. It refuses to run setup over existing storage or a database. The launcher refuses environment files, requires the synthetic setup marker, uses a small explicit child environment and a newly generated test auth secret, blocks outbound fetch/socket connections, and binds only `127.0.0.1:4317`. The network guard is a test-process helper, not an OS sandbox for hostile code. Keep any cloud-browser tunnel private; these fixtures are not intended for public hosting.

In another terminal:

```sh
node review/http-smoke.mjs
```

This exercises guest rejection, synthetic registration/upload, book listing, and personal collection listing. Passwords/cookies remain in memory. Use a new disposable checkout for each setup/smoke run rather than applying cleanup commands to a real installation.

Browser pages:

- `http://127.0.0.1:4317/__review/descriptions.html`: eight native-DOM sanitizer comparisons. Payloads are inspected as strings, never inserted into the page or clicked.
- `http://127.0.0.1:4317/__review/reader.html`: library-level pages/scroll comparison with scripts on/off, navigation, themes, hooks, and locations. It does not test authenticated progress persistence.

Generated databases, books, browser bundles, baseline copies, logs, and fixture-serving links are ignored. The branch does not change the main/release-only container-publishing workflow and does not deploy anything.

## Maintenance task

The candidate backfill intentionally has no default database and refuses remote URLs. Before using it on an existing library, arrange an authorized backup and maintenance window. In a disposable test environment the command is:

```sh
DATABASE_URL=file:./review/demo/synthetic.db node --import tsx scripts/backfill-published-at.ts
```
