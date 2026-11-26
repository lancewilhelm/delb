<script setup lang="ts">
import { $fetch } from '~/utils/apiFetch';
import { computed, nextTick, ref, watch } from 'vue';
import SearchBookResult from '~/components/Search/BookResult.vue';
import SearchDialogFrame from '~/components/Search/DialogFrame.vue';
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
const query = ref('');
const inputRef = ref<HTMLInputElement | null>(null);
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
      void load();
      void nextTick(() => inputRef.value?.focus());
    } else {
      sequence++;
      if (timer) clearTimeout(timer);
    }
  },
);
watch(query, () => {
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
  <SearchDialogFrame
    :open="open"
    :label="mode === 'add' ? 'Add books to Shelf' : 'Remove books from Shelf'"
    @close="emit('close')"
  >
    <div
      class="h-12 shrink-0 flex items-center px-3 py-2 border-b border-(--contrast-border-color)"
    >
      <Icon name="lucide:search" class="scale-125" aria-hidden="true" />
      <input
        ref="inputRef"
        v-model="query"
        type="search"
        aria-label="Search books"
        placeholder="search library (title, author, ISBN)"
        class="w-full bg-transparent! px-2! rounded-t-lg! rounded-b-none! focus:outline-none"
      />
      <button
        type="button"
        aria-label="Close"
        class="p-1 opacity-70 hover:opacity-100"
        @click="emit('close')"
      >
        <Icon name="lucide:x" />
      </button>
    </div>
    <div
      class="px-3 py-2 flex items-center justify-between gap-3 text-xs opacity-70 border-b border-(--contrast-border-color)"
    >
      <span>{{
        mode === 'add' ? 'Add books to Shelf' : 'Remove books from Shelf'
      }}</span>
    </div>
    <p v-if="error" role="alert" class="px-3 py-2">{{ error }}</p>
    <div
      class="flex-1 min-h-0 overflow-y-auto"
      :aria-label="mode === 'add' ? 'Books to add' : 'Books to remove'"
      :aria-busy="loading"
    >
      <div
        class="px-3 py-2 text-xs opacity-70 border-b border-(--contrast-border-color)"
      >
        <span v-if="loading">searching…</span
        ><span v-else
          >{{ books.length }} {{ books.length === 1 ? 'book' : 'books'
          }}{{ cursor ? ' loaded' : '' }}</span
        >
      </div>
      <p v-if="!loading && !books.length" class="p-3">no books found</p>
      <div v-if="books.length" class="pb-2">
        <div class="px-3 pt-3 pb-1 text-xs uppercase tracking-wide opacity-70">
          Books
        </div>
        <label
          v-for="book in books"
          :key="book.id"
          class="h-12 cursor-pointer px-3 py-1 hover:bg-(--sub-alt-color) flex items-center gap-2"
          :class="selected.has(book.id) ? 'bg-(--sub-color)' : ''"
        >
          <SearchBookResult
            :title="book.title"
            :subtitle="`${book.authorNames?.join(', ') || book.author || 'Unknown author'} ${mode === 'add' && existingIds.has(book.id) ? ' · Already on Shelf' : ''}`"
            :cover-src="
              book.coverImagePath
                ? `/api/books/${encodeURIComponent(book.id)}/cover?variant=thumb`
                : null
            "
          >
            <input
              type="checkbox"
              :checked="
                (mode === 'add' && existingIds.has(book.id)) ||
                selected.has(book.id)
              "
              :disabled="mode === 'add' && existingIds.has(book.id)"
              :aria-label="`Select ${book.title}`"
              @change="toggle(book.id)"
            />
          </SearchBookResult>
        </label>
        <button
          v-if="cursor"
          type="button"
          class="px-3 py-2 text-sm underline"
          :disabled="loading"
          @click="load(true)"
        >
          {{ loading ? 'Loading…' : 'Load more' }}
        </button>
      </div>
    </div>
    <div
      class="px-3 py-2 border-t border-(--contrast-border-color) flex justify-between items-center gap-3"
    >
      <span class="text-xs opacity-70">{{ selected.size }} selected</span>
      <div class="flex gap-3">
        <button type="button" @click="emit('close')">Cancel</button
        ><button
          type="button"
          class="px-3 py-1 border border-(--contrast-border-color) rounded"
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
  </SearchDialogFrame>
</template>
