# Browse list cards (covers)

Shelves, Authors, Series, Publishers, Genres, and Tags render the dashboard's
square artwork tiles. The **Card style** picker applies one style to all tiles
on its page. The account stores each page's style under `browseCardArt`. New
accounts and profiles without a saved choice use Fan.

[BrowseCardGrid](../../../app/components/BrowseCardGrid.vue) supplies the
title, visible book count, preview books, and detail link to the shared
[dashboard tile](../../../app/components/Dashboard/DashboardListTile.vue).
Browse tiles omit the dashboard's per-card art menu. Tags and Genres still
support their administrator actions from the card's context menu or
Shift+F10.

[Catalog endpoints](../../../internal/books/catalog.go) use `artPreviews=1`
to include coverless books and the spine metadata that Shelf art needs. The
same query applies tag visibility to both the count and the previews. It
limits the preview to 25 books per card. [Shelves](../../../internal/bookshelf/shelves.go)
use their existing `previews` option.

## Series list cards (covers)

The series endpoint orders previews by series index, then title and ID.
