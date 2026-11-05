# Dashboard layout study

Question: which minimal arrangement makes the existing dashboard feel aligned and balanced, while keeping its content and visual language?

Three alternatives share the existing greeting, collection context, six counts, reading covers, and progress. The study changes their arrangement:

| Key     | Layout           | What to compare                                                                                         |
| ------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| A       | Quiet alignment  | The familiar centered greeting and six cards, with a consistent width and a left-aligned reading shelf. |
| B       | Balanced columns | A compact list of counts next to the reading shelf on desktop; stacked on phones.                       |
| C       | Reading first    | A smaller greeting, books first, and a quiet count strip underneath.                                    |
| current | Original         | The existing dashboard, available in the real app switcher.                                             |

No direction has been selected yet. Choose a base or combine specific parts before implementing a production change.

## Open the standalone sample

Open `dashboard.html` alongside this file. It needs no server, account, network access, or database. Use the A/B/C buttons or left/right arrow keys. The sample controls offer light/dark previews, an empty library, and a longer reading shelf. Counts and covers in this file are synthetic. Navigation shows an explanatory notice instead of opening real books.

Regenerate the file from the actual prototype Vue components with:

```sh
pnpm prototype:dashboard
```

## Compare using your existing library

Prerequisites: this prototype branch, installed dependencies, and your usual local Delb environment, account, and database.

1. Run the existing `pnpm dev` command.
2. Sign in and open `http://localhost:3000/?variant=A`.
3. Use the floating controls or left/right arrow keys to compare A, B, C, and Original. The URL updates, and a reload keeps the choice.
4. Switch collections in the existing header. Counts and reading books should follow the collection in every layout.
5. Narrow the window. Cards and counts should reflow, while longer reading shelves scroll horizontally inside their section.
6. Remove `?variant=A` (or the current variant) to return to the ordinary dashboard.

The alternative rendering and switcher are gated to development. The dashboard fetching, authentication, collection handling, loading/error paths, and original layout remain in `app/pages/index.vue`. The layouts use the real `BookThumbnail` component in Delb. The standalone exporter substitutes sample book covers and the surrounding app shell.

## Checks performed

- `pnpm typecheck` and targeted ESLint passed.
- Exported the real Vue prototype components into the offline HTML file.
- Rendered the sample alternatives at desktop and phone widths; inspected light appearance, the empty state, and a longer shelf. No console errors appeared in these renders.
- Live-library navigation and physical-device interactions have not been exercised.

This is throwaway exploration on `prototype/dashboard-layouts`; it is not a production implementation or an adopted design decision.
