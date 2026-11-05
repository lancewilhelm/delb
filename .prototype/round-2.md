# Dashboard study, round 2

Question: how should the dashboard offer several book shelves while keeping C's quiet count strip above the books?

The count strip sits between the greeting and the book shelf in all three options. The control for choosing a shelf changes:

| Key | Option         | Tradeoff                                                                                                 |
| --- | -------------- | -------------------------------------------------------------------------------------------------------- |
| D   | Open tabs      | All three shelf choices remain visible, with a simple underline for the selected one.                    |
| E   | Quiet dropdown | The selected shelf becomes the heading; other shelves live in its menu. Uses the least space.            |
| F   | Compact switch | A small group of buttons sits beside “Your books.” More explicit grouping, with an extra line on phones. |

Each option offers Continue reading, Recently read, and Favorites. Changing D/E/F retains the selected shelf. Recently read displays the date finished and sorts newest first. The book count strip always describes the whole collection, independently of the selected shelf.

## Try it

Open `dashboard-round-2.html` in this folder. No server, account, database, or network access is required.

1. Use D/E/F, or the left/right arrow keys, to switch the design. The count strip should stay above the books.
2. Choose Recently read. The sample books should show descending finish dates under their covers.
3. Switch to another design. Recently read should stay selected.
4. Choose Favorites. A sample starred shelf should appear.
5. Select Empty library in the sample controls. Each shelf should show its corresponding empty state.
6. Narrow the window or use the light preview. Counts should reflow and long book shelves should scroll inside their section.

The original A–C study remains in `dashboard.html`. Regenerate both files with `pnpm prototype:dashboard` in this checkout after the usual dependency setup.

## Existing data and proposed behavior

- Delb stores a per-user `user_book_status.finished_at` date and exposes an editable finish date on book details. This is the appropriate existing field for the proposed Recently read order; it is not the last file-update date or reading-position timestamp.
- The current dashboard API returns counts and Continue reading, and does not yet return a Recently read shelf.
- This checkout has theme favorites, but no book-favorites field, API, or book-level control. The proposed Favorites shelf would need a separate per-user favorite value, independent of reading status and star ratings.
- Recently read and Favorites are sample-only concepts in this study. No book-favorites feature, database migration, or new dashboard query is implemented. The sample star badges are illustrative.
- On the development-only native `/?variant=D`, `E`, or `F` route, counts and Continue reading retain the existing data source. The two proposed shelves are clearly marked as sample books. Use the standalone file for the simplest review; this isolated checkout has no copied local database or account configuration.

The first round is preserved on `prototype/dashboard-layouts`. This round lives on `prototype/dashboard-round-2` in its own checkout. No production design has been selected.

## Checks performed

- Nuxt typecheck, targeted ESLint, formatting, and diff whitespace checks passed.
- Rendered D/E/F at desktop and phone widths, plus light appearance.
- Exercised the exported Vue components in the rendered sample: switching shelves, descending finish dates, preserving selection across D/E/F, the sample Favorites shelf, arrow keys inside the dropdown, and all three empty states passed.
- The preview uses synthetic books. Live-library queries, physical devices, and a persistent book-favorites feature were not tested or implemented in this round.
