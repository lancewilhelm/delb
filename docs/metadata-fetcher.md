# Metadata Fetcher

The metadata fetcher feature allows administrators to search for and import book metadata from external sources, starting with the Google Books API.

## Overview

When editing a book, administrators can search for and import metadata from Google's public Books API. The interface allows selective import of individual fields (title, authors, description, publisher, published date, language, tags/categories, and cover image) via checkboxes, giving users full control over what metadata to update.

## How to Use

1. Navigate to the edit page for a book (`/books/[id]/edit`)
2. Scroll to the bottom of the metadata form
3. Click the "Search for Metadata (Google Books)" button
4. A modal will open with the book's current title pre-filled as the search query
5. Modify the search query if needed and click "Search" (or press Enter)
6. Browse the results - each result shows available metadata fields
7. Check the boxes next to the fields you want to import
8. Click "Import Selected Fields" to apply the changes

## Current Implementation Status

### Phase 1: Search and Selective Import UI (Completed)
- ✅ Google Books API integration via server proxy
- ✅ Search modal with auto-search capability
- ✅ Display search results with thumbnails, authors, publisher, published date, and ISBN
- ✅ Checkbox-based field selection for each result
- ✅ Import button with visual feedback when fields are selected
- ✅ Support for importing: title, authors, description, publisher, published date, language, tags/categories, and cover

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
      type: string;  // 'ISBN_13' or 'ISBN_10'
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

| Google Books Field | Internal Schema Field | Type |
|-------------------|----------------------|------|
| `volumeInfo.title` | `books.title` | Direct |
| `volumeInfo.authors[]` | `authors.name` (via `bookAuthors`) | Many-to-many |
| `volumeInfo.description` | `books.description` | Direct |
| `volumeInfo.publisher` | `publishers.name` (via `publisherId`) | Foreign key |
| `volumeInfo.publishedDate` | `books.published` | Direct (string) |
| `volumeInfo.language` | `books.language` | Direct |
| `volumeInfo.categories[]` | `tags.name` (via `bookTags`) | Many-to-many |
| `volumeInfo.imageLinks.thumbnail` | `books.coverImagePath` | Download & convert |

### Security Considerations

- The API endpoint is server-side to avoid CORS issues and potential rate limiting
- No API key is currently required for Google Books API public access
- The endpoint does not require authentication (relies on page-level auth)

## Future Enhancements

1. **Multiple Data Sources**: Add support for OpenLibrary, Amazon, or other book APIs
2. **Batch Import**: Search and import metadata for multiple books at once
3. **Auto-fetch on Upload**: Automatically search for metadata when uploading new books
4. **Confidence Scoring**: Show match confidence based on ISBN, title, and author similarity
5. **Manual Field Selection**: Allow users to cherry-pick which fields to import
6. **History/Undo**: Track metadata changes and allow reverting imports

## Testing

To test the metadata fetcher:

1. Start the development server: `pnpm run dev`
2. Log in as an admin user
3. Navigate to any book's edit page
4. Click the "Search for Metadata (Google Books)" button at the bottom
5. Try searching for:
   - The current book title (auto-filled)
   - An ISBN (e.g., "9780593820247")
   - An author name (e.g., "Matt Dinniman")
   - A different book title (e.g., "Dungeon Crawler Carl")
6. Verify that results display correctly with thumbnails and metadata
7. Check/uncheck various field checkboxes on a result
8. Verify the "Import Selected Fields" button is disabled when no fields are selected
9. Select some fields and click "Import Selected Fields"
10. Check the browser console for the logged import data

## Related Files

- `/app/pages/books/[id]/edit.vue` - Edit book page with metadata search button
- `/app/components/BookMetadataSearchModal.vue` - Search modal component
- `/server/api/books/metadata/search.get.ts` - API endpoint for Google Books search