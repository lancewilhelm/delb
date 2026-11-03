# Book view settings

Design discussion for [issue #20](https://github.com/lancewilhelm/delb/issues/20).
Status: owner confirmed the completed design on 2026-11-02. Implemented on the issue branch; verification and review are in progress.

## Accepted decisions

- Apply view preferences across Books, collections, authors, publishers, and tags. The separate series layout is outside this issue.
- Keep grid and list field selections and field order independent.
- Add a settings button beside the grid/list switch. Its menu controls the active view and applies changes immediately.
- Keep the command menu and Appearance settings connected to the same preferences.
- Offer title, authors, series/index, tags, publisher, publication date, language, page count, description, identifiers such as ISBN, file formats, personal rating, reading status, and date added/updated.
- Preserve the current visible fields as defaults.
- Allow users to reorder fields independently in each view.
- In the grid, present each selected field on one line using the existing scrolling container. Tags remain on one line, and descriptions display as plain text. Full descriptions remain available in book details.
- List fields wrap instead of using the grid's scrolling-text presentation. Rows grow to fit content up to a limit, so oversized tags or other values cannot create excessively tall rows.
- Treat the existing list row-height setting as a minimum height.
- Limit each list cell to three lines, followed by an ellipsis when more content exists. Wrap unusually long words and tags within the column. Full values remain available in book details.
- Allow every metadata field, including title, to be hidden. Covers stay visible and fixed first, allowing cover-only cards and rows.
- Omit missing metadata from grid cards. Show a dash for missing values in list cells.
- Provide drag handles and move-up/move-down buttons for field ordering.
- Save field selections and order automatically through the existing account settings, including the separate mobile profile when enabled. Restore preferences across visits and devices.

## Confirmation

The owner confirmed shared understanding of the completed design. No product decisions remain open.

## Baseline before implementation

`HoverScrollText` presents one line with an ellipsis and scrolls horizontally on mouse hover. Grid cards and list rows already use it for titles, authors, and series.

The original grid and list scrolling layouts rely on uniform height estimates. Full wrapping of arbitrary metadata would require changing those assumptions.

Settings sync to the user's account and support an optional separate mobile profile.
