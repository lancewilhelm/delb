export type BookMoveSelection =
  | { kind: 'books'; bookIds: string[] }
  | { kind: 'collection'; collectionId: string; excludedBookIds: string[] };

export function chooseBookTarget(
  collections: ReadonlyArray<{
    id: string;
    role: string | null;
    isDefault?: boolean;
  }>,
  activeId: string | null,
): string | null {
  const writable = collections.filter(
    (collection) => collection.role === 'owner' || collection.role === 'editor',
  );
  return (
    writable.find((collection) => collection.id === activeId)?.id ??
    writable.find((collection) => collection.isDefault)?.id ??
    null
  );
}
