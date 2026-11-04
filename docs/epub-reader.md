# EPUB reader reference

The [reader page](../app/pages/books/[id]/read.vue) is a full-screen EPUB.js interface. The [user guide](using/reading.md) covers navigation and progress tasks.

## File access and controls

The book detail page offers Read when the file list contains an EPUB. The reader requests `GET /api/books/:id/download?format=epub`, optionally identifying a file with `fileId`. The download handler checks session and collection visibility, then streams the stored file from the managed library.

The reader has pages/scroll modes, previous/next navigation, table of contents, left/right keyboard navigation, Escape to return, and font/appearance controls. Reader settings persist through account settings.

The current rendition disables scripted EPUB content with `allowScriptedContent: false`. This limits book scripts; it is not a claim that all EPUB input is trusted or that every publisher's interactive book remains compatible.

## Position and progress records

| Table                        | Fields used by the reader                                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `user_book_reading_position` | User/book, serialized location, optional percentage, client session ID, client sequence, updated timestamp |
| `user_book_preferences`      | User/book progress-sync toggle, disabled by default                                                        |
| `user_book_progress_log`     | Historical percentage, optional page/location, source, occurrence date                                     |

A saved location is usually an EPUB CFI. It is not a page number. Position and progress history remain separate records.

## Endpoints

| Request                               | Contract                                                    |
| ------------------------------------- | ----------------------------------------------------------- |
| `GET /api/books/:id/reading-position` | Current user's saved location/progress                      |
| `PUT /api/books/:id/reading-position` | Save location/progress; null or empty location clears it    |
| `PUT /api/books/:id/progress-sync`    | Enable/disable reader-to-history logging for this user/book |
| `GET /api/books/:id/progress-logs`    | Current user's history                                      |
| `POST /api/books/:id/progress-logs`   | Add a manual percentage/page entry                          |

Position writes accept `location`, optional `progress`, and optional `clientSessionId`/`clientSequence`. When either ordering field is supplied, both are required: the session ID has UUID format and the sequence is a positive safe integer. Clear requests omit the ordering fields. The persistence helper rejects older sequence writes within the same session. Different sessions are not globally ordered by that counter.

The reader debounces and queues position writes. On successful saves, enabled progress sync can append reader-sourced history entries subject to the handler's change/time thresholds. Manual logs and Finished status create their own history.

On open, the reader restores the saved CFI. With progress sync enabled, it also fetches the latest progress log. After generating EPUB locations, it can translate that logged percentage into a CFI and restore there if the user has not already navigated. A manual log does not directly write a position record, but it can therefore influence the next reader restoration.

## Sources and evidence

- [Position handler](../server/api/books/[id]/reading-position.put.ts) and [persistence helper](../server/utils/books/save-position.ts).
- [Progress-sync handler](../server/api/books/[id]/progress-sync.put.ts) and [status transitions](../server/utils/books/status-transition.ts).
- [Fullscreen listener lifecycle](reader-fullscreen-fix.md).
- [Documentation verification](developing/documentation-status.md) for exercised controls and evidence limits.
