export interface BookshelfViewPosition {
  x: number;
  y: number;
  zoom: number;
}

export function bookshelfViewKey(userId: string, shelfPath: string): string {
  return `delb.bookshelfView.v1:${encodeURIComponent(userId)}:${shelfPath}`;
}

export function readBookshelfView(
  storage: Storage,
  key: string,
): BookshelfViewPosition | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    if (!('x' in value && 'y' in value && 'zoom' in value)) return null;
    if (
      typeof value.x !== 'number' ||
      !Number.isFinite(value.x) ||
      typeof value.y !== 'number' ||
      !Number.isFinite(value.y) ||
      typeof value.zoom !== 'number' ||
      !Number.isFinite(value.zoom) ||
      value.zoom < 0.5 ||
      value.zoom > 4
    )
      return null;
    return { x: value.x, y: value.y, zoom: value.zoom };
  } catch {
    return null;
  }
}

export function saveBookshelfView(
  storage: Storage,
  key: string,
  position: BookshelfViewPosition,
): void {
  try {
    storage.setItem(key, JSON.stringify(position));
  } catch {
    // The bookshelf remains usable if browser storage is unavailable.
  }
}
