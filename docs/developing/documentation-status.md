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

The initial change passed the full 237-test suite, typecheck, production build, documentation links, and lint. Lint retains one existing `BookDescriptionEditor.vue` warning. Physical touch devices, assistive technology, and other browser engines were not exercised.

The scroll-preservation follow-up first reproduced a status save moving the grid from scroll position 2200 to 0. After the fix, the same browser harness passed deep-scroll checks in grid and list views, both unfiltered and status-filtered, without refetching book pages. Continued cursor pagination also passed. Badge checks covered the default-off toggle, persistence, live status updates, theme accent color, and clearing the badge. The settings-store test covered independent desktop and mobile choices. The follow-up passed 243 tests, typecheck, lint with the same existing warning, production build, and documentation links.

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

## Next documentation passes

Expand dedicated guides for appearance/mobile profiles, metadata editing/provider administration, Calibre migration, Dropbox claim/failure handling, health-check remediation, and deployment-specific restore drills. Keep those passes tied to code and named verification environments.
