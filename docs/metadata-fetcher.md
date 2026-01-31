# Metadata Fetcher

The metadata fetcher feature allows administrators to search for and import book metadata from external sources.

Currently supported sources:

- Google Books (public API)
- Hardcover (GraphQL API; requires an admin-configured token stored server-side)

## Overview

When editing a book, administrators can search for and import metadata from external sources. The interface allows selective import of individual fields (title, authors, description, publisher, published date, language, tags/categories, and cover image) via checkboxes, giving users full control over what metadata to update.

Cover images shown in the metadata search results display a small resolution badge (e.g. `1200×1800`) so you can quickly gauge cover quality before importing.

In addition, the **Add book** modal supports importing a _full_ book record from metadata (no per-field selection). This is designed for fast entry workflows like barcode/ISBN scanning.

## Provider Selection

### Multi-provider search (modal toggles)

The metadata search modal supports enabling one or more providers at the same time (currently Google Books and Hardcover). Provider selection is controlled by toggles under the search bar.

This selection is remembered per-user.

### Hardcover availability

Hardcover is only selectable when the server has a configured Hardcover token. If not configured, the Hardcover toggle is shown as disabled (“not configured”).

## How to Use

1. Navigate to the edit page for a book (`/books/[id]/edit`)
2. Scroll to the bottom of the metadata form
3. Click the "Search for Metadata (Google Books)" button
4. A modal will open with the book's current title pre-filled as the search query
5. Modify the search query if needed and click "Search" (or press Enter)
6. Browse the results - each result shows available metadata fields
7. Check the boxes next to the fields you want to import
8. Click "Import Selected Fields" to apply the changes

Tip: The cover preview on the edit page uses the full-resolution stored cover when available, and shows its resolution in the corner.

## Add Book Modal (Full Import)

From the Add Book modal ("By metadata" tab), you can either:

- **Add top result** (single step): intended for barcode/ISBN scanning where you want the top match immediately.
- **Search results** (choose from a list): browse a list of matches and import the entire selected book.

### Possible duplicates (Add Book modal)

When a possible duplicate is detected while importing a book from metadata, the UI offers:

- **Cancel** (do nothing)
- **Add existing to collections** (adds the existing candidate book to any selected collections it isn’t already in)
- **Replace selected** (admin-only; overwrites the selected existing book’s canonical metadata with the incoming metadata, then adds it to missing selected collections)
- **Add new entry** (creates a new book entry without affecting the existing one)

## Current Implementation Status

### Phase 1: Search and Selective Import UI (Completed)

- ✅ Google Books API integration via server proxy
- ✅ Search modal with auto-search capability
- ✅ Display search results with thumbnails, authors, publisher, published date, and ISBN
- ✅ Checkbox-based field selection for each result
- ✅ Import button with visual feedback when fields are selected
- ✅ Support for importing: title, authors, description, publisher, published date, language, tags/categories, and cover

### Hardcover (Provider Setup + Server Proxy)

- ✅ Server-side Hardcover GraphQL search endpoint
- ✅ Admin UI for configuring Hardcover token (stored server-side; never returned to clients)
- ✅ Metadata search modal provider toggle (disabled unless token is configured)
- ✅ Multi-provider search (search Google Books and Hardcover together)

### Phase 2: Backend Import Logic (In Progress)

- ⏳ Map Google Books data to internal book schema
- ⏳ Handle authors array → authorChips conversion
- ⏳ Handle categories → tagChips conversion
- ⏳ Cover image download and upload from Google Books URLs
- ⏳ Publisher and series name resolution/creation
- ⏳ Update form fields with selected metadata

## Technical Details

### Components

**`BookMetadataSearchModal.vue`**

- Modal component for searching and displaying metadata results
- Auto-searches when opened with an initial query
- Handles search state, loading, and error messages
- Displays results with expandable import options
- Checkbox selection for individual metadata fields
- Per-result import buttons that are enabled only when fields are selected
- Tracks field selection state for each search result independently

**API Endpoint: `/api/books/metadata/search`**

- Server-side proxy to Google Books API
- GET endpoint accepting `q` query parameter
- Returns raw Google Books API response
- Maximum 20 results per search

**API Endpoint: `/api/books/metadata/hardcover/search`**

- Server-side proxy to Hardcover GraphQL API
- GET endpoint accepting `q` query parameter
- Requires a Hardcover token configured by an admin (stored server-side)
- Returns mapped results (best-effort) derived from Hardcover’s `search.results` payload

### Google Books API Response Structure

The API returns results with the following structure (relevant fields):

```typescript
interface GoogleBooksResponse {
  kind: string;
  totalItems: number;
  items?: GoogleBookItem[];
}

interface GoogleBookItem {
  id: string;
  volumeInfo: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    industryIdentifiers?: Array<{
      type: string; // 'ISBN_13' or 'ISBN_10'
      identifier: string;
    }>;
    pageCount?: number;
    categories?: string[];
    imageLinks?: {
      smallThumbnail?: string;
      thumbnail?: string;
    };
    language?: string;
  };
}
```

### Field Mapping

The following Google Books API fields map to the internal schema:

| Google Books Field                | Internal Schema Field                 | Type               |
| --------------------------------- | ------------------------------------- | ------------------ |
| `volumeInfo.title`                | `books.title`                         | Direct             |
| `volumeInfo.authors[]`            | `authors.name` (via `bookAuthors`)    | Many-to-many       |
| `volumeInfo.description`          | `books.description`                   | Direct             |
| `volumeInfo.publisher`            | `publishers.name` (via `publisherId`) | Foreign key        |
| `volumeInfo.publishedDate`        | `books.published`                     | Direct (string)    |
| `volumeInfo.language`             | `books.language`                      | Direct             |
| `volumeInfo.categories[]`         | `tags.name` (via `bookTags`)          | Many-to-many       |
| `volumeInfo.imageLinks.thumbnail` | `books.coverImagePath`                | Download & convert |

### Security Considerations

- Metadata endpoints are server-side to avoid CORS issues and to keep provider details off the client.
- Google Books does not require an API key for basic usage.
- Hardcover requires a bearer token.

#### Hardcover token storage (server-side only)

Delb stores the Hardcover token server-side and never returns it to clients. The client only receives a non-secret capability flag indicating whether Hardcover is available, which is used to enable/disable the Hardcover provider toggle in the metadata search modal.

## Future Enhancements

1. **Multiple Data Sources**: Add support for OpenLibrary, Amazon, or other book APIs
2. **Batch Import**: Search and import metadata for multiple books at once
3. **Auto-fetch on Upload**: Automatically search for metadata when uploading new books
4. **Confidence Scoring**: Show match confidence based on ISBN, title, and author similarity
5. **Manual Field Selection**: Allow users to cherry-pick which fields to import
6. **History/Undo**: Track metadata changes and allow reverting imports

## Testing

To test the metadata fetcher:

### Google Books

1. Start the development server: `pnpm run dev`
2. Log in as an admin user
3. Navigate to any book's edit page
4. Click the "Search for Metadata" button at the bottom
5. Try searching for:
   - The current book title (auto-filled)
   - An ISBN (e.g., "9780593820247")
   - An author name (e.g., "Matt Dinniman")
   - A different book title (e.g., "Dungeon Crawler Carl")
6. Verify that results display correctly with thumbnails and metadata

### Hardcover (token + endpoint)

1. Log in as an admin user
2. Go to Admin Settings → Metadata
3. Paste your Hardcover token (raw token or `Bearer <token>`) and click “save”
4. In a browser (while logged in), request:
   - `/api/books/metadata/hardcover/search?q=The%20Hobbit`
5. Verify you receive a successful response containing a `data.results` array

If the endpoint returns an error indicating the token is not configured, confirm the token was saved and that the server is reading it from server-side storage.

## Related Files

- `/app/pages/books/[id]/edit.vue` - Edit book page with metadata search button
- `/app/components/BookMetadataSearchModal.vue` - Search modal component
- `/server/api/books/metadata/search.get.ts` - API endpoint for Google Books search
- `/server/api/books/metadata/hardcover/search.get.ts` - API endpoint for Hardcover search (GraphQL proxy)
- `/app/components/Books/BookAddModal.vue` - Add Book modal (full metadata import + duplicate resolution)
- `/server/api/books/metadata-import/create.post.ts` - Creates a book from metadata (top result or selected result) + duplicate resolution
- `/server/api/settings/admin/hardcover-token.put.ts` - Admin-only endpoint to set/clear Hardcover token (server-side)
- `/app/components/Settings/SettingsAdminMetadata.vue` - Admin UI for metadata provider settings + Hardcover token (server-side)
- `/app/components/BookMetadataSearchModal.vue` - Multi-provider search toggles (remembered per-user)
