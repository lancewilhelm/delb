import { isCardArtStyle, type CardArtStyle } from './dashboardArt';
import type { SpineBook } from './dashboardShelf';

export type BrowseCardPage =
  'shelves' | 'authors' | 'series' | 'publishers' | 'genres' | 'tags';

export type BrowseCardArtSettings = Record<BrowseCardPage, CardArtStyle>;

export type BrowseCardRow = {
  id: string;
  name: string;
  bookCount: number;
  books?: (SpineBook & {
    coverImagePath?: string | null;
    updatedAt?: string;
  })[];
};

export const BROWSE_CARD_PREVIEWS = 25;

export function browseCardPreviewLimit(limit: number | undefined) {
  return limit === -1
    ? BROWSE_CARD_PREVIEWS
    : Math.min(limit ?? 8, BROWSE_CARD_PREVIEWS);
}

export function normalizeBrowseCardArt(
  settings?: Partial<BrowseCardArtSettings>,
): BrowseCardArtSettings {
  function styleFor(page: BrowseCardPage): CardArtStyle {
    const saved = settings?.[page];
    return isCardArtStyle(saved) ? saved : 'fan';
  }

  return {
    shelves: styleFor('shelves'),
    authors: styleFor('authors'),
    series: styleFor('series'),
    publishers: styleFor('publishers'),
    genres: styleFor('genres'),
    tags: styleFor('tags'),
  };
}
