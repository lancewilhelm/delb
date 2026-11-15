<script setup lang="ts">
import type { BookViewBook } from '~/utils/bookFields';
const props = withDefaults(
  defineProps<{
    open: boolean;
    existing: string[];
    shelfId: string;
    mode?: 'add' | 'remove';
  }>(),
  { mode: 'add' },
);
const emit = defineEmits<{ close: []; added: [] }>();
const collections = useCollectionsStore();
const query = ref('');
const collectionId = ref('');
const books = ref<BookViewBook[]>([]);
const selected = ref(new Set<string>());
const cursor = ref<string | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
let sequence = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const existingIds = computed(() => new Set(props.existing));
async function load(append = false) {
  const current = ++sequence;
  loading.value = true;
  error.value = '';
  try {
    const response = await $fetch<{
      success: boolean;
      data: { books: BookViewBook[]; nextCursor: string | null };
    }>('/api/books', {
      query: {
        search: query.value.trim() || undefined,
        shelfId: props.mode === 'remove' ? props.shelfId : undefined,
        collectionId: collectionId.value || undefined,
        limit: 50,
        cursor: append ? cursor.value : undefined,
      },
    });
    if (current !== sequence) return;
    books.value = append
      ? [...books.value, ...response.data.books]
      : response.data.books;
    cursor.value = response.data.nextCursor;
  } catch {
    if (current === sequence) error.value = 'Could not load books. Try again.';
  } finally {
    if (current === sequence) loading.value = false;
  }
}
watch(
  () => props.open,
  (open) => {
    if (open) {
      selected.value = new Set();
      query.value = '';
      collectionId.value = '';
      void collections.fetchCollections();
      void load();
    } else {
      sequence++;
      if (timer) clearTimeout(timer);
    }
  },
);
watch([query, collectionId], () => {
  if (!props.open) return;
  sequence++;
  books.value = [];
  cursor.value = null;
  loading.value = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void load(), 200);
});
function toggle(id: string) {
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
}
async function add() {
  if (!selected.value.size || saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    await $fetch(`/api/shelves/${encodeURIComponent(props.shelfId)}/books`, {
      method: 'POST',
      body: { action: props.mode, bookIds: [...selected.value] },
    });
    emit('added');
    emit('close');
  } catch {
    error.value = 'Could not update books. Check access and try again.';
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <ModalWindow :open="open" width-full @close="emit('close')">
    <div
      role="dialog"
      aria-modal="true"
      :aria-label="
        mode === 'add' ? 'Add books to Shelf' : 'Remove books from Shelf'
      "
      class="flex flex-col gap-3 max-h-[80vh]"
    >
      <div class="flex items-center justify-between">
        <h2 class="text-xl font-semibold">
          {{ mode === 'add' ? 'Add books' : 'Remove books' }}
        </h2>
        <button type="button" aria-label="Close" @click="emit('close')">
          ✕
        </button>
      </div>
      <label
        >Search by title, author, or ISBN
        <input
          v-model="query"
          type="search"
          placeholder="Search your library"
          class="w-full mt-1 p-2 border rounded"
      /></label>
      <label
        >Collection
        <select v-model="collectionId" class="ml-2 p-1 border rounded">
          <option value="">All accessible collections</option>
          <option
            v-for="collection in collections.collections"
            :key="collection.id"
            :value="collection.id"
          >
            {{ collection.name }}
          </option>
        </select></label
      >
      <p v-if="error" role="alert">{{ error }}</p>
      <div
        class="overflow-auto flex-1 min-h-32 border rounded"
        :aria-label="mode === 'add' ? 'Books to add' : 'Books to remove'"
        :aria-busy="loading"
      >
        <p v-if="loading && !books.length" class="p-3">Loading books…</p>
        <p v-else-if="!books.length" class="p-3">No books found.</p>
        <label
          v-for="book in books"
          :key="book.id"
          class="flex items-center gap-3 p-2 border-b cursor-pointer"
        >
          <input
            type="checkbox"
            :checked="
              (mode === 'add' && existingIds.has(book.id)) ||
              selected.has(book.id)
            "
            :disabled="mode === 'add' && existingIds.has(book.id)"
            @change="toggle(book.id)"
          />
          <BookCover
            :src="
              book.coverImagePath
                ? `/api/books/${encodeURIComponent(book.id)}/cover?variant=thumb`
                : null
            "
            :title="book.title"
            :alt="`Cover for ${book.title}`"
            class="w-10 h-14 shrink-0"
          />
          <span class="min-w-0"
            ><strong class="block truncate">{{ book.title }}</strong
            ><span class="text-sm opacity-70"
              >{{
                book.authorNames?.join(', ') || book.author || 'Unknown author'
              }}
              ·
              {{
                collections.collections.find((c) => c.id === book.collectionId)
                  ?.name || 'Collection'
              }}<template v-if="mode === 'add' && existingIds.has(book.id)">
                · Already on Shelf</template
              ></span
            ></span
          >
        </label>
        <button
          v-if="cursor"
          type="button"
          class="p-3 underline"
          :disabled="loading"
          @click="load(true)"
        >
          {{ loading ? 'Loading…' : 'Load more' }}
        </button>
      </div>
      <div class="flex justify-end gap-3">
        <button type="button" @click="emit('close')">Cancel</button
        ><button
          type="button"
          class="px-3 py-2 border rounded"
          :disabled="!selected.size || saving"
          @click="add"
        >
          {{
            saving
              ? 'Saving…'
              : `${mode === 'add' ? 'Add' : 'Remove'} ${selected.size} book${selected.size === 1 ? '' : 's'}`
          }}
        </button>
      </div>
    </div>
  </ModalWindow>
</template>
