import {
  bookFieldCatalog,
  type BookFieldId,
  type BookFieldPreference,
  type BookViewMode,
} from '~/utils/bookFields';

export function useBookViewFields(mode: BookViewMode) {
  const store = useUserSettingsStore();
  const fields = store.settingRef<BookFieldPreference[]>(
    mode === 'grid' ? 'bookGrid.fields' : 'bookList.fields',
  );
  function setVisible(id: BookFieldId, visible: boolean) {
    fields.value = fields.value.map((field) =>
      field.id === id ? { ...field, visible } : field,
    );
  }
  function move(id: BookFieldId, targetId: BookFieldId) {
    const next = [...fields.value];
    const from = next.findIndex((f) => f.id === id);
    const to = next.findIndex((f) => f.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    const field = next.splice(from, 1)[0];
    if (!field) return;
    next.splice(to, 0, field);
    fields.value = next;
  }
  const paletteOptions = bookFieldCatalog.map((field) => ({
    label: field.label.toLowerCase(),
    toggle: {
      model: computed({
        get: () => fields.value.some((f) => f.id === field.id && f.visible),
        set: (value: boolean) => setVisible(field.id, value),
      }),
    },
  }));
  return { fields, setVisible, move, paletteOptions };
}
