# Series

## Series list cards (covers)

The series list page can show a strip of book covers for each series (when available).

Implementation details:

- API: `server/api/series/index.get.ts` returns `books` (all series books, ordered by `seriesIndex`), with `coverThumbnailUrl` nullable.
- UI: `app/pages/series/index.vue` renders those covers in the series list.
