# PDF reader reference

The [reader route](../../../app/pages/books/[id]/read.vue) prefers EPUB, then PDF. An explicit `?format=pdf` selects PDF for books with both formats. Book details expose Read for either format and a separate Read PDF action when both exist. Upload, Dropbox, and Calibre already store PDF file records; this change requires no ingestion or database migration. Uploaded PDFs retain the existing filename-based metadata behavior.

## Rendering and access

The [PDF component](../../../app/components/Readers/PdfReader.client.vue) loads [Mozilla PDF.js](https://mozilla.github.io/pdf.js/) only in the browser when opening a PDF. Its matching worker, CMaps, standard fonts, and image codecs are served locally through Vite/Nitro. No document is sent to an external viewer or CDN.

The component requests `GET /api/books/:id/download?format=pdf&fileId=...`. The existing handler requires a session, checks collection visibility and book/file association, confines the stored path to the managed library, and responds with `application/pdf`, attachment disposition, and `Cache-Control: private, no-store`. The PDF reader does not introduce another file-serving endpoint.

The viewer scrolls continuously through pages and renders canvases only near the viewport, capped at 16 million output pixels per canvas. Distant canvases are released, obsolete renders are cancelled, resize recalculates fit, and unmount destroys the PDF loading task and worker. PDF scripting, annotation actions, attachments, and forms have no viewer integration. Canvas-only rendering does not provide selectable text or a document text alternative; download remains available for readers that need those capabilities. Password-protected and malformed files show an error with a download option.

## Position and progress

The existing [position endpoints](epub-reader.md#endpoints) store `pdf:<encoded-file-id>:<page-number>` in the current user's reading-position row. Restoration ignores EPUB locations and other file IDs, rejects invalid pages, and clamps pages beyond the current page count. EPUB restoration likewise ignores PDF positions. There is one position row per user/book, rather than one per format.

The page near the top third of the viewport determines the saved position while scrolling; page controls also schedule a position write. Writes are serialized and include a UUID client session and increasing sequence; same-session stale writes are rejected by the existing persistence helper. Leaving the route flushes pending saves. Page hide sends the latest position with `keepalive`. Failed saves expose Retry save; failed position reads stop opening rather than silently replacing an unread position.

Progress is `displayed page / PDF page count * 100`. History sync remains opt-in through the existing book preference and position handler. When enabled, the latest logged percentage selects the opening page, rounded up and clamped to the PDF's range. The book's editable metadata page count is not changed.

## Verification

[Selection and location tests](../../../app/utils/readerFile.test.ts) run in `pnpm test`. [PDF API checks](../../../review/pdf-reader-api.mjs) run in the disposable production integration suite. [The browser runner](../../../review/pdf-reader-browser.mjs) exercises a synthetic PDF and the ordinary EPUB in an isolated Chrome profile; see [documentation status](../documentation-status.md) for results and limits.
