<script setup lang="ts">
import type { TbrBook } from '~/types/tbr';
import { sanitizeDescriptionHtml } from '~/utils/descriptionHtml';

definePageMeta({ auth: { only: 'user', redirectGuestTo: '/login' } });
useHead({ title: 'To be read' });
const ui = useUiStore();
const books = ref<TbrBook[]>([]);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const announcement = ref('');
const scroller = ref<HTMLElement | null>(null);
type Drag = {
  bookId: string;
  targetId: string;
  pointerId: number;
  x: number;
  y: number;
  handle: HTMLElement;
};
const drag = shallowRef<Drag | null>(null);
let frame = 0;
let controller: AbortController | null = null;
let rationaleSequence = 0;
const rationaleSaves = new Map<string, { value: string; sequence: number }>();

function rationaleSaved(bookId: string, value: string) {
  rationaleSaves.set(bookId, { value, sequence: ++rationaleSequence });
  const book = books.value.find((item) => item.id === bookId);
  if (book) book.rationale = value;
}

async function refresh() {
  const startedAt = rationaleSequence;
  controller = new AbortController();
  const response = await $fetch<{ data: { books: TbrBook[]; count: number } }>(
    '/api/tbr',
    { signal: controller.signal },
  );
  books.value = response.data.books.map((book) => {
    const saved = rationaleSaves.get(book.id);
    // A rationale can save while this queue request is in flight.
    return saved && saved.sequence > startedAt
      ? { ...book, rationale: saved.value }
      : book;
  });
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    await refresh();
  } catch {
    if (!controller?.signal.aborted)
      error.value = 'Could not load your TBR queue. Try again.';
  } finally {
    loading.value = false;
  }
}

async function move(bookId: string, rank: number) {
  if (busy.value) return;
  const book = books.value.find((item) => item.id === bookId);
  if (!book || rank < 1 || rank > books.value.length || book.rank === rank)
    return;
  busy.value = true;
  error.value = '';
  let saved = false;
  controller = new AbortController();
  try {
    await $fetch(`/api/books/${encodeURIComponent(bookId)}/status`, {
      method: 'POST',
      body: { tbrRank: rank },
      signal: controller.signal,
    });
    saved = true;
    await refresh();
    announcement.value = `${book.title} moved to position ${books.value.find((item) => item.id === bookId)?.rank ?? rank}.`;
  } catch {
    if (!controller?.signal.aborted)
      error.value = saved
        ? 'Order saved, but the queue could not refresh. Reload the queue to continue.'
        : 'Could not save the order. Your previous order is kept. Reload the queue and try again.';
  } finally {
    busy.value = false;
  }
}

function cancelDrag() {
  const previous = drag.value;
  drag.value = null;
  cancelAnimationFrame(frame);
  if (previous?.handle.hasPointerCapture(previous.pointerId))
    previous.handle.releasePointerCapture(previous.pointerId);
}

function updateTarget() {
  const current = drag.value;
  if (!current) return;
  const row = document
    .elementFromPoint(current.x, current.y)
    ?.closest<HTMLElement>('[data-tbr-book]');
  const targetId = row?.dataset.tbrBook;
  if (
    targetId &&
    books.value.some((book) => book.id === targetId) &&
    targetId !== current.targetId
  )
    drag.value = { ...current, targetId };
}

function scrollDrag() {
  const current = drag.value;
  if (!current || !scroller.value) return;
  const bounds = scroller.value.getBoundingClientRect();
  const edge = 48;
  if (current.y < bounds.top + edge)
    scroller.value.scrollTop -= Math.min(
      16,
      (bounds.top + edge - current.y) / 3,
    );
  else if (current.y > bounds.bottom - edge)
    scroller.value.scrollTop += Math.min(
      16,
      (current.y - bounds.bottom + edge) / 3,
    );
  updateTarget();
  frame = requestAnimationFrame(scrollDrag);
}

function startDrag(event: PointerEvent, bookId: string) {
  if (
    busy.value ||
    !event.isPrimary ||
    event.button !== 0 ||
    !(event.currentTarget instanceof HTMLElement)
  )
    return;
  cancelDrag();
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  drag.value = {
    bookId,
    targetId: bookId,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    handle,
  };
  frame = requestAnimationFrame(scrollDrag);
}

function pointerMove(event: PointerEvent) {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return;
  drag.value = { ...drag.value, x: event.clientX, y: event.clientY };
  updateTarget();
}

function drop(event: PointerEvent) {
  const current = drag.value;
  if (!current || current.pointerId !== event.pointerId) return;
  const rank =
    books.value.findIndex((book) => book.id === current.targetId) + 1;
  cancelDrag();
  void move(current.bookId, rank);
}

onMounted(() => {
  ui.setLibraryView('to-be-read');
  void load();
});
onBeforeUnmount(() => {
  controller?.abort();
  cancelDrag();
});
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />
    <div class="px-2 shrink-0 border-b border-(--contrast-border-color)">
      <ViewSelectorDropdown />
    </div>
    <main
      ref="scroller"
      class="w-full flex-1 min-h-0 p-4 overflow-auto"
      :aria-busy="busy || loading"
    >
      <div class="mb-6">
        <h1
          class="text-2xl sm:text-3xl font-serif text-(--contrast-main-color)"
        >
          To be read
        </h1>
        <p
          v-if="!loading"
          class="text-sm italic text-(--contrast-sub-color) mt-1"
        >
          {{ books.length }} book{{ books.length === 1 ? '' : 's' }}
        </p>
      </div>
      <p v-if="loading" role="status">Loading your queue...</p>
      <div v-if="error" role="alert" class="mb-4 text-(--contrast-error-color)">
        <p>{{ error }}</p>
        <button
          type="button"
          class="mt-2 px-3 py-1 border border-(--contrast-border-color) rounded-md"
          :disabled="busy || loading"
          @click="load"
        >
          Reload queue
        </button>
      </div>
      <div v-if="!loading && !error && !books.length" class="py-8 opacity-80">
        <p>Your TBR queue is empty.</p>
        <p class="mt-2">
          Mark a book <strong>To be read</strong> to add it here.
        </p>
        <NuxtLink to="/books" class="inline-flex mt-4 underline"
          >Browse books</NuxtLink
        >
      </div>
      <ol class="flex flex-col gap-5 list-none p-0" aria-label="Your TBR queue">
        <li
          v-for="(book, index) in books"
          :key="book.id"
          :data-tbr-book="book.id"
          class="grid grid-cols-[2rem_5rem_minmax(0,1fr)] sm:grid-cols-[3rem_10rem_minmax(0,1fr)] gap-3 sm:gap-4 pb-5 border-b border-(--contrast-border-color)/20 rounded-sm"
          :class="
            drag?.targetId === book.id && drag.bookId !== book.id
              ? 'outline-2 outline-(--contrast-main-border-color)'
              : ''
          "
        >
          <div
            class="flex flex-col items-center gap-1 row-span-2 text-(--contrast-sub-color)"
          >
            <span
              class="text-xl sm:text-2xl mb-1"
              :aria-label="`Rank ${book.rank}`"
              >{{ book.rank }}</span
            >
            <button
              type="button"
              class="touch-none cursor-grab active:cursor-grabbing p-1"
              :disabled="busy || !!error"
              :aria-label="`Reorder ${book.title}`"
              @pointerdown="startDrag($event, book.id)"
              @pointermove="pointerMove"
              @pointerup="drop"
              @pointercancel="cancelDrag"
              @lostpointercapture="cancelDrag"
              @keydown.up.prevent="move(book.id, book.rank - 1)"
              @keydown.down.prevent="move(book.id, book.rank + 1)"
            >
              <Icon name="lucide:grip-vertical" />
            </button>
            <button
              type="button"
              class="p-1 disabled:opacity-25"
              :disabled="busy || !!error || index === 0"
              :aria-label="`Move ${book.title} up`"
              @click="move(book.id, book.rank - 1)"
            >
              <Icon name="lucide:chevron-up" />
            </button>
            <button
              type="button"
              class="p-1 disabled:opacity-25"
              :disabled="busy || !!error || index === books.length - 1"
              :aria-label="`Move ${book.title} down`"
              @click="move(book.id, book.rank + 1)"
            >
              <Icon name="lucide:chevron-down" />
            </button>
          </div>
          <NuxtLink :to="`/books/${book.id}`" class="self-start"
            ><BookCover
              :src="book.coverThumbnailUrl ?? undefined"
              :alt="book.title"
              :title="book.title"
              class="w-full!"
          /></NuxtLink>
          <div class="min-w-0 flex flex-col gap-1">
            <NuxtLink
              :to="`/books/${book.id}`"
              class="text-xl sm:text-3xl leading-tight font-serif hover:underline wrap-anywhere"
              >{{ book.title }}</NuxtLink
            >
            <div class="font-serif opacity-80">
              <template
                v-for="(author, authorIndex) in book.authors"
                :key="author.id"
                ><span v-if="authorIndex">, </span
                ><NuxtLink
                  :to="`/authors/${author.id}`"
                  class="hover:underline"
                  >{{ author.name }}</NuxtLink
                ></template
              >
            </div>
            <div
              v-if="book.description"
              class="line-clamp-3 text-sm font-light opacity-90 prose prose-sm max-w-none text-(--contrast-text-color)"
            >
              <ClientOnly>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div v-html="sanitizeDescriptionHtml(book.description)" />
                <template #fallback
                  ><span>{{ book.description }}</span></template
                >
              </ClientOnly>
            </div>
          </div>
          <BooksTbrRationaleEditor
            class="col-start-2 col-span-2"
            :book-id="book.id"
            :rationale="book.rationale"
            @saved="rationaleSaved(book.id, $event)"
          />
        </li>
      </ol>
      <p role="status" aria-live="polite" class="sr-only">{{ announcement }}</p>
    </main>
  </div>
</template>
