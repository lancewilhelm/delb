# Browse list cards (covers)

Shelves, Authors, Series, Publishers, Genres, and Tags use the dashboard's
square artwork tiles. The **Card style** picker applies one style to all tiles
on its page. The account saves each page's choice under `browseCardArt`. Fan
is the default.

## Implementation details

[BrowseCardGrid](../../../app/components/BrowseCardGrid.vue) supplies the
title, visible book count, preview books, and detail link to the shared
[dashboard tile](../../../app/components/Dashboard/DashboardListTile.vue).

The [catalog list endpoints](../../../internal/books/catalog.go) include
`GET /api/authors`, `GET /api/series`, `GET /api/publishers`,
`GET /api/genres`, and `GET /api/tags`. The browse pages request `artPreviews=1`
to include coverless books and the spine metadata that Shelf art uses. The
query applies tag visibility to both the counts and the previews, and returns
up to 25 preview books per card. The [Shelves endpoint](../../../internal/bookshelf/shelves.go)
uses its `previews` option.

## Interaction details

Select a tile to open its book listing. Browse tiles use the page's shared
style. Administrators can right-click a Tags or Genres tile or press Shift+F10
on its link to open its management menu.

## Series list cards (covers)

The series endpoint orders previews by series index, then title and ID.
