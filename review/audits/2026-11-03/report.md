# Delb review — 2026-11-03

The review found two reproducible download reliability bugs and one duplicate
test execution. All three are fixed on this branch. No new critical or high
security vulnerability was confirmed in the inspected surfaces.

Baseline: `1895d22890a46deb3385df585948b991eb8fe0fe` (merged PR #25).
GitHub had no open issues or PRs at review start. The canonical checkout remained
on its existing branch; changes and synthetic fixtures use a separate worktree.
No live database, library, credentials, or deployment was modified.

## Findings

### DELB-01 — Medium: Unicode titles prevent file downloads

- Evidence: baseline `server/api/books/[id]/download.get.ts:177-188` interpolates
  the book title into a raw quoted `filename` header. Running Node's actual
  `validateHeaderValue` with `日本語の本.epub` or `Reading 📚.epub` throws
  `ERR_INVALID_CHAR`; the error occurs before streaming begins.
- Impact: users cannot download otherwise valid books with these titles.
- Fix: `server/utils/books/download-disposition.ts:1` emits an ASCII fallback
  and a percent-encoded UTF-8 `filename*`, sanitizing filename separators and
  controls. Lone surrogates are replaced before encoding. The route's existing
  format, membership and cache checks remain in place.
- Checks: all four supported extensions, Unicode, emoji, accents, punctuation,
  controls, an empty title and malformed Unicode; real production HTTP download
  of a renamed EPUB, with exact original byte comparison.

### DELB-02 — Medium: percent signs break or silently change client filenames

- Evidence: baseline `app/components/BookThumbnail.vue:140-149`,
  `app/components/Books/BooksListRow.vue:163-172`, and
  `app/pages/books/[id]/index.vue:1027-1036` URI-decode plain `filename` values.
  Executing the extracted original expressions gives `URIError` for
  `100% done.epub` and changes `Literal%20title.epub` into `Literal title.epub`.
  Their single regex also selects whichever parameter occurs first rather than
  preferring `filename*`.
- Impact: grid, list and detail downloads can fail after fetching the complete
  file or save it under the wrong name.
- Fix: all three consumers call `app/utils/downloadFilename.ts:1`. It prefers
  UTF-8 `filename*` in either order, decodes only that parameter, and falls back
  safely when it is malformed. Plain names retain literal percent sequences.
- Checks: both parameter orders, quoted semicolons, quoted escapes, malformed
  percent/UTF-8 values, unsupported encodings, missing names, and literal `%`.

### DELB-03 — Low: main test discovery executes remote-image tests twice

- Evidence: baseline `review/regressions.test.mjs:1` imports
  `external-image.test.mjs`, while `scripts/test.mjs:21-28` discovers both files.
  The baseline TAP log contains the same three transport tests twice, including
  two copies each of the ten-second body and DNS deadline cases.
- Impact: redundant test processes and controlled socket/DNS work. No production
  performance improvement or wall-clock speedup is claimed.
- Fix: remove the cross-test import and explicitly include the transport file in
  `package.json`'s dedicated `test:review` command.
- Checks: `pnpm test` runs each transport case once; `pnpm test:review` still
  runs all three cases.

The header behavior follows [RFC 6266 §4.3](https://www.rfc-editor.org/rfc/rfc6266#section-4.3)
and [RFC 8187 §3.2.1](https://www.rfc-editor.org/rfc/rfc8187#section-3.2.1).

## Validation

| Check | Result |
| --- | --- |
| Frozen install | PASS, 1,075 packages reused from the existing local cache; no downloads |
| `pnpm prepare:nuxt` | PASS |
| `pnpm test` | PASS, 235 tests, zero failures/skips |
| `pnpm test:review` | PASS, 10 tests, including the transport cases |
| `pnpm typecheck` | PASS, EPUB package and Nuxt |
| `pnpm lint` | PASS, zero errors; one pre-existing optional-prop warning in `BookDescriptionEditor.vue:8` |
| `pnpm build` | PASS |
| `pnpm test:integration` | PASS, disposable production bootstrap/API suites; Unicode and percent filenames, exact EPUB bytes, guest 401 and unrelated-user 404 |
| `pnpm run dev --host 127.0.0.1 --port 4317` | PASS startup and synthetic browser registration, using a fresh secret and disposable database |
| Native Chrome download interactions | INCOMPLETE: browser control was interrupted during synthetic file upload; grid/list/detail download clicks were not verified |
| Local Docker | BLOCKED: `docker info` could not access `unix:///Users/lancewilhelm/.docker/run/docker.sock` (`permission denied`); no container build attempted |

The initial sandboxed baseline test run had three socket-listen `EPERM` failures
(including the duplicated transport case). The complete changed suite passed
with loopback access. These were environment failures, not newly fixed defects.

## Review coverage and limits

Inspected authorization/bootstrap, collection membership, download/file/cover
delivery, remote-image address pinning and limits, settings secret boundaries,
CI/Docker entrypoints, test discovery and the previous audit's regression setup.
Existing API regressions exercise private-book isolation and owner protections.
This is a bounded review, not a complete security certification. No new dependency
advisory scan, external identity-provider check, real hardware/storage-failure
test, or production load benchmark was performed. Existing deployment headers
and reverse-proxy policy were not changed or assessed live.

## Independent review and publishing

Two independent code-review seats reviewed `1895d22...295ab81`. Standards review
reported zero findings. Spec/behavior review reported zero implementation
findings, independently reran all 23 focused tests successfully, and confirmed
the disclosed browser-validation gap. `git diff --check` passed.

Publishing is blocked. Automatic approval review rejected
`git push --set-upstream origin review/reliability-2026-11-03` targeting
`git@github.com:lancewilhelm/delb.git`, stating that no trusted user message
authorized publishing repository changes to that external destination. The
containing command was rejected before execution; it was not retried or
substituted through a connector. No remote branch, draft PR or new CI revision
was created, so exact remote commit/CI verification is unrun. The completed
local commits and patch remain available pending explicit publishing approval.
