# Tooltip Directive

## Navigation + Entity Pages (Planned)

This page documents a (planned) navigation + routing strategy for Delb as we add more “entity” pages (book detail, authors, publishers, series, etc.).

### Goals

- Keep URLs consistent and predictable across entity types.
- Make entity pages linkable (copy/paste URL) and easy to navigate to from search results / lists.
- Support many-to-many relationships (e.g., a book can have multiple authors; an author has many books).
- Avoid painting ourselves into a corner when we add series/publishers later.

### Proposed URL scheme

Use plural resource names, with an `id` segment for canonical details, and optional “by relationship” list pages.

- Books
  - `GET /books/:id` — book detail page (the “book detail” view)
- Authors
  - `GET /authors/:id` — author detail page (bio + book list)
- Publishers
  - `GET /publishers/:id` — publisher detail page (info + book list)
- Series
  - `GET /series/:id` — series detail page (info + ordered book list)

Relationship list pages (optional; can be added later as needed):

- `GET /authors/:id/books` — explicit “books by this author”
- `GET /publishers/:id/books`
- `GET /series/:id/books`

### Linking rules (UI)

- In book lists, clicking the cover or title should navigate to `GET /books/:id`.
- In book detail, author names should be links (eventually) to `GET /authors/:id`.
- In book detail, publisher name should link (eventually) to `GET /publishers/:id`.
- In book detail, series name should link (eventually) to `GET /series/:id`.

### Data model considerations (later)

Today, the MVP book record has a single `author` string. To support rich entity pages, we’ll eventually want normalized tables:

- `authors` table + join table `book_authors`
- `publishers` table (either one-to-many on book, or many-to-many if needed)
- `series` table + ordering/position metadata per book

When we move to that model, we should keep URLs stable by using IDs (UUIDs) rather than names in the path.

### API shape considerations (later)

Preferred API endpoints (not required now, but should guide design):

- `GET /api/books/:id` → returns a single book + related entities (authors, publisher, series)
- `GET /api/authors/:id` → author + books
- `GET /api/publishers/:id` → publisher + books
- `GET /api/series/:id` → series + books (with ordering)

### Navigation component

As more pages ship, `PageNavigation` should evolve from a small hard-coded list to something driven by a centralized route map.

Possible approach:

- Keep “top-level” pages in navigation (Home, Settings, etc.).
- Do not include entity detail pages (like `books/:id`) in the nav dropdown.
- Add breadcrumbs on entity pages:
  - Home → Books → {Title}

### Notes

This is planning documentation only; implementation should follow this scheme to keep routing consistent as we grow.

Delb includes a simple, reusable tooltip directive that you can attach to **any** element. The tooltip is rendered into `document.body` (so it won’t be clipped by scroll/overflow containers), and it will **auto-flip / clamp** to stay within the viewport.

## Usage

### 1) Basic (string)
```/dev/null/example.vue#L1-7
<template>
  <button v-tooltip="'Save changes'">
    Save
  </button>
</template>
```

### 2) With options (object)
```/dev/null/example.vue#L1-18
<template>
  <button
    v-tooltip="{
      text: 'Saves your changes',
      side: 'right',
      offset: 10,
      viewportPadding: 12,
      showDelay: 200,
      hideDelay: 0
    }"
  >
    Save
  </button>
</template>
```

## Options

You can pass either:

- a `string` (tooltip text), or
- an object with the following fields:

### `text` (required for object form)
- Type: `string`
- The tooltip content.

### `side`
- Type: `"top" | "right" | "bottom" | "left"`
- Default: `"top"`
- Preferred placement side. If `autoFlip` is enabled, the tooltip may render on a different side to avoid clipping.

### `offset`
- Type: `number`
- Default: `8`
- Gap (in pixels) between the target element and the tooltip.

### `viewportPadding`
- Type: `number`
- Default: `8`
- Minimum distance (in pixels) to keep from the viewport edges.

### `showDelay`
- Type: `number`
- Default: `150`
- Delay (ms) before showing the tooltip on hover/focus.

### `hideDelay`
- Type: `number`
- Default: `0`
- Delay (ms) before hiding the tooltip on leave/blur.

### `maxWidth`
- Type: `string` (CSS value, e.g. `"240px"`, `"20rem"`)
- Optional
- Sets a per-tooltip max width; otherwise defaults to the global CSS variable `--tooltip-max-width`.

### `autoFlip`
- Type: `boolean`
- Default: `true`
- When enabled, the tooltip will choose a side that best fits within the viewport.

### `interactive`
- Type: `boolean`
- Default: `false`
- When enabled, the tooltip allows pointer interaction (sets `pointer-events: auto` on the tooltip).  
  Note: the tooltip is non-interactive by default (`pointer-events: none`) to avoid interfering with hovering/clicking the target.

## Behavior notes

- **Teleported to body:** Tooltip DOM is appended to `document.body`, which avoids clipping by containers with `overflow: hidden/auto/scroll`.
- **Viewport safety:** Tooltip coordinates are clamped to the viewport with `viewportPadding`, and it can `autoFlip` when there isn’t enough room on the preferred side.
- **Keyboard accessibility:** The directive shows tooltips on `focus` and hides them on `blur`. For non-focusable elements, it may add `tabindex="0"` when a tooltip is present.
- **Dismiss on outside click/tap:** If a tooltip is open, pointer down outside the target (and outside the tooltip when `interactive: true`) hides it.

## Styling

Tooltips use global CSS under the `.tooltip` class, with CSS variables for customization (defined in the main stylesheet). The directive sets positioning via:

- `--tooltip-x`
- `--tooltip-y`

You can adjust visuals by overriding variables such as:

- `--tooltip-bg`
- `--tooltip-fg`
- `--tooltip-shadow`
- `--tooltip-radius`
- `--tooltip-max-width`
- `--tooltip-z`
- `--tooltip-arrow-size`
