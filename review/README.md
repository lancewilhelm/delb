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

This exercises guest rejection, synthetic registration/upload, book listing, and shared default collection listing. Passwords/cookies remain in memory. Use a new disposable checkout for each setup/smoke run rather than applying cleanup commands to a real installation.

Browser pages:

- `http://127.0.0.1:4317/__review/descriptions.html`: eight native-DOM sanitizer comparisons. Payloads are inspected as strings, never inserted into the page or clicked.
- `http://127.0.0.1:4317/__review/reader.html`: library-level pages/scroll comparison with scripts on/off, navigation, themes, hooks, and locations. It does not test authenticated progress persistence.

Generated databases, books, browser bundles, baseline copies, logs, and fixture-serving links are ignored. The branch does not change the main/release-only container-publishing workflow and does not deploy anything.

## Maintenance task

The candidate backfill intentionally has no default database and refuses remote URLs. Before using it on an existing library, arrange an authorized backup and maintenance window. In a disposable test environment the command is:

```sh
DATABASE_URL=file:./review/demo/synthetic.db node --import tsx scripts/backfill-published-at.ts
```

## Tag feature checks

`pnpm test` covers all four book sort keys in both directions across SQLite page boundaries. It also checks tag merge overlap, hidden book links, transaction rollback, repeated deletion, and concurrent merge requests. `pnpm test:integration` runs the tag API suite against a fresh production server and disposable database, alongside the existing API regressions. Its sort matrix covers Books, tags, authors, and publishers, including collection visibility.

The tag API checks confirm that only system admins and owners can delete or merge tags. They verify library-wide changes, including books outside the selected collection, while preserving every book. They also cover malformed requests, inaccessible tags, and literal destination searches containing `%`, `_`, or `\`.

For browser verification, use a fresh dedicated checkout and the synthetic setup described above. Build the app, then start `node review/start-demo.mjs --production`. In a separate terminal, run `node review/tag-features-api.mjs` once to create the synthetic accounts and books. Start Chrome with an isolated profile and `--remote-debugging-port=9232`, then run `node review/tag-features-browser.mjs` from the checkout root. The browser script signs in using synthetic session cookies and never uses your normal browser profile. Keep the server running between the API and browser checks because restarting it changes the test authentication secret.

The browser checks exercise grid and list sorting on tag, author, and publisher pages. They verify cursor-position context menus, left-aligned actions, keyboard card actions without dropdown buttons, confirmation focus, the empty and selected merge preview, delete and merge navigation, viewport-edge menu placement, ordinary-user controls, and delayed header responses. The runner saves the standard theme for its synthetic owner account before taking screenshots. The browser fixture tags are reset before each run. Results, screenshots, and synthetic credentials remain in `.audit/`; do not commit that directory. Exclude `.audit/**` when running lint in a checkout containing browser profiles.

Deleting a tag removes its links from every book. Merging moves those links to an existing destination tag and deletes the source tag in one transaction. Both actions require confirmation. A later metadata edit or import can recreate the old tag name.

## PDF reader checks

`pnpm test:integration` includes `review/pdf-reader-api.mjs` against a fresh disposable production server. It verifies PDF upload/download bytes, MIME, authentication, collection visibility, file selection, private ordered positions, opt-in history sync, and access revocation.

For browser checks, use the synthetic setup above, run `pnpm build`, and start `node review/start-demo.mjs --production`. In another terminal run `node review/pdf-reader-browser.mjs`. It creates a synthetic PDF, malformed PDF, ordinary EPUB, and a multi-format fixture. It launches Chrome with a temporary profile, verifies page rendering/navigation/resume, phone-width fit, local PDF.js assets, failed-save retry, an inert script probe, and EPUB navigation/TOC after format switching. Results and screenshots are saved in a printed temporary evidence directory. Set `CHROME_BIN` for another Chrome executable or `DELB_REVIEW_URL` for another loopback demo port. It does not use your normal browser profile or library.

## Book reading-status menu checks

Use the disposable demo setup above, build the app with `pnpm build`, and start `node review/start-demo.mjs --production`. In a second terminal at the same checkout, run:

```sh
node review/book-status-browser.mjs
```

The runner starts its own headless Chrome with a temporary profile. On macOS it uses the standard Google Chrome application path. Set `CHROME_BIN` to the Chrome or Chromium executable on other systems. `DELB_REVIEW_URL` can select another loopback demo port.

The checks create a synthetic account, a reference-only book, and 180 synthetic books for scrolling and pagination checks. They exercise all five status choices in the grid, status changes in the list, filtered-result removal, pending and failed saves, retry, dashboard refresh, existing EPUB downloads, failed status reads, and bulk selection mode. They also check deep scroll in both views, filtered removal without a reload, continued cursor pagination, badge settings persistence, theme colors, and all badge states. Use `--scroll-only` to skip the original menu checks. Results and menu screenshots are saved under `review/demo/` and ignored by Git. Session cookies and passwords stay in memory. These checks use the real local status API and database. The simulated save failure uses browser request interception.

## Exclusive collection checks

After `pnpm build`, run `pnpm test:integration` for isolated production API checks. The runner creates and removes its own synthetic database and storage for each suite; port 4317 must be free. It does not use the normal checkout's database, environment files, or books. Run only the collection suite with:

```sh
node review/run-api-regressions.mjs review/collections-api.mjs
```

This checks one-time default enrollment, zero-membership sign-in, membership-based browsing and editing, atomic moves, owner/account lifecycle, prospective default changes, advisory duplicates, synthetic Calibre import/rescan with mid-batch access revocation, local Dropbox claim recovery and permission failures, and the real administrative migration endpoints. Migration fixtures include legacy multi-linked books; source files and reading history are checked after splitting. Unit tests also cover interrupted copy recovery, same-name files from different directories, required ownership, and private TBR order and rationale.

For a headless Chrome walkthrough against a fresh isolated production server:

```sh
node review/run-api-regressions.mjs review/collections-browser.mjs
```

Chrome uses a temporary profile. On macOS the runner uses the standard Google Chrome application path; set `CHROME_BIN` elsewhere. It checks confirmed moves and revoked access, default selection from picker settings for browsing and Add book, cancellation at both deletion warnings, required collection-name confirmation, populated deletion, viewer restrictions, zero-membership collection creation, migration choices and backup confirmation, phone-width layout, and unhandled browser exceptions. Screenshots and results go to a printed temporary evidence directory. These are synthetic loopback checks; live metadata providers, network storage, Docker, and deployment restore drills require separate verification.

For manual exploration, use the reusable synthetic demo described above. Register an owner and a second reader in separate browser sessions. Both should see **Default**. Create another collection and add both readers as editors. Upload `review/demo/ordinary.epub`, move it using **Move collection**, and confirm the source access warning. Its ID and reading history should stay the same. Remove the second reader from all collections and sign in again: the library should stay empty, and Add book should offer choosing or creating a collection. As the owner, choose another default in **Settings > Admin > Collections** and register a third reader: only the new account should join the new default automatically.

For the collection settings follow-up, sign in as the system owner in the synthetic demo. In the collection picker, open a collection's settings and select **Make default**. Reload and open Add book; both should select that collection. Create a separate disposable collection with a test EPUB. Open its settings, expand **Collection actions**, and choose **Delete collection**. Cancel each warning once and verify the book remains. Repeat, continue to the final warning, type the collection name, and select **Delete collection and books**. The collection and book should disappear. A current default must be replaced before it can be deleted.
