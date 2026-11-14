<script setup lang="ts">
import BookshelfSpine from './BookshelfSpine.vue';
import type { BookViewBook } from '~/utils/bookFields';
import {
  SHELF_WIDTH,
  SHELF_FLOOR,
  SHELF_MAX_HEIGHT,
  SHELF_MAX_WIDTH,
  minimumBookcaseWidth,
  planShelfDrop,
  minimumShelfHeight,
  itemWidth,
  itemHeight,
  emptyShelf,
  emptyBookshelf,
  reconcileBookshelf,
  parseBookshelf,
  type Bookshelf,
  type Bookcase,
  type Shelf,
  type ShelfItem,
  type ShelfBook,
} from '~~/shared/bookshelf';

defineOptions({ name: 'BookshelfView' });
const props = defineProps<{ endpoint: string; collectionId?: string }>();
type BooksResponse = {
  success?: boolean;
  message?: string;
  data?: { books?: BookViewBook[]; nextCursor?: string | null };
};
type Saved = { revision: number; arrangement: unknown };
type DropPlan = {
  shelfId: string;
  originId: string;
  sourceItems: ShelfItem[];
  items: ShelfItem[];
  x: number;
  bottom: number;
  valid: boolean;
  rect: DOMRect;
  scale: number;
  moving: ShelfItem;
};
type Drag = {
  bookId: string;
  shelfId: string;
  whole: boolean;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  scale: number;
  moved: boolean;
  plan: DropPlan | null;
  x: number;
  y: number;
};
type Resize =
  | {
      axis: 'height';
      shelfId: string;
      start: number;
      original: number;
      scale: number;
    }
  | {
      axis: 'width';
      bookcaseId: string;
      start: number;
      original: number;
      scale: number;
    };

const arrangement = ref<Bookshelf | null>(null);
const catalog = ref<BookViewBook[]>([]);
const matches = ref<Set<string>>(new Set());
const revision = ref(0);
const editing = ref(false);
const selected = ref<string | null>(null);
const selectedShelf = ref<string | null>(null);
const zoom = ref(1);
const width = ref(340);
const wall = ref<HTMLElement | null>(null);
const loading = ref(true);
const loadError = ref('');
const saveError = ref('');
const conflict = ref(false);
const saving = ref(false);
const dirty = ref(false);
const notice = ref('');
const adjustments = ref<string[]>([]);
const drag = ref<Drag | null>(null);
const resizing = ref<Resize | null>(null);
let generation = 0;
let dirtyVersion = 0;
let observer: ResizeObserver | undefined;
let pinch: { distance: number; zoom: number } | null = null;
const byId = computed(
  () => new Map(catalog.value.map((book) => [book.id, book])),
);
const scale = computed(
  () => Math.min(1, width.value / SHELF_WIDTH) * zoom.value,
);
const status = computed(() =>
  conflict.value
    ? 'A newer arrangement exists on another device.'
    : saveError.value
      ? saveError.value
      : saving.value
        ? 'Saving…'
        : dirty.value
          ? 'Unsaved changes'
          : 'Saved',
);
const allShelves = computed(
  () =>
    arrangement.value?.bookcases.flatMap((bookcase) => bookcase.shelves) ?? [],
);
function getShelf(id: string) {
  return allShelves.value.find((shelf) => shelf.id === id);
}
function getBookcase(shelfId: string) {
  return arrangement.value?.bookcases.find((bookcase) =>
    bookcase.shelves.some((shelf) => shelf.id === shelfId),
  );
}
function getItem(bookId: string) {
  for (const shelf of allShelves.value) {
    const item = shelf.items.find((entry) =>
      entry.books.some((book) => book.id === bookId),
    );
    if (item) return { shelf, item };
  }
}
function placementStyle(book: ShelfBook, item: ShelfItem, index: number) {
  const bottom = item.horizontal
    ? item.books.slice(0, index).reduce((sum, entry) => sum + entry.width, 0)
    : 0;
  return {
    width: `${item.horizontal ? book.height : book.width}px`,
    height: `${item.horizontal ? book.width : book.height}px`,
    bottom: `${bottom}px`,
  };
}
function stopNotice() {
  notice.value = '';
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Please try again.';
}

async function fetchAll(
  endpoint: string,
  collectionId?: string,
): Promise<BookViewBook[]> {
  const books: BookViewBook[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const response: BooksResponse = await $fetch<BooksResponse>(endpoint, {
      method: 'GET',
      query: {
        limit: 200,
        sort: 'dateAdded',
        sortDir: 'asc',
        ...(collectionId ? { collectionId } : {}),
        ...(cursor ? { cursor } : {}),
      },
    });
    if (
      !response.success ||
      !response.data ||
      !Array.isArray(response.data.books)
    )
      throw new Error(response.message || 'Could not load your books.');
    books.push(...response.data.books);
    cursor = response.data.nextCursor ?? null;
    if (cursor && seen.has(cursor))
      throw new Error('Could not finish loading your books.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return books;
}
async function loadMatches() {
  const current = ++generation;
  try {
    const books = await fetchAll(props.endpoint, props.collectionId);
    if (current === generation)
      matches.value = new Set(books.map((book) => book.id));
  } catch (error) {
    if (current === generation)
      notice.value = `Could not apply the current filters: ${errorText(error)}`;
  }
}
async function load() {
  loading.value = true;
  loadError.value = '';
  saveError.value = '';
  conflict.value = false;
  try {
    const [saved, books] = await Promise.all([
      $fetch<Saved>('/api/bookshelf'),
      fetchAll('/api/books'),
    ]);
    const parsed =
      saved.arrangement === null
        ? emptyBookshelf()
        : parseBookshelf(saved.arrangement);
    if (!parsed) throw new Error('Your saved bookshelf could not be read.');
    const reconciled = reconcileBookshelf(parsed, books);
    revision.value = saved.revision;
    catalog.value = books;
    arrangement.value = reconciled.bookshelf;
    adjustments.value = reconciled.needsAdjustment;
    matches.value = new Set(books.map((book) => book.id));
    dirty.value = false;
    dirtyVersion = 0;
    await loadMatches();
    if (reconciled.changed || saved.arrangement === null) changed();
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
  }
}
async function save() {
  if (saving.value || !arrangement.value || !dirty.value || conflict.value)
    return;
  saving.value = true;
  saveError.value = '';
  while (dirty.value && !conflict.value) {
    const version = dirtyVersion;
    try {
      const response = await $fetch<{ revision: number }>('/api/bookshelf', {
        method: 'PUT',
        body: {
          revision: revision.value,
          arrangement: structuredClone(toRaw(arrangement.value)),
        },
      });
      revision.value = response.revision;
      if (version === dirtyVersion) dirty.value = false;
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        error.statusCode === 409
      )
        conflict.value = true;
      else
        saveError.value =
          'Could not save your bookshelf. Your changes are still here; retry saving.';
      break;
    }
  }
  saving.value = false;
}
function changed() {
  dirtyVersion++;
  dirty.value = true;
  void save();
}
function retrySave() {
  saveError.value = '';
  void save();
}
function reloadNewer() {
  if (confirm('Discard these unsaved changes and load the newer arrangement?'))
    void load();
}
function canLeave() {
  return (
    (!dirty.value && !saving.value) ||
    confirm('Your bookshelf has unsaved changes. Leave anyway?')
  );
}
defineExpose({ canLeave });
onBeforeRouteLeave(() => canLeave());
function unloadWarning(event: BeforeUnloadEvent) {
  if (dirty.value || saving.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
watch(
  () => [props.endpoint, props.collectionId],
  () => {
    if (arrangement.value) void loadMatches();
  },
);
function onWheel(event: WheelEvent) {
  if (!event.deltaY || resizing.value || drag.value) return;
  event.preventDefault();
  if (event.shiftKey) {
    if (wall.value) wall.value.scrollTop += event.deltaY;
    return;
  }
  zoom.value = Math.max(
    0.5,
    Math.min(2, zoom.value * Math.exp(-event.deltaY * 0.0015)),
  );
}
function touchDistance(touches: TouchList) {
  const first = touches.item(0),
    second = touches.item(1);
  return first && second
    ? Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
    : 0;
}
function onTouchStart(event: TouchEvent) {
  if (event.touches.length !== 2) return;
  if (drag.value || resizing.value) onCancel();
  const distance = touchDistance(event.touches);
  if (distance) pinch = { distance, zoom: zoom.value };
}
function onTouchMove(event: TouchEvent) {
  if (!pinch || event.touches.length !== 2) return;
  if (event.cancelable) event.preventDefault();
  zoom.value = Math.max(
    0.5,
    Math.min(2, (pinch.zoom * touchDistance(event.touches)) / pinch.distance),
  );
}
function onTouchEnd(event: TouchEvent) {
  if (event.touches.length < 2) pinch = null;
}
onMounted(() => {
  if (wall.value) {
    observer = new ResizeObserver(([entry]) => {
      if (entry) width.value = entry.contentRect.width;
    });
    observer.observe(wall.value);
    wall.value.addEventListener('wheel', onWheel, { passive: false });
    wall.value.addEventListener('touchstart', onTouchStart, { passive: true });
    wall.value.addEventListener('touchmove', onTouchMove, { passive: false });
    wall.value.addEventListener('touchend', onTouchEnd);
    wall.value.addEventListener('touchcancel', onTouchEnd);
  }
  window.addEventListener('beforeunload', unloadWarning);
  void load();
});
onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
  wall.value?.removeEventListener('wheel', onWheel);
  wall.value?.removeEventListener('touchstart', onTouchStart);
  wall.value?.removeEventListener('touchmove', onTouchMove);
  wall.value?.removeEventListener('touchend', onTouchEnd);
  wall.value?.removeEventListener('touchcancel', onTouchEnd);
  window.removeEventListener('beforeunload', unloadWarning);
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
});

function toggleEdit() {
  editing.value = !editing.value;
  selected.value = null;
  selectedShelf.value = null;
}
function addBookcase() {
  if (!arrangement.value) return;
  arrangement.value.bookcases.push({
    id: crypto.randomUUID(),
    width: SHELF_WIDTH,
    shelves: [emptyShelf(), emptyShelf(), emptyShelf()],
  });
  changed();
}
function addShelf(shelf: Shelf) {
  const bookcase = getBookcase(shelf.id);
  if (!bookcase) return;
  const added = emptyShelf();
  bookcase.shelves.push(added);
  selectedShelf.value = added.id;
  changed();
}
function removeShelf(shelf: Shelf) {
  const bookcase = getBookcase(shelf.id);
  if (!bookcase) return;
  if (shelf.items.length) {
    notice.value = 'Move the books off this shelf first.';
    return;
  }
  if (bookcase.shelves.length === 1) {
    notice.value = 'A bookcase needs at least one shelf.';
    return;
  }
  bookcase.shelves = bookcase.shelves.filter((item) => item.id !== shelf.id);
  selectedShelf.value = null;
  changed();
}
function removeBookcase(shelf: Shelf) {
  const bookcase = getBookcase(shelf.id);
  if (!arrangement.value || !bookcase) return;
  if (bookcase.shelves.some((entry) => entry.items.length)) {
    notice.value = 'Move the books out of this bookcase first.';
    return;
  }
  if (arrangement.value.bookcases.length === 1) {
    notice.value = 'Keep at least one bookcase.';
    return;
  }
  arrangement.value.bookcases = arrangement.value.bookcases.filter(
    (entry) => entry.id !== bookcase.id,
  );
  selectedShelf.value = null;
  changed();
}
function changeSize(bookId: string, field: 'width' | 'height', event: Event) {
  const found = getItem(bookId);
  if (!found || !(event.target instanceof HTMLInputElement)) return;
  const book = found.item.books.find((entry) => entry.id === bookId);
  if (!book) return;
  const old = book[field];
  book[field] = Number(event.target.value);
  const sorted = [...found.shelf.items].sort((a, b) => a.x - b.x);
  if (
    sorted.some(
      (item, index) =>
        itemHeight(item) > found.shelf.height - SHELF_FLOOR ||
        item.x + itemWidth(item) > getBookcase(found.shelf.id)!.width - 2 ||
        (index > 0 &&
          sorted[index - 1]!.x + itemWidth(sorted[index - 1]!) > item.x),
    )
  ) {
    book[field] = old;
    notice.value = 'That size does not fit. Make room first.';
    event.target.value = String(old);
    return;
  }
  if (field === 'width') book.manualWidth = true;
  else book.manualHeight = true;
  adjustments.value = adjustments.value.filter((id) => id !== bookId);
  changed();
}
function bookFor(id: string): BookViewBook {
  return byId.value.get(id) ?? { id, title: 'Unavailable book' };
}
function startBook(
  event: PointerEvent,
  shelf: Shelf,
  item: ShelfItem,
  book: ShelfBook,
  whole = false,
) {
  if (!editing.value || event.button !== 0) return;
  stopNotice();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const canvas = target.closest<HTMLElement>('[data-shelf-canvas]');
  if (!canvas) return;
  const rect = (
      whole ? (target.closest<HTMLElement>('.shelf-item') ?? target) : target
    ).getBoundingClientRect(),
    shelfScale =
      canvas.getBoundingClientRect().width / getBookcase(shelf.id)!.width;
  drag.value = {
    bookId: book.id,
    shelfId: shelf.id,
    whole,
    startX: event.clientX,
    startY: event.clientY,
    offsetX: (event.clientX - rect.left) / shelfScale,
    offsetY: (event.clientY - rect.top) / shelfScale,
    scale: shelfScale,
    moved: false,
    plan: null,
    x: event.clientX,
    y: event.clientY,
  };
  event.preventDefault();
  attachPointerListeners();
}
function startResize(event: PointerEvent, shelf: Shelf) {
  if (!editing.value || event.button !== 0) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const canvas = target.closest<HTMLElement>('[data-shelf-canvas]');
  const bookcase = getBookcase(shelf.id);
  if (!canvas || !bookcase) return;
  resizing.value = {
    axis: 'height',
    shelfId: shelf.id,
    start: event.clientY,
    original: shelf.height,
    scale: canvas.getBoundingClientRect().width / bookcase.width,
  };
  event.preventDefault();
  attachPointerListeners();
}
function startBookcaseResize(event: PointerEvent, bookcase: Bookcase) {
  if (!editing.value || event.button !== 0) return;
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const element = target.closest<HTMLElement>('.bookcase');
  if (!element) return;
  resizing.value = {
    axis: 'width',
    bookcaseId: bookcase.id,
    start: event.clientX,
    original: bookcase.width,
    scale: element.getBoundingClientRect().width / bookcase.width,
  };
  event.preventDefault();
  attachPointerListeners();
}
function attachPointerListeners() {
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
function detachPointerListeners() {
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
}
function planDrop(
  current: Drag,
  clientX: number,
  clientY: number,
): DropPlan | null {
  const canvas = document
    .elementsFromPoint(clientX, clientY)
    .find(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && !!el.dataset.shelfCanvas,
    );
  const destination = canvas?.dataset.shelfCanvas
    ? getShelf(canvas.dataset.shelfCanvas)
    : undefined;
  const origin = getShelf(current.shelfId),
    source = origin?.items.find((item) =>
      item.books.some((book) => book.id === current.bookId),
    );
  if (!canvas || !destination || !origin || !source) return null;
  const bookcase = getBookcase(destination.id);
  if (!bookcase) return null;
  const rect = canvas.getBoundingClientRect(),
    shelfScale = rect.width / bookcase.width;
  const planned = planShelfDrop(
    toRaw(origin),
    toRaw(destination),
    bookcase.width,
    current.bookId,
    current.whole,
    (clientX - rect.left) / shelfScale,
    (rect.bottom - clientY) / shelfScale - SHELF_FLOOR,
    current.offsetX,
    current.offsetY,
  );
  if (!planned) return null;
  return {
    ...planned,
    shelfId: destination.id,
    originId: origin.id,
    rect,
    scale: shelfScale,
  };
}
function onMove(event: PointerEvent) {
  if (resizing.value) {
    const state = resizing.value;
    const coordinate = state.axis === 'width' ? event.clientX : event.clientY;
    const proposed = Math.round(
      state.original + (coordinate - state.start) / state.scale,
    );
    if (state.axis === 'width') {
      const bookcase = arrangement.value?.bookcases.find(
        (entry) => entry.id === state.bookcaseId,
      );
      if (bookcase)
        bookcase.width = Math.max(
          minimumBookcaseWidth(bookcase),
          Math.min(SHELF_MAX_WIDTH, proposed),
        );
    } else {
      const shelf = getShelf(state.shelfId);
      if (shelf)
        shelf.height = Math.max(
          minimumShelfHeight(shelf),
          Math.min(SHELF_MAX_HEIGHT, proposed),
        );
    }
    return;
  }
  const state = drag.value;
  if (!state) return;
  state.x = event.clientX;
  state.y = event.clientY;
  if (
    Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 5
  )
    state.moved = true;
  if (state.moved) state.plan = planDrop(state, event.clientX, event.clientY);
}
function onUp(event: PointerEvent) {
  detachPointerListeners();
  if (resizing.value) {
    const state = resizing.value;
    const current =
      state.axis === 'width'
        ? arrangement.value?.bookcases.find(
            (entry) => entry.id === state.bookcaseId,
          )?.width
        : getShelf(state.shelfId)?.height;
    resizing.value = null;
    if (current !== undefined && current !== state.original) changed();
    return;
  }
  const state = drag.value;
  drag.value = null;
  if (!state) return;
  if (!state.moved) {
    selected.value = state.bookId;
    selectedShelf.value = null;
    return;
  }
  const plan = planDrop(state, event.clientX, event.clientY);
  if (!plan || !plan.valid) {
    notice.value = plan
      ? 'This book will not fit on that shelf.'
      : 'Drop onto a shelf to move the book.';
    return;
  }
  const destination = getShelf(plan.shelfId),
    origin = getShelf(plan.originId);
  if (!destination || !origin) return;
  destination.items = plan.items;
  if (destination.id !== origin.id) origin.items = plan.sourceItems;
  selected.value = state.bookId;
  selectedShelf.value = null;
  changed();
}
function onCancel() {
  detachPointerListeners();
  if (resizing.value) {
    const state = resizing.value;
    if (state.axis === 'width') {
      const bookcase = arrangement.value?.bookcases.find(
        (entry) => entry.id === state.bookcaseId,
      );
      if (bookcase) bookcase.width = state.original;
    } else {
      const shelf = getShelf(state.shelfId);
      if (shelf) shelf.height = state.original;
    }
  }
  resizing.value = null;
  drag.value = null;
}
const ghost = computed(() => {
  const state = drag.value;
  if (!state?.moved) return null;
  const found = getItem(state.bookId);
  if (!found) return null;
  const chosen = found.item.books.find((book) => book.id === state.bookId);
  if (!chosen) return null;
  const plan = state.plan;
  const moving =
    plan?.moving ??
    (state.whole
      ? found.item
      : {
          x: found.item.x,
          horizontal: found.item.horizontal,
          books: [chosen],
        });
  const currentScale = plan?.scale ?? state.scale;
  const left = plan
    ? plan.rect.left + plan.x * currentScale
    : state.x - state.offsetX * currentScale;
  const top = plan
    ? plan.rect.bottom -
      plan.bottom * currentScale -
      itemHeight(moving) * currentScale
    : state.y - state.offsetY * currentScale;
  return {
    item: moving,
    invalid: !!plan && !plan.valid,
    style: {
      left: `${left}px`,
      top: `${top}px`,
      width: `${itemWidth(moving)}px`,
      height: `${itemHeight(moving)}px`,
      transform: `scale(${currentScale})`,
    },
  };
});
const selectedBook = computed(() =>
  selected.value
    ? getItem(selected.value)?.item.books.find(
        (book) => book.id === selected.value,
      )
    : undefined,
);
const currentShelf = computed(() =>
  selectedShelf.value ? getShelf(selectedShelf.value) : undefined,
);
</script>

<template>
  <div class="bookshelf-view">
    <div class="bookshelf-toolbar">
      <button type="button" class="edit-button" @click="toggleEdit">
        {{ editing ? 'Done editing' : 'Edit shelves' }}
      </button>
      <div class="zoom-controls" role="group" aria-label="Bookshelf zoom">
        <button
          type="button"
          aria-label="Zoom out"
          :disabled="zoom <= 0.5"
          @click="zoom = Math.max(0.5, +(zoom - 0.1).toFixed(1))"
        >
          −
        </button>
        <button type="button" aria-label="Reset zoom" @click="zoom = 1">
          {{ Math.round(zoom * 100) }}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          :disabled="zoom >= 2"
          @click="zoom = Math.min(2, +(zoom + 0.1).toFixed(1))"
        >
          +
        </button>
      </div>
      <details v-if="editing" class="case-menu">
        <summary aria-label="Bookshelf options">•••</summary>
        <button type="button" @click="addBookcase">Add bookcase</button>
      </details>
      <span class="zoom-hint"
        >Wheel or pinch to zoom · Shift + wheel to scroll</span
      >
      <span class="save-status" role="status">{{ status }}</span>
      <button v-if="saveError" type="button" @click="retrySave">
        Retry save
      </button>
      <button v-if="conflict" type="button" @click="reloadNewer">
        Load newer arrangement
      </button>
    </div>
    <p v-if="notice" class="notice" role="status">
      {{ notice }} <button type="button" @click="stopNotice">Dismiss</button>
    </p>
    <p v-if="adjustments.length" class="notice">
      Some page counts changed, but their books no longer fit at the updated
      thickness. Adjust the highlighted books manually.
    </p>
    <p v-if="loading">Loading your bookshelf…</p>
    <div v-else-if="loadError" role="alert">
      {{ loadError }} <button type="button" @click="load">Try again</button>
    </div>
    <p v-if="editing" class="stack-hint">
      Pull a book down to lay it flat or lift it to stand it upright. Drag a
      book onto a sideways spine to stack it.
    </p>
    <div ref="wall" class="wall-viewport">
      <div v-if="arrangement && !loading" class="wall">
        <div
          v-for="(bookcase, caseIndex) in arrangement.bookcases"
          :key="bookcase.id"
          class="bookcase"
          :style="{
            width: `${bookcase.width * scale}px`,
          }"
        >
          <div
            v-for="(shelf, shelfIndex) in bookcase.shelves"
            :key="shelf.id"
            class="shelf-viewport"
            :style="{
              width: `${bookcase.width * scale}px`,
              height: `${shelf.height * scale}px`,
            }"
          >
            <div
              class="shelf-canvas"
              :data-shelf-canvas="shelf.id"
              :style="{
                height: `${shelf.height}px`,
                width: `${bookcase.width}px`,
                transform: `scale(${scale})`,
              }"
            >
              <div
                v-for="item in shelf.items"
                :key="item.books[0]?.id"
                class="shelf-item"
                :class="{
                  moving:
                    drag?.moved &&
                    drag.shelfId === shelf.id &&
                    item.books.some((book) => book.id === drag?.bookId),
                }"
                :style="{
                  left: `${item.x}px`,
                  width: `${itemWidth(item)}px`,
                  height: `${itemHeight(item)}px`,
                }"
              >
                <button
                  v-for="(book, index) in item.books"
                  :key="book.id"
                  type="button"
                  class="spine-button"
                  :class="{
                    selected: selected === book.id,
                    needs: adjustments.includes(book.id),
                    arranging: editing,
                  }"
                  :style="placementStyle(book, item, index)"
                  :aria-label="`${bookFor(book.id).title}${editing ? ', arrange book' : ', open book'}`"
                  @pointerdown.stop="startBook($event, shelf, item, book)"
                  @click="!editing && navigateTo(`/books/${book.id}`)"
                >
                  <BookshelfSpine
                    :placement="book"
                    :book="bookFor(book.id)"
                    :horizontal="item.horizontal"
                    :dimmed="!matches.has(book.id)"
                  />
                </button>
                <button
                  v-if="editing && item.books.length > 1 && item.books[0]"
                  type="button"
                  class="stack-handle"
                  aria-label="Drag stack"
                  @pointerdown.stop="
                    startBook($event, shelf, item, item.books[0], true)
                  "
                >
                  ⠿
                </button>
              </div>
              <button
                v-if="editing"
                type="button"
                class="shelf-options"
                :aria-label="`Options for bookcase ${caseIndex + 1}, shelf ${shelfIndex + 1}`"
                @click="
                  selectedShelf = shelf.id;
                  selected = null;
                "
              >
                •••
              </button>
              <div
                v-if="editing"
                class="height-handle"
                :class="{
                  active:
                    resizing?.axis === 'height' &&
                    resizing.shelfId === shelf.id,
                  limit: shelf.height === minimumShelfHeight(shelf),
                }"
                title="Drag to change shelf height"
                @pointerdown.stop="startResize($event, shelf)"
              >
                <span>↕</span
                ><output
                  v-if="
                    resizing?.axis === 'height' && resizing.shelfId === shelf.id
                  "
                  >{{ shelf.height }} px</output
                >
              </div>
            </div>
          </div>
          <div
            v-if="editing"
            class="width-handle"
            :class="{
              limit: bookcase.width === minimumBookcaseWidth(bookcase),
            }"
            title="Drag to change bookcase width"
            @pointerdown.stop="startBookcaseResize($event, bookcase)"
          >
            <span>↔</span
            ><output
              v-if="
                resizing?.axis === 'width' &&
                resizing.bookcaseId === bookcase.id
              "
              >{{ bookcase.width }} px</output
            >
          </div>
        </div>
      </div>
    </div>
    <aside
      v-if="editing && selectedBook && selected"
      class="shelf-panel"
      aria-label="Book options"
    >
      <div class="panel-heading">
        <strong>{{ bookFor(selected).title }}</strong
        ><button
          type="button"
          aria-label="Close book options"
          @click="selected = null"
        >
          ×
        </button>
      </div>
      <label
        >Height · {{ selectedBook.height }}
        <input
          type="range"
          min="120"
          max="230"
          :value="selectedBook.height"
          @change="changeSize(selected!, 'height', $event)"
      /></label>
      <label
        >Thickness · {{ selectedBook.width }}
        <input
          type="range"
          min="20"
          max="55"
          :value="selectedBook.width"
          @change="changeSize(selected!, 'width', $event)"
      /></label>
    </aside>
    <aside
      v-if="editing && currentShelf"
      class="shelf-panel"
      aria-label="Shelf options"
    >
      <div class="panel-heading">
        <strong>Shelf options</strong
        ><button
          type="button"
          aria-label="Close shelf options"
          @click="selectedShelf = null"
        >
          ×
        </button>
      </div>
      <p>
        {{ getBookcase(currentShelf.id)?.shelves.length }} shelves in this
        bookcase.
      </p>
      <div class="panel-actions">
        <button type="button" @click="addShelf(currentShelf)">Add shelf</button
        ><button type="button" @click="removeShelf(currentShelf)">
          Remove this shelf</button
        ><button type="button" @click="removeBookcase(currentShelf)">
          Remove empty bookcase
        </button>
      </div>
    </aside>
    <Teleport to="body"
      ><div
        v-if="ghost"
        class="shelf-ghost"
        :class="{ invalid: ghost.invalid }"
        :style="ghost.style"
      >
        <span
          v-for="(book, index) in ghost.item.books"
          :key="book.id"
          class="ghost-book"
          :style="placementStyle(book, ghost.item, index)"
          ><BookshelfSpine
            :placement="book"
            :book="bookFor(book.id)"
            :horizontal="ghost.item.horizontal"
        /></span></div
    ></Teleport>
  </div>
</template>

<style scoped>
.bookshelf-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  gap: 10px;
}
.bookshelf-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 2px;
}
.bookshelf-toolbar button,
.shelf-panel button,
.case-menu summary {
  border: 1px solid var(--contrast-border-color);
  border-radius: 6px;
  padding: 6px 10px;
  background: var(--bg-color);
  color: var(--contrast-main-color);
  cursor: pointer;
}
.bookshelf-toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}
.bookshelf-toolbar .edit-button {
  background: var(--sub-color);
  color: var(--bg-color);
}
.zoom-controls {
  display: flex;
  gap: 3px;
}
.save-status {
  color: var(--contrast-text-color);
  font-size: 12px;
  margin-left: auto;
}
.case-menu {
  position: relative;
}
.case-menu summary {
  list-style: none;
  cursor: pointer;
}
.case-menu button {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 12;
  white-space: nowrap;
}
.notice {
  color: var(--contrast-main-color);
  font-size: 13px;
}
.notice button {
  text-decoration: underline;
}
.wall-viewport {
  flex: 1;
  min-height: 0;
  overflow: auto;
  touch-action: pan-x pan-y;
}
.wall {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: safe center;
  width: 100%;
}
.bookcase {
  flex: 0 0 auto;
  position: relative;
}
.shelf-viewport {
  position: relative;
  overflow: hidden;
}
.shelf-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 340px;
  transform-origin: top left;
  border: 5px solid #b99b79;
  border-bottom: 0;
  background: linear-gradient(110deg, #e9e5db, #f4f1e9 45%, #e9e6dc);
  box-sizing: border-box;
}
.shelf-canvas:after {
  content: '';
  position: absolute;
  left: -5px;
  right: -5px;
  bottom: 0;
  height: 14px;
  background: linear-gradient(#c6a987, #af8c69 45%, #9c795b);
  pointer-events: none;
}
.shelf-item {
  position: absolute;
  bottom: 14px;
  z-index: 2;
}
.shelf-item.moving {
  opacity: 0.35;
}
.spine-button {
  position: absolute;
  left: 0;
  border: 0;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.spine-button.arranging {
  cursor: grab;
  touch-action: none;
}
.spine-button.selected {
  outline: 3px solid #e5ba72;
  outline-offset: 1px;
  z-index: 3;
}
.spine-button.needs {
  outline: 2px solid #ca6f40;
  outline-offset: 1px;
}
.stack-handle {
  position: absolute;
  right: -8px;
  top: -18px;
  z-index: 4;
  padding: 1px 7px;
  border-radius: 8px;
  background: #fff8ed;
  color: #69543e;
  cursor: grab;
  touch-action: none;
}
.shelf-options {
  position: absolute;
  right: 3px;
  top: 3px;
  z-index: 5;
  border-radius: 5px;
  background: #ffffffa8;
  color: #605c52;
  padding: 3px 6px;
  cursor: pointer;
}
.height-handle {
  position: absolute;
  bottom: 0;
  left: -5px;
  right: -5px;
  z-index: 6;
  height: 18px;
  text-align: center;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
}
.height-handle span {
  display: inline-block;
  line-height: 18px;
  padding: 0 12px;
  border-radius: 4px;
  background: #5b6f5b;
  color: white;
}
.height-handle.limit span {
  background: #9d573b;
}
.height-handle output {
  position: absolute;
  bottom: 23px;
  left: 50%;
  transform: translateX(-50%);
  background: #314f42;
  color: white;
  border-radius: 5px;
  padding: 4px 8px;
  white-space: nowrap;
  font-size: 11px;
}
.shelf-panel {
  position: absolute;
  z-index: 10;
  top: 55px;
  right: 12px;
  width: 250px;
  max-height: 65%;
  overflow: auto;
  padding: 15px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 8px;
  background: var(--bg-color);
  color: var(--contrast-main-color);
  box-shadow: 0 5px 25px #0003;
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: start;
}
.shelf-panel label {
  display: block;
  margin: 12px 0;
  font-size: 12px;
}
.shelf-panel input {
  display: block;
  width: 100%;
}
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.shelf-ghost {
  position: fixed;
  z-index: 9999;
  pointer-events: none;
  transform-origin: top left;
  filter: drop-shadow(0 5px 7px #0005);
}
.shelf-ghost.invalid {
  filter: grayscale(0.6) drop-shadow(0 0 4px #b23535);
  opacity: 0.7;
}
.ghost-book {
  position: absolute;
  left: 0;
}
@media (max-width: 600px) {
  .shelf-panel {
    position: fixed;
    top: auto;
    bottom: 14px;
    right: 14px;
    left: 14px;
    width: auto;
    max-height: 38vh;
  }
  .save-status {
    margin-left: 0;
  }
}
</style>

<style scoped>
.zoom-hint {
  color: var(--contrast-text-color);
  font-size: 11px;
}
.stack-hint {
  font-size: 12px;
  color: var(--contrast-text-color);
}
.width-handle {
  position: absolute;
  right: -5px;
  top: 50%;
  transform: translateY(-50%);
  height: 44px;
  width: 20px;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
}
.width-handle span {
  display: block;
  padding: 7px 2px;
  border-radius: 4px;
  background: #5b6f5b;
  color: white;
}
.width-handle.limit span {
  background: #9d573b;
}
.width-handle output {
  position: absolute;
  right: 23px;
  top: 50%;
  transform: translateY(-50%);
  background: #314f42;
  color: white;
  border-radius: 5px;
  padding: 4px 8px;
  white-space: nowrap;
  font-size: 11px;
}
@media (max-width: 600px) {
  .zoom-hint {
    display: none;
  }
}
</style>
