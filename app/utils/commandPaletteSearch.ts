import fuzzysort from 'fuzzysort';

interface SearchableOption<T> {
  label: string;
  options?: T[];
}

export interface PaletteSearchResult<T> {
  option: T;
  path: string;
  searchText: string;
}

export function searchPaletteOptions<T extends SearchableOption<T>>(
  options: T[],
  query: string,
): PaletteSearchResult<T>[] {
  const results: PaletteSearchResult<T>[] = [];
  function visit(items: T[], parents: string[]) {
    for (const option of items) {
      results.push({
        option,
        path: parents.join(' › '),
        searchText: [...parents, option.label].join(' '),
      });
      if (query.trim() && option.options) {
        visit(option.options, [...parents, option.label]);
      }
    }
  }
  visit(options, []);
  if (!query.trim()) return results;
  return fuzzysort
    .go(query.trim(), results, { key: 'searchText' })
    .map((r) => r.obj);
}
