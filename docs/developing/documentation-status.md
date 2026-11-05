# Documentation status and verification

## Baseline and scope

The first documentation release describes application revision `58198ba` on `main`, inspected on 2026-11-03. Documentation-only commits after that revision do not change the runtime baseline.

The docs provide separate user, operator, and contributor paths. The complete system map is in [architecture](architecture.md#feature-map). Detailed first-release guides cover account creation, adding books, browsing, collections/sharing, and reading/progress. Other feature guides remain linked for later expansion.

## Document organization

The documentation root contains the home page. User procedures live in `using/`; operator guides live in `hosting/`; architecture and contributor setup live in `developing/`. Current feature contracts and UI notes have separate `developing/reference/` and `developing/ui/` indexes.

The [archive](../archive/README.md) preserves prior design, repair, issue, and icon-generation notes. The duplicate series-cover note is consolidated into [browse cards](ui/browse-cards.md#series-list-cards-covers). Archiving preserves the historical claims rather than declaring every reported defect resolved.

## Evidence levels

- **Source inspected** means the implementation path was read. It is not a claim that the feature passed in a running app.
- **Demo exercised** means the documented action ran against the isolated local application with synthetic accounts and books.
- **Live verified** would require the named provider, deployment, device, or storage environment. The first-release demo does not provide that evidence.

The checks below ran in a separate disposable checkout. The normal checkout's environment files, database, and library were not used by the demo.

## Verification results

| Check                                                                | Result and scope                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile --offline`                           | Passed with the pinned pnpm and existing local package store                                                                                                                                                                                                                                                         |
| `pnpm prepare:nuxt` and `pnpm --filter @delb/epub build`             | Passed in the disposable checkout                                                                                                                                                                                                                                                                                    |
| `DATABASE_URL=file:./review/demo/docs-migrations.db pnpm db:migrate` | Passed against a fresh, separate local database                                                                                                                                                                                                                                                                      |
| `node review/setup-demo.mjs` and `node review/start-demo.mjs`        | Passed; synthetic database/EPUB, disabled Dropbox, loopback server, outbound guard                                                                                                                                                                                                                                   |
| `node review/http-smoke.mjs`                                         | Passed registration/upload/listing, guest/visibility rejection, and Unicode/percent download filename checks                                                                                                                                                                                                         |
| Focused local HTTP checks                                            | Passed viewer visibility and rename rejection, per-user status/position isolation, Finished/manual progress, same-session position ordering, retained re-sharing access, collection deletion preserving books, supplied-record metadata mapping, status/file filters, global search, and quick/deep health responses |
| Browser walkthrough                                                  | Exercised registration, upload, manual creation, book listing, global search results, collection creation/member saving, status change, EPUB opening/page navigation/TOC, reader settings opening, and Escape return                                                                                                 |
| Reader persistence                                                   | A subsequent API read confirmed a CFI and percentage saved by browser navigation; cross-device restoration and every reading mode were not exercised                                                                                                                                                                 |
| Documentation assets                                                 | Four screenshots captured and inspected at 1280 by 800 with synthetic data; three Mermaid diagrams describe runtime, records, and upload coordination                                                                                                                                                                |
| `pnpm docs:check`                                                    | Passed local inline file/image links and heading anchors; an intentional missing file and heading both produced failure before the probe was removed                                                                                                                                                                 |
| Formatting and checker lint                                          | `pnpm exec prettier --check README.md GLOSSARY.md docs scripts/check-docs.mjs package.json .github/workflows/test.yml` and `pnpm exec eslint scripts/check-docs.mjs` passed                                                                                                                                          |

Only documentation, its link checker, the package command, and the CI check change in this release. Application typecheck, full unit/integration suites, production build, and Docker build were not rerun for these documentation changes.

The offline demo reported unavailable external font providers and fallback icon requests. Core actions above completed, but these screenshots are not production styling evidence. See [screenshot provenance](../images/README.md).

## Reading-status cover menu verification

Issue #31 adds status changes to grid, list, and dashboard cover menus. `node review/book-status-browser.mjs` exercises the real local API and synthetic database. It checks all status choices, current-choice marks, date transitions, filtered-result removal, failed saves and retry, dashboard refresh, existing EPUB downloads, unavailable status reads, and bulk selection mode. Browser request interception supplies the failure cases. The check uses its own headless Chromium profile and no real library data.

The change passed the full 237-test suite, typecheck, production build, documentation links, and lint. Lint retains one existing `BookDescriptionEditor.vue` warning. Physical touch devices, assistive technology, and other browser engines were not exercised.

## Personal To be read queue verification

Issue #32 adds a private queue across all accessible collections, row reordering, and rationale editing shared with book details. The queue follows the series detail layout. The ordinary Books filters and series page retain their behavior.

`server/utils/books/tbr.test.ts` runs real production migrations against disposable SQLite databases. It covers upgrade and restart, 63-book ordering, deduplication, reader isolation, note retention, single/bulk status changes, rollback, and loss/restoration of access without an intermediate read.

`review/tbr-editor.test.mjs` compiles the real editor and queue page with Vue's custom renderer. It checks failed-save draft retention, retry, cancellation, load retry, and a delayed reorder refresh racing with a successful rationale save. These are component checks with simulated network responses, not browser or device evidence.

`review/tbr-api.mjs` runs in the isolated production API suite with synthetic accounts and books. It checks authentication, full queue/global dashboard counts, private notes, malformed input, numeric moves, failed-write rollback, status changes, and real membership revocation/restoration.

The full unit/component suite, typecheck, production build, documentation links, and API regressions passed. Lint retains one existing `BookDescriptionEditor.vue` warning. Mouse/touch dragging, responsive layout, assistive technology, and other browser engines remain manual verification items.

## Reconciled documentation drift

| Earlier description                                            | Current source evidence                                                                                                                                           | Documentation treatment                                                                        |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Appearance uses `activeSettings.theme` and a single theme name | [Theme preference](../../app/utils/themePreference.ts) has fixed/system modes and light/dark slots                                                                | Updated [settings explanation](reference/settings.md)                                          |
| Metadata backend mapping is marked pending                     | [Create handler](../../server/api/books/metadata-import/create.post.ts) resolves authors, tags, publisher/series, and covers                                      | Updated [metadata reference](reference/metadata.md); live provider claims remain separate      |
| Collection editor book membership is described as future work  | [Single-book](../../server/api/books/[id]/collections/index.put.ts) and [bulk](../../server/api/collections/[id]/books/bulk.post.ts) handlers enforce edit rights | Updated [layout](reference/library-layout.md) and [access reference](reference/collections.md) |
| Health checks are described as planned                         | [Admin handler](../../server/api/settings/admin/health.post.ts) implements quick/deep checks                                                                      | Updated [health reference](../hosting/health-checks.md) and README navigation                  |
| Reader font/theme controls are listed as future work           | [Reader page](../../app/pages/books/[id]/read.vue) contains current controls                                                                                      | Updated [reader reference](reference/epub-reader.md)                                           |

## Product questions and evidence limits

Visibility through another accessible collection survives removal from the original shared collection. The code implements that rule; earlier documentation treated the long-term re-sharing policy as unresolved. This release describes the current rule without claiming the product-policy question has been settled.

The Add book UI includes Personal. APIs also accept explicit target lists and fall back to Personal when no list is supplied. The docs do not generalize the UI invariant to every API caller.

The manual-entry dialog describes saving, while the blank editor's action is labeled Create. The user guide names the actual button. Progress sync can also restore from the latest logged percentage after EPUB location generation; the reading guides distinguish this from merely storing a position.

Local demo evidence does not prove live Google Books or Hardcover behavior, production email delivery, Docker publishing, Unraid/network filesystem behavior, touch/assistive-technology support, or production restore reliability.

## Dashboard shelves, 2026-11-04

Issue [#35](https://github.com/lancewilhelm/delb/issues/35) implements the selected D dashboard with Continue reading and Recently read. Runtime revision `579c23d` retains the quiet count strip, two underline tabs, and the reading-status menu merged in `654d776`. Book favorites are deferred. This change has no schema migration.

- `pnpm test` passed 244 tests. Focused SQLite and Vue checks cover collection scope, private reading history, paging, date-only serialization across server and browser timezones, stale responses, retry behavior, and cover-menu refresh. The query fixtures have no favorites or preference tables.
- `pnpm typecheck` and `pnpm build` passed. `pnpm lint` passed with the existing optional-prop warning in `BookDescriptionEditor.vue`.
- Production API checks cover authentication, invalid input, collection visibility, deduplication, finish-date order, per-reader history, and access revocation. They also check that the removed favorites shelf and endpoint are unavailable. The dashboard suite is included in `pnpm test:integration`.
- A headless Chrome walkthrough exercised the built application with a separate browser profile and synthetic accounts. Exactly two tabs, no favorite controls, shelf switching, keyboard wrapping, read-date order, reload persistence, stable counts, and a phone-width layout passed.
- Desktop and phone screenshots were captured and inspected at 1280 by 900 and 390 by 844. [Screenshot provenance](../images/README.md) distinguishes these from the earlier documentation images.
- The earlier Standards finding about the verification record and the Spec finding about calendar dates remain addressed.

This is local synthetic API and browser evidence. Physical touch, assistive technology, other browsers, live providers, and Docker were not exercised.

## Next documentation passes

Expand dedicated guides for appearance/mobile profiles, metadata editing/provider administration, Calibre migration, Dropbox claim/failure handling, health-check remediation, and deployment-specific restore drills. Keep those passes tied to code and named verification environments.
