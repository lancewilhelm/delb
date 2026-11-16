export const MAX_SERIES_SPINE_REFERENCES = 3;

export type SeriesSpineReference = {
  bookId: string;
  title: string;
  seriesIndex: number | null;
  revision: string;
};

export type SelectedSeriesSpine = Pick<
  SeriesSpineReference,
  'bookId' | 'revision'
>;

export function parseSelectedSeriesSpines(
  value: unknown,
): SelectedSeriesSpine[] | null {
  if (!Array.isArray(value) || value.length > MAX_SERIES_SPINE_REFERENCES)
    return null;
  const result: SelectedSeriesSpine[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== 'object' ||
      !('bookId' in item) ||
      typeof item.bookId !== 'string' ||
      !item.bookId ||
      item.bookId.length > 128 ||
      !('revision' in item) ||
      typeof item.revision !== 'string' ||
      !item.revision ||
      item.revision.length > 128 ||
      result.some((reference) => reference.bookId === item.bookId)
    )
      return null;
    result.push({ bookId: item.bookId, revision: item.revision });
  }
  return result;
}
