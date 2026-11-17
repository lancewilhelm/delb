<script setup lang="ts">
import BookshelfSpine from './BookshelfSpine.vue';
import BookshelfBookcase from './BookshelfBookcase.vue';
import { placementStyle } from '~/utils/bookshelfPlacement';
import {
  booksInRectangle,
  moveSelectedBooks,
} from '~~/shared/bookshelf-selection';
import {
  bookshelfViewKey,
  readBookshelfView,
  saveBookshelfView,
} from '~/utils/bookshelfViewPosition';
import type { BookViewBook } from '~/utils/bookFields';
import {
  SHELF_WIDTH,
  SHELF_CASE_GAP,
  SHELF_FLOOR,
  SHELF_MAX_HEIGHT,
  SHELF_MAX_WIDTH,
  minimumBookcaseWidth,
  planShelfDrop,
  minimumShelfHeight,
  itemWidth,
  itemHeight,
  shiftStackBook,
  emptyShelf,
  parseBookshelf,
  type Bookshelf,
  type Bookcase,
  type Shelf,
  type ShelfItem,
  type ShelfBook,
  type ShelfPicture,
} from '~~/shared/bookshelf';

defineOptions({ name: 'BookshelfView' });
const userSettingsStore = useUserSettingsStore();
const props = defineProps<{
  endpoint: string;
  collectionId?: string;
  personalShelfId?: string;
}>();
const shelfPath = computed(() =>
  props.personalShelfId
    ? `/api/shelves/${encodeURIComponent(props.personalShelfId)}`
    : `/api/collections/${encodeURIComponent(props.collectionId!)}/bookshelf`,
);
type BooksResponse = {
  success?: boolean;
  message?: string;
  data?: { books?: Pick<BookViewBook, 'id'>[]; nextCursor?: string | null };
};
type Saved = {
  revision: number;
  token: string;
  arrangement: unknown;
  books: (BookViewBook & { canResize?: boolean })[];
  canEdit: boolean;
  adjustments: string[];
};
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
      floor: number;
      cameraY: number;
    }
  | {
      axis: 'width';
      bookcaseId: string;
      start: number;
      original: number;
      scale: number;
    };
type Pan = {
  pointerId: number;
  x: number;
  y: number;
  cameraX: number;
  cameraY: number;
};
type TouchPan = {
  x: number;
  y: number;
  cameraX: number;
  cameraY: number;
  moved: boolean;
};
type BookcaseDrag = {
  id: string;
  pointerId: number;
  startX: number;
  x: number;
  startCameraX: number;
  cameraX: number;
  beforeId: string | null;
  moved: boolean;
};

const arrangement = ref<Bookshelf | null>(null);
const catalog = ref<(BookViewBook & { canResize?: boolean })[]>([]);
const matches = ref<Set<string>>(new Set());
const revision = ref(0);
const catalogToken = ref('');
const canEdit = ref(false);
const editing = ref(false);
const selected = ref<string | null>(null);
const selectedBooks = ref<Set<string>>(new Set());
const marquee = ref<{
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  previousSelection: Set<string>;
} | null>(null);
const groupDrag = ref<{
  pointerId: number;
  shelfId: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  moved: boolean;
} | null>(null);
const selectedPicture = ref<string | null>(null);
const pictureInput = ref<HTMLInputElement | null>(null);
const uploadingPicture = ref(false);
const pictureDrag = ref<{
  pointerId: number;
  id: string;
  startX: number;
  startY: number;
  x: number;
  y: number;
  previewX: number;
  previewY: number;
} | null>(null);
const picturePath = computed(
  () =>
    `/api/bookshelf-pictures/${props.personalShelfId ? 'personal' : 'collection'}/${encodeURIComponent(props.personalShelfId ?? props.collectionId ?? '')}`,
);
const zoom = ref(1);
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const WALL_SIDE_PADDING = 28;
const WALL_TOP_PADDING = 36;
const FLOOR_LINE_HEIGHT = 2;
const width = ref(340);
const viewportHeight = ref(0);
const camera = reactive({ x: 0, y: 0 });
const authUser = useState<{ id: string } | null>('auth:user');
let viewKey: string | null = null;
let viewSaveTimer: ReturnType<typeof setTimeout> | undefined;
let sliderSaveTimer: ReturnType<typeof setTimeout> | undefined;
let pictureResizeRatio: { id: string; ratio: number } | null = null;
function saveView() {
  if (!viewKey) return;
  try {
    saveBookshelfView(localStorage, viewKey, { ...camera, zoom: zoom.value });
  } catch {
    // Accessing localStorage itself can fail in restricted browser contexts.
  }
}
function centerBookshelf() {
  camera.x = 0;
  camera.y = 0;
  zoom.value = 1;
}
watch([() => camera.x, () => camera.y, zoom], () => {
  if (!viewKey) return;
  clearTimeout(viewSaveTimer);
  viewSaveTimer = setTimeout(saveView, 200);
});
const wall = ref<HTMLElement | null>(null);
const controlsLayer = ref<HTMLElement | null>(null);
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
const pan = ref<Pan | null>(null);
const bookcaseDrag = ref<BookcaseDrag | null>(null);
const spaceHeld = ref(false);
const pointerOverWall = ref(false);
let generation = 0;
let catalogGeneration = 0;
let refreshPending = false;
let disposed = false;
let dirtyVersion = 0;
let observer: ResizeObserver | undefined;
let pinch: { distance: number; zoom: number } | null = null;
let touchPan: TouchPan | null = null;
let scrollFrame: number | null = null;
let suppressPanClick = false;
const byId = computed(
  () => new Map(catalog.value.map((book) => [book.id, book])),
);
const focusedCaseId = ref<string | null>(null);
const focusedShelfId = ref<string | null>(null);
function onWallFocus(event: FocusEvent) {
  if (!(event.target instanceof HTMLElement)) return;
  focusedCaseId.value =
    event.target.closest<HTMLElement>('[data-bookcase-id]')?.dataset
      .bookcaseId ??
    event.target.closest<HTMLElement>('[data-control-case-id]')?.dataset
      .controlCaseId ??
    null;
  focusedShelfId.value =
    event.target.closest<HTMLElement>('[data-shelf-canvas]')?.dataset
      .shelfCanvas ??
    event.target.closest<HTMLElement>('[data-control-shelf-id]')?.dataset
      .controlShelfId ??
    null;
}
function onWallKeydown(event: KeyboardEvent) {
  if (
    (event.target !== wall.value &&
      !(
        event.altKey &&
        event.target instanceof HTMLElement &&
        event.target.closest('.spine-button')
      )) ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [100, 0],
    ArrowRight: [-100, 0],
    ArrowUp: [0, 100],
    ArrowDown: [0, -100],
  };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  camera.x += direction[0];
  camera.y += direction[1];
}
const scale = computed(
  () => Math.min(1, width.value / SHELF_WIDTH) * zoom.value,
);
function shelfFrame(atZoom: number) {
  const scaleAtZoom = Math.min(1, width.value / SHELF_WIDTH) * atZoom;
  const bookcases = arrangement.value?.bookcases ?? [];
  const totalWidth =
    (bookcases.reduce((total, bookcase) => total + bookcase.width, 0) +
      Math.max(0, bookcases.length - 1) * SHELF_CASE_GAP) *
    scaleAtZoom;
  const tallest =
    Math.max(
      0,
      ...bookcases.map((bookcase) =>
        bookcase.shelves.reduce((height, shelf) => height + shelf.height, 0),
      ),
    ) * scaleAtZoom;
  const height = tallest + WALL_TOP_PADDING + FLOOR_LINE_HEIGHT;
  return {
    scale: scaleAtZoom,
    left: Math.max(WALL_SIDE_PADDING, (width.value - totalWidth) / 2),
    floor:
      Math.max(0, (viewportHeight.value - height) / 2) +
      height -
      FLOOR_LINE_HEIGHT,
  };
}
const floorTop = computed(() => shelfFrame(zoom.value).floor + camera.y);
const casePositions = computed(() => {
  let left = shelfFrame(zoom.value).left + camera.x;
  return (arrangement.value?.bookcases ?? []).map((bookcase) => {
    const position = left;
    left += (bookcase.width + SHELF_CASE_GAP) * scale.value;
    return position;
  });
});
const visibleCaseIds = computed(() => {
  const cases = arrangement.value?.bookcases ?? [];
  const result = new Set<string>();
  let left = shelfFrame(zoom.value).left + camera.x;
  for (const bookcase of cases) {
    const right = left + bookcase.width * scale.value;
    const active =
      bookcase.shelves.some(
        (shelf) =>
          shelf.id === drag.value?.shelfId ||
          (resizing.value?.axis === 'height' &&
            resizing.value.shelfId === shelf.id),
      ) ||
      (resizing.value?.axis === 'width' &&
        resizing.value.bookcaseId === bookcase.id);
    if (
      (right >= -600 && left <= width.value + 600) ||
      active ||
      bookcase.id === focusedCaseId.value ||
      bookcase.id === bookcaseDrag.value?.id
    )
      result.add(bookcase.id);
    left = right + SHELF_CASE_GAP * scale.value;
  }
  return result;
});
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
function stopNotice() {
  notice.value = '';
}
function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Please try again.';
}

async function fetchAll(
  endpoint: string,
  collectionId?: string,
): Promise<Pick<BookViewBook, 'id'>[]> {
  const books: Pick<BookViewBook, 'id'>[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const response: BooksResponse = await $fetch<BooksResponse>(endpoint, {
      method: 'GET',
      query: {
        limit: 20000,
        idsOnly: '1',
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
  if (
    props.endpoint === '/api/books' ||
    (props.personalShelfId &&
      props.endpoint ===
        `/api/books?shelfId=${encodeURIComponent(props.personalShelfId)}`)
  ) {
    matches.value = new Set(
      catalog.value
        .filter(
          (book) =>
            !props.collectionId || book.collectionId === props.collectionId,
        )
        .map((book) => book.id),
    );
    return;
  }
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
  catalogGeneration++;
  loading.value = true;
  loadError.value = '';
  saveError.value = '';
  conflict.value = false;
  try {
    const saved = await $fetch<Saved>(shelfPath.value);
    const books = saved.books;
    const parsed = parseBookshelf(saved.arrangement);
    if (!parsed) throw new Error('Your saved bookshelf could not be read.');
    revision.value = saved.revision;
    catalogToken.value = saved.token;
    canEdit.value = saved.canEdit;
    catalog.value = books;
    arrangement.value = parsed;
    adjustments.value = saved.adjustments;
    matches.value = new Set(books.map((book) => book.id));
    dirty.value = false;
    dirtyVersion = 0;
    await loadMatches();
  } catch (error) {
    loadError.value = errorText(error);
  } finally {
    loading.value = false;
    if (refreshPending && !disposed) {
      refreshPending = false;
      void refreshCatalog();
    }
  }
}
async function refreshCatalog() {
  if (loading.value) {
    refreshPending = true;
    return;
  }
  if (dirty.value || saving.value) {
    refreshPending = true;
    return;
  }
  const current = ++catalogGeneration;
  const startingVersion = dirtyVersion;
  try {
    const saved = await $fetch<Saved>(shelfPath.value);
    if (current !== catalogGeneration || !arrangement.value) return;
    if (dirtyVersion !== startingVersion || dirty.value || saving.value) {
      refreshPending = true;
      return;
    }
    const parsed = parseBookshelf(saved.arrangement);
    if (!parsed) throw new Error('The current arrangement could not be read.');
    catalog.value = saved.books;
    arrangement.value = parsed;
    revision.value = saved.revision;
    catalogToken.value = saved.token;
    canEdit.value = saved.canEdit;
    adjustments.value = saved.adjustments;
    await loadMatches();
  } catch (error) {
    if (current === catalogGeneration)
      notice.value = `Could not refresh your bookshelf: ${errorText(error)}`;
  } finally {
    if (current === catalogGeneration) resumePendingRefresh();
  }
}
function resumePendingRefresh() {
  if (
    disposed ||
    !refreshPending ||
    loading.value ||
    saving.value ||
    dirty.value ||
    conflict.value
  )
    return;
  refreshPending = false;
  void refreshCatalog();
}
async function save() {
  if (saving.value || !arrangement.value || !dirty.value || conflict.value)
    return;
  saving.value = true;
  saveError.value = '';
  while (dirty.value && !conflict.value) {
    const version = dirtyVersion;
    try {
      const response = await $fetch<{ revision: number; token: string }>(
        shelfPath.value,
        {
          method: 'PUT',
          body: {
            revision: revision.value,
            token: catalogToken.value,
            arrangement: structuredClone(toRaw(arrangement.value)),
          },
        },
      );
      revision.value = response.revision;
      catalogToken.value = response.token;
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
  resumePendingRefresh();
}
function changed() {
  dirtyVersion++;
  dirty.value = true;
  void save();
}
function sliderChanged(commit: boolean) {
  dirtyVersion++;
  dirty.value = true;
  clearTimeout(sliderSaveTimer);
  if (commit) void save();
  else sliderSaveTimer = setTimeout(() => void save(), 250);
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
defineExpose({ canLeave, refreshCatalog });
onBeforeRouteLeave(() => canLeave());
function unloadWarning(event: BeforeUnloadEvent) {
  clearTimeout(viewSaveTimer);
  saveView();
  if (dirty.value || saving.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
watch(
  () => [props.endpoint, props.collectionId, props.personalShelfId],
  () => {
    if (arrangement.value) void loadMatches();
  },
);
function onWheel(event: WheelEvent) {
  if (
    resizing.value ||
    drag.value ||
    bookcaseDrag.value ||
    pictureDrag.value ||
    groupDrag.value ||
    marquee.value
  )
    return;
  if (!event.deltaY && !event.deltaX) return;
  event.preventDefault();
  if (event.shiftKey) {
    camera.y -= event.deltaY;
    camera.x -= event.deltaX;
    return;
  }
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    camera.x -= event.deltaX;
    camera.y -= event.deltaY;
    return;
  }
  const nextZoom = Math.max(
    MIN_ZOOM,
    Math.min(MAX_ZOOM, zoom.value * Math.exp(-event.deltaY * 0.0015)),
  );
  if (nextZoom === zoom.value) return;
  if (wall.value) {
    const before = shelfFrame(zoom.value);
    const after = shelfFrame(nextZoom);
    if (before.scale > 0) {
      const bounds = wall.value.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const ratio = after.scale / before.scale;
      camera.x = x - after.left - (x - before.left - camera.x) * ratio;
      camera.y = y - after.floor - (y - before.floor - camera.y) * ratio;
    }
  }
  zoom.value = nextZoom;
}
function touchDistance(touches: TouchList) {
  const first = touches.item(0),
    second = touches.item(1);
  return first && second
    ? Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY)
    : 0;
}
function onTouchStart(event: TouchEvent) {
  if (event.touches.length === 2) {
    touchPan = null;
    if (
      drag.value ||
      resizing.value ||
      bookcaseDrag.value ||
      pan.value ||
      pictureDrag.value ||
      groupDrag.value ||
      marquee.value
    )
      onCancel();
    const distance = touchDistance(event.touches);
    if (distance) pinch = { distance, zoom: zoom.value };
    return;
  }
  if (
    event.touches.length !== 1 ||
    drag.value ||
    resizing.value ||
    bookcaseDrag.value ||
    pictureDrag.value ||
    groupDrag.value ||
    marquee.value
  )
    return;
  const touch = event.touches.item(0);
  if (touch)
    touchPan = {
      x: touch.clientX,
      y: touch.clientY,
      cameraX: camera.x,
      cameraY: camera.y,
      moved: false,
    };
}
function onTouchMove(event: TouchEvent) {
  if (pinch && event.touches.length === 2) {
    if (event.cancelable) event.preventDefault();
    zoom.value = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        (pinch.zoom * touchDistance(event.touches)) / pinch.distance,
      ),
    );
    return;
  }
  if (
    !touchPan ||
    event.touches.length !== 1 ||
    drag.value ||
    resizing.value ||
    bookcaseDrag.value ||
    pictureDrag.value ||
    groupDrag.value ||
    marquee.value
  )
    return;
  const touch = event.touches.item(0);
  if (!touch) return;
  if (Math.hypot(touch.clientX - touchPan.x, touch.clientY - touchPan.y) > 5)
    touchPan.moved = true;
  if (!touchPan.moved) return;
  if (event.cancelable) event.preventDefault();
  camera.x = touchPan.cameraX + touch.clientX - touchPan.x;
  camera.y = touchPan.cameraY + touch.clientY - touchPan.y;
  suppressPanClick = true;
}
function onTouchEnd(event: TouchEvent) {
  if (event.touches.length < 2 && pinch) {
    pinch = null;
    const touch = event.touches.item(0);
    if (touch)
      touchPan = {
        x: touch.clientX,
        y: touch.clientY,
        cameraX: camera.x,
        cameraY: camera.y,
        moved: false,
      };
  }
  if (event.touches.length === 0) {
    if (touchPan?.moved)
      setTimeout(() => {
        suppressPanClick = false;
      }, 500);
    touchPan = null;
  }
}
function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && editing.value) {
    if (
      marquee.value ||
      groupDrag.value ||
      pictureDrag.value ||
      resizing.value ||
      drag.value ||
      bookcaseDrag.value
    )
      onCancel();
    else {
      selected.value = null;
      selectedBooks.value = new Set();
      selectedPicture.value = null;
    }
    return;
  }
  if (event.code !== 'Space' || event.altKey || event.ctrlKey || event.metaKey)
    return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    if (target.closest('input, textarea, select, [contenteditable="true"]'))
      return;
    const interactive = target.closest('button, summary');
    if (
      interactive &&
      (!pointerOverWall.value || wall.value?.contains(interactive))
    )
      return;
  }
  if (
    target !== document.body &&
    !(target instanceof Node && wall.value?.contains(target)) &&
    !pointerOverWall.value
  )
    return;
  spaceHeld.value = true;
  event.preventDefault();
}
function onKeyUp(event: KeyboardEvent) {
  if (event.code === 'Space') spaceHeld.value = false;
}
function onWindowBlur() {
  spaceHeld.value = false;
  pointerOverWall.value = false;
  onCancel();
}
function startPan(event: PointerEvent) {
  if (
    editing.value &&
    event.button === 0 &&
    (event.ctrlKey || event.metaKey) &&
    wall.value
  ) {
    marquee.value = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      previousSelection: new Set(selectedBooks.value),
    };
    selected.value = null;
    selectedPicture.value = null;
    event.preventDefault();
    event.stopPropagation();
    attachPointerListeners();
    return;
  }
  if (
    editing.value &&
    event.button === 0 &&
    !spaceHeld.value &&
    event.target instanceof Element &&
    !event.target.closest('button, .shelf-picture')
  ) {
    selected.value = null;
    selectedBooks.value = new Set();
    selectedPicture.value = null;
  }
  if (event.pointerType === 'touch' && !touchPan) suppressPanClick = false;
  if (
    !wall.value ||
    event.pointerType !== 'mouse' ||
    resizing.value ||
    drag.value ||
    bookcaseDrag.value
  )
    return;
  if (event.button !== 2 && !(event.button === 0 && spaceHeld.value)) return;
  pan.value = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    cameraX: camera.x,
    cameraY: camera.y,
  };
  suppressPanClick = event.button === 0;
  event.preventDefault();
  event.stopPropagation();
  attachPointerListeners();
}
function preventPanClick(event: MouseEvent) {
  if (!suppressPanClick) return;
  event.preventDefault();
  event.stopPropagation();
  suppressPanClick = false;
}
onMounted(() => {
  watch(
    () => authUser.value?.id,
    (userId) => {
      clearTimeout(viewSaveTimer);
      saveView();
      viewKey = userId ? bookshelfViewKey(userId, shelfPath.value) : null;
      centerBookshelf();
      if (viewKey) {
        try {
          const savedView = readBookshelfView(localStorage, viewKey);
          if (savedView) {
            camera.x = savedView.x;
            camera.y = savedView.y;
            zoom.value = savedView.zoom;
          }
        } catch {
          // Accessing localStorage itself can fail in restricted browser contexts.
        }
      }
    },
    { immediate: true },
  );
  if (wall.value) {
    observer = new ResizeObserver(([entry]) => {
      if (entry) {
        width.value = entry.contentRect.width;
        viewportHeight.value = entry.contentRect.height;
      }
    });
    observer.observe(wall.value);
    wall.value.addEventListener('wheel', onWheel, { passive: false });
    wall.value.addEventListener('touchstart', onTouchStart, { passive: true });
    wall.value.addEventListener('touchmove', onTouchMove, { passive: false });
    wall.value.addEventListener('touchend', onTouchEnd);
    wall.value.addEventListener('touchcancel', onTouchEnd);
  }
  window.addEventListener('beforeunload', unloadWarning);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onWindowBlur);
  void load();
});
onBeforeUnmount(() => {
  clearTimeout(viewSaveTimer);
  clearTimeout(sliderSaveTimer);
  saveView();
  disposed = true;
  generation++;
  catalogGeneration++;
  observer?.disconnect();
  wall.value?.removeEventListener('wheel', onWheel);
  wall.value?.removeEventListener('touchstart', onTouchStart);
  wall.value?.removeEventListener('touchmove', onTouchMove);
  wall.value?.removeEventListener('touchend', onTouchEnd);
  wall.value?.removeEventListener('touchcancel', onTouchEnd);
  window.removeEventListener('beforeunload', unloadWarning);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', onWindowBlur);
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
});

function toggleEdit() {
  editing.value = !editing.value;
  selected.value = null;
  selectedBooks.value = new Set();
  selectedPicture.value = null;
}
async function addPicture(event: Event) {
  const input = event.target;
  if (
    !(input instanceof HTMLInputElement) ||
    !input.files?.[0] ||
    !arrangement.value
  )
    return;
  const file = input.files[0];
  input.value = '';
  const path = picturePath.value;
  const uploadGeneration = catalogGeneration;
  if ((arrangement.value.pictures?.length ?? 0) >= 100) {
    notice.value = 'This shelf already has 100 pictures.';
    return;
  }
  uploadingPicture.value = true;
  try {
    const form = new FormData();
    form.append('file', file);
    const uploaded = await $fetch<{
      id: string;
      width: number;
      height: number;
    }>(path, { method: 'POST', body: form });
    if (
      !arrangement.value ||
      path !== picturePath.value ||
      uploadGeneration !== catalogGeneration ||
      !canEdit.value
    ) {
      notice.value =
        'The shelf changed during the upload. Add the picture again.';
      return;
    }
    const frame = shelfFrame(zoom.value);
    const factor = Math.min(1, 200 / Math.max(uploaded.width, uploaded.height));
    const picture: ShelfPicture = {
      id: uploaded.id,
      assetId: uploaded.id,
      x: Math.round((width.value / 2 - frame.left - camera.x) / scale.value),
      y: Math.round(
        (frame.floor + camera.y - viewportHeight.value / 2) / scale.value,
      ),
      width: Math.max(10, Math.round(uploaded.width * factor)),
      height: Math.max(10, Math.round(uploaded.height * factor)),
      rotation: 0,
    };
    (arrangement.value.pictures ??= []).push(picture);
    selectedPicture.value = picture.id;
    selected.value = null;
    selectedBooks.value = new Set();
    changed();
  } catch (error) {
    notice.value = `Could not upload this picture: ${errorText(error)}`;
  } finally {
    uploadingPicture.value = false;
  }
}
function startPicture(event: PointerEvent, picture: ShelfPicture) {
  if (!editing.value || event.button !== 0) return;
  selectedPicture.value = picture.id;
  selected.value = null;
  selectedBooks.value = new Set();
  pictureDrag.value = {
    pointerId: event.pointerId,
    id: picture.id,
    startX: event.clientX,
    startY: event.clientY,
    x: picture.x,
    y: picture.y,
    previewX: picture.x,
    previewY: picture.y,
  };
  event.preventDefault();
  attachPointerListeners();
}
const currentPicture = computed(() =>
  arrangement.value?.pictures?.find(
    (picture) => picture.id === selectedPicture.value,
  ),
);
function changePicture(
  field: 'width' | 'rotation',
  event: Event,
  commit = false,
) {
  if (!currentPicture.value || !(event.target instanceof HTMLInputElement))
    return;
  const picture = currentPicture.value;
  const value = Number(event.target.value);
  if (field === 'width') {
    if (pictureResizeRatio?.id !== picture.id)
      pictureResizeRatio = {
        id: picture.id,
        ratio: picture.height / picture.width,
      };
    picture.height = Math.max(
      10,
      Math.min(4000, Math.round(pictureResizeRatio.ratio * value)),
    );
    picture.width = value;
  } else picture.rotation = value;
  sliderChanged(commit);
  if (commit) pictureResizeRatio = null;
}
function removePicture() {
  if (!arrangement.value || !selectedPicture.value) return;
  arrangement.value.pictures = (arrangement.value.pictures ?? []).filter(
    (picture) => picture.id !== selectedPicture.value,
  );
  selectedPicture.value = null;
  changed();
}
function addBookcase() {
  if (!arrangement.value) return;
  arrangement.value.bookcases.push({
    id: crypto.randomUUID(),
    width: SHELF_WIDTH,
    shelves: [emptyShelf(), emptyShelf(), emptyShelf()],
  });
  changed();
  void nextTick(() => {
    const viewport = wall.value;
    const last = viewport?.querySelector<HTMLElement>(
      '[data-bookcase-id]:last-child',
    );
    if (!viewport || !last) return;
    const view = viewport.getBoundingClientRect();
    const rect = last.getBoundingClientRect();
    if (rect.right > view.right - WALL_SIDE_PADDING)
      camera.x -= rect.right - view.right + WALL_SIDE_PADDING;
    else if (rect.left < view.left + WALL_SIDE_PADDING)
      camera.x += view.left + WALL_SIDE_PADDING - rect.left;
  });
}
function addShelf(shelf: Shelf) {
  const bookcase = getBookcase(shelf.id);
  if (!bookcase) return;
  const index = bookcase.shelves.findIndex((entry) => entry.id === shelf.id);
  if (index < 0) return;
  const floor = shelfFrame(zoom.value).floor;
  const added = emptyShelf();
  bookcase.shelves.splice(index, 0, added);
  camera.y += floor - shelfFrame(zoom.value).floor;
  selectedPicture.value = null;
  selected.value = null;
  selectedBooks.value = new Set();
  changed();
  void nextTick(() => {
    const viewport = wall.value;
    const canvas = [
      ...(viewport?.querySelectorAll<HTMLElement>('[data-shelf-canvas]') ?? []),
    ].find((entry) => entry.dataset.shelfCanvas === added.id);
    if (!viewport || !canvas) return;
    const top = viewport.getBoundingClientRect().top + 8;
    const shelfTop = canvas.getBoundingClientRect().top;
    if (shelfTop < top) camera.y += top - shelfTop;
  });
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
  const index = bookcase.shelves.findIndex((item) => item.id === shelf.id);
  if (index < 0) return;
  const floor = shelfFrame(zoom.value).floor;
  bookcase.shelves.splice(index, 1);
  camera.y += floor - shelfFrame(zoom.value).floor;
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
  const index = arrangement.value.bookcases.findIndex(
    (entry) => entry.id === bookcase.id,
  );
  if (index < 0) return;
  arrangement.value.bookcases.splice(index, 1);
  changed();
}
function changeSize(
  bookId: string,
  field: 'width' | 'height',
  event: Event,
  commit = false,
) {
  if (props.personalShelfId && !bookFor(bookId).canResize) return;
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
  sliderChanged(commit);
}
function shiftBook(bookId: string, delta: number) {
  const found = getItem(bookId);
  if (!found) return;
  const bookcase = getBookcase(found.shelf.id);
  if (!bookcase) return;
  const items = shiftStackBook(
    toRaw(found.shelf),
    bookcase.width,
    bookId,
    delta,
  );
  if (!items) {
    notice.value = 'Make room before shifting this book.';
    return;
  }
  found.shelf.items = items;
  changed();
}
function bookFor(id: string): BookViewBook & { canResize?: boolean } {
  return byId.value.get(id) ?? { id, title: 'Unavailable book' };
}
function onBookClick(event: MouseEvent, id: string) {
  if (!editing.value) {
    void navigateTo(`/books/${id}`);
    return;
  }
  if (event.detail === 0) {
    selected.value = id;
    selectedPicture.value = null;
  }
}
function startBook(
  event: PointerEvent,
  shelf: Shelf,
  item: ShelfItem,
  book: ShelfBook,
  whole = false,
) {
  if (!editing.value || event.button !== 0) return;
  selectedPicture.value = null;
  if (
    !whole &&
    selectedBooks.value.size > 1 &&
    selectedBooks.value.has(book.id)
  ) {
    groupDrag.value = {
      pointerId: event.pointerId,
      shelfId: shelf.id,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
    event.preventDefault();
    attachPointerListeners();
    return;
  }
  selectedBooks.value = new Set();
  stopNotice();
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const canvas = target.closest<HTMLElement>('[data-shelf-canvas]');
  const stack = target.closest<HTMLElement>('.stack-control');
  if (whole ? !stack : !canvas) return;
  const rect = (whole ? stack! : target).getBoundingClientRect(),
    shelfScale = scale.value;
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
  const bookcase = getBookcase(shelf.id);
  if (!bookcase) return;
  resizing.value = {
    axis: 'height',
    shelfId: shelf.id,
    start: event.clientY,
    original: shelf.height,
    scale: scale.value,
    floor: shelfFrame(zoom.value).floor,
    cameraY: camera.y,
  };
  event.preventDefault();
  attachPointerListeners();
}
function adjustShelfHeight(shelf: Shelf, amount: number) {
  const next = Math.max(
    minimumShelfHeight(shelf),
    Math.min(SHELF_MAX_HEIGHT, shelf.height + amount),
  );
  if (next !== shelf.height) {
    const floor = shelfFrame(zoom.value).floor;
    shelf.height = next;
    camera.y += floor - shelfFrame(zoom.value).floor;
    changed();
  }
}
function adjustBookcaseWidth(bookcase: Bookcase, amount: number) {
  const next = Math.max(
    minimumBookcaseWidth(bookcase),
    Math.min(SHELF_MAX_WIDTH, bookcase.width + amount),
  );
  if (next !== bookcase.width) {
    bookcase.width = next;
    changed();
  }
}
function startBookcaseResize(event: PointerEvent, bookcase: Bookcase) {
  if (!editing.value || event.button !== 0) return;
  resizing.value = {
    axis: 'width',
    bookcaseId: bookcase.id,
    start: event.clientX,
    original: bookcase.width,
    scale: scale.value,
  };
  event.preventDefault();
  attachPointerListeners();
}
function startBookcaseDrag(event: PointerEvent, bookcase: Bookcase) {
  if (!editing.value || event.button !== 0 || !wall.value) return;
  stopNotice();
  bookcaseDrag.value = {
    id: bookcase.id,
    pointerId: event.pointerId,
    startX: event.clientX,
    x: event.clientX,
    startCameraX: camera.x,
    cameraX: camera.x,
    beforeId: null,
    moved: false,
  };
  selected.value = null;
  event.preventDefault();
  attachPointerListeners();
}
function moveBookcase(id: string, beforeId: string | null) {
  if (!arrangement.value || id === beforeId) return;
  const cases = arrangement.value.bookcases;
  const from = cases.findIndex((entry) => entry.id === id);
  const before =
    beforeId === null
      ? cases.length
      : cases.findIndex((entry) => entry.id === beforeId);
  if (from < 0 || before < 0) return;
  const to = before > from ? before - 1 : before;
  if (to === from) return;
  const [entry] = cases.splice(from, 1);
  if (!entry) return;
  cases.splice(to, 0, toRaw(entry));
  changed();
}
function moveBookcaseBy(id: string, direction: -1 | 1) {
  const cases = arrangement.value?.bookcases;
  if (!cases) return;
  const index = cases.findIndex((entry) => entry.id === id);
  if (index < 0 || index + direction < 0 || index + direction >= cases.length)
    return;
  moveBookcase(
    id,
    direction < 0 ? cases[index - 1]!.id : (cases[index + 2]?.id ?? null),
  );
}
function updateBookcaseTarget() {
  const state = bookcaseDrag.value;
  if (!state?.moved || !wall.value) return;
  const cases = [
    ...wall.value.querySelectorAll<HTMLElement>('[data-bookcase-id]'),
  ].filter((element) => element.dataset.bookcaseId !== state.id);
  const next = cases.find((element) => {
    const rect = element.getBoundingClientRect();
    return state.x < rect.left + rect.width / 2;
  });
  state.beforeId = next?.dataset.bookcaseId ?? null;
}
function stopBookcaseScroll() {
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = null;
}
function scrollBookcaseDrag() {
  scrollFrame = null;
  const state = bookcaseDrag.value;
  const viewport = wall.value;
  if (!state?.moved || !viewport) return;
  const rect = viewport.getBoundingClientRect();
  const edge = Math.min(70, rect.width / 4);
  const distance =
    state.x < rect.left + edge
      ? state.x - (rect.left + edge)
      : state.x > rect.right - edge
        ? state.x - (rect.right - edge)
        : 0;
  if (!distance) return;
  camera.x -= Math.max(-18, Math.min(18, distance * 0.3));
  state.cameraX = camera.x;
  updateBookcaseTarget();
  void nextTick(updateBookcaseTarget);
  scrollFrame = requestAnimationFrame(scrollBookcaseDrag);
}
function queueBookcaseScroll() {
  if (scrollFrame === null)
    scrollFrame = requestAnimationFrame(scrollBookcaseDrag);
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
  if (pictureDrag.value) {
    const state = pictureDrag.value;
    if (event.pointerId !== state.pointerId) return;
    state.previewX = Math.max(
      -100000,
      Math.min(
        100000,
        Math.round(state.x + (event.clientX - state.startX) / scale.value),
      ),
    );
    state.previewY = Math.max(
      -100000,
      Math.min(
        100000,
        Math.round(state.y - (event.clientY - state.startY) / scale.value),
      ),
    );
    return;
  }
  if (marquee.value) {
    if (event.pointerId === marquee.value.pointerId) {
      marquee.value.x = event.clientX;
      marquee.value.y = event.clientY;
      updateMarqueeSelection(marquee.value);
    }
    return;
  }
  if (groupDrag.value) {
    if (event.pointerId === groupDrag.value.pointerId) {
      groupDrag.value.x = event.clientX;
      groupDrag.value.y = event.clientY;
      if (
        Math.hypot(
          event.clientX - groupDrag.value.startX,
          event.clientY - groupDrag.value.startY,
        ) > 5
      )
        groupDrag.value.moved = true;
    }
    return;
  }
  if (pan.value) {
    if (event.pointerId !== pan.value.pointerId || !wall.value) return;
    camera.x = pan.value.cameraX + event.clientX - pan.value.x;
    camera.y = pan.value.cameraY + event.clientY - pan.value.y;
    return;
  }
  if (bookcaseDrag.value) {
    const state = bookcaseDrag.value;
    if (event.pointerId !== state.pointerId) return;
    state.x = event.clientX;
    state.cameraX = camera.x;
    if (Math.abs(state.x - state.startX) > 5) state.moved = true;
    if (state.moved) {
      updateBookcaseTarget();
      queueBookcaseScroll();
    }
    return;
  }
  if (resizing.value) {
    const state = resizing.value;
    const coordinate = state.axis === 'width' ? event.clientX : event.clientY;
    const delta = (coordinate - state.start) / state.scale;
    const proposed = Math.round(
      state.original + (state.axis === 'height' ? -delta : delta),
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
      if (shelf) {
        shelf.height = Math.max(
          minimumShelfHeight(shelf),
          Math.min(SHELF_MAX_HEIGHT, proposed),
        );
        camera.y = state.cameraY + state.floor - shelfFrame(zoom.value).floor;
      }
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
function updateMarqueeSelection(state: NonNullable<typeof marquee.value>) {
  if (!wall.value || !arrangement.value) return;
  const rect = wall.value.getBoundingClientRect();
  const frame = shelfFrame(zoom.value);
  const worldX = (x: number) =>
    (x - rect.left - frame.left - camera.x) / scale.value;
  const worldY = (y: number) =>
    (rect.top + frame.floor + camera.y - y) / scale.value;
  selectedBooks.value = booksInRectangle(toRaw(arrangement.value), {
    left: Math.min(worldX(state.startX), worldX(state.x)),
    right: Math.max(worldX(state.startX), worldX(state.x)),
    bottom: Math.min(worldY(state.startY), worldY(state.y)),
    top: Math.max(worldY(state.startY), worldY(state.y)),
  });
}
function onUp(event: PointerEvent) {
  if (pictureDrag.value) {
    const state = pictureDrag.value;
    if (event.pointerId !== state.pointerId) return;
    pictureDrag.value = null;
    detachPointerListeners();
    const picture = arrangement.value?.pictures?.find(
      (entry) => entry.id === state.id,
    );
    if (picture && (state.previewX !== state.x || state.previewY !== state.y)) {
      picture.x = state.previewX;
      picture.y = state.previewY;
      changed();
    }
    return;
  }
  if (marquee.value) {
    if (event.pointerId !== marquee.value.pointerId) return;
    const state = marquee.value;
    state.x = event.clientX;
    state.y = event.clientY;
    updateMarqueeSelection(state);
    marquee.value = null;
    detachPointerListeners();
    return;
  }
  if (groupDrag.value) {
    const state = groupDrag.value;
    if (event.pointerId !== state.pointerId) return;
    groupDrag.value = null;
    detachPointerListeners();
    if (!state.moved || !arrangement.value) return;
    const canvas = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement && !!el.dataset.shelfCanvas,
      );
    const moved =
      canvas?.dataset.shelfCanvas &&
      moveSelectedBooks(
        toRaw(arrangement.value),
        selectedBooks.value,
        state.shelfId,
        canvas.dataset.shelfCanvas,
        (event.clientX - state.startX) / scale.value,
      );
    if (!moved) {
      notice.value = 'The selected books do not fit together there.';
      return;
    }
    arrangement.value = moved;
    changed();
    return;
  }
  if (pan.value && event.pointerId !== pan.value.pointerId) return;
  if (bookcaseDrag.value && event.pointerId !== bookcaseDrag.value.pointerId)
    return;
  detachPointerListeners();
  if (pan.value) {
    pan.value = null;
    setTimeout(() => {
      suppressPanClick = false;
    }, 0);
    return;
  }
  if (bookcaseDrag.value) {
    const state = bookcaseDrag.value;
    state.x = event.clientX;
    updateBookcaseTarget();
    stopBookcaseScroll();
    bookcaseDrag.value = null;
    if (state.moved) moveBookcase(state.id, state.beforeId);
    return;
  }
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
  changed();
}
function onCancel() {
  detachPointerListeners();
  stopBookcaseScroll();
  pan.value = null;
  touchPan = null;
  bookcaseDrag.value = null;
  suppressPanClick = false;
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
      camera.y = state.cameraY;
    }
  }
  resizing.value = null;
  drag.value = null;
  if (marquee.value) selectedBooks.value = marquee.value.previousSelection;
  marquee.value = null;
  groupDrag.value = null;
  pictureDrag.value = null;
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
const lastOtherBookcaseId = computed(
  () =>
    arrangement.value?.bookcases
      .filter((entry) => entry.id !== bookcaseDrag.value?.id)
      .at(-1)?.id,
);
</script>

<template>
  <div
    class="bookshelf-view"
    :style="{
      '--wall-side-padding': `${WALL_SIDE_PADDING}px`,
      '--wall-top-padding': `${WALL_TOP_PADDING}px`,
      '--floor-line-height': `${FLOOR_LINE_HEIGHT}px`,
      '--shelf-color': userSettingsStore.activeSettings.bookshelfStyle.color,
      '--shelf-grain':
        userSettingsStore.activeSettings.bookshelfStyle.texture === 'wood'
          ? 'repeating-linear-gradient(4deg, transparent 0 5px, #ffffff0d 6px, transparent 8px 15px, #00000012 16px, transparent 19px)'
          : 'none',
    }"
  >
    <div class="bookshelf-toolbar">
      <div class="toolbar-left">
        <button
          v-if="canEdit"
          type="button"
          class="edit-button"
          :class="{ active: editing }"
          :aria-label="editing ? 'Done editing shelves' : 'Edit shelves'"
          :title="editing ? 'Done editing shelves' : 'Edit shelves'"
          :aria-pressed="editing"
          @click="toggleEdit"
        >
          <Icon name="lucide:pencil" aria-hidden="true" />
        </button>
        <details v-if="editing" class="case-menu">
          <summary aria-label="Bookshelf options">
            <Icon name="lucide:ellipsis" aria-hidden="true" />
          </summary>
          <button type="button" @click="addBookcase">
            <Icon name="lucide:plus" aria-hidden="true" /> Add bookcase
          </button>
        </details>
        <button
          v-if="editing"
          type="button"
          :disabled="uploadingPicture"
          :aria-label="uploadingPicture ? 'Uploading picture' : 'Add picture'"
          :title="uploadingPicture ? 'Uploading picture' : 'Add picture'"
          @click="pictureInput?.click()"
        >
          <Icon name="lucide:image-up" aria-hidden="true" />
        </button>
        <input
          ref="pictureInput"
          type="file"
          accept="image/jpeg,image/png,image/webp,image/avif"
          hidden
          @change="addPicture"
        />
        <details class="navigation-help">
          <summary aria-label="How to navigate the bookshelf">
            <Icon name="lucide:circle-help" aria-hidden="true" />
          </summary>
          <div class="navigation-help-panel">
            <strong>Move around</strong>
            <p>
              Drag with the right mouse button or hold Space and drag. On a
              touch screen, swipe to pan. Focus the bookshelf and use the arrow
              keys to pan with a keyboard. While focused on a book, use Alt with
              an arrow key.
            </p>
            <p>Use Center bookshelf to reset the position and zoom.</p>
            <p>
              Use the wheel or pinch to zoom. Hold Shift and use the wheel to
              move vertically.
            </p>
            <p v-if="editing">
              Drag a bookcase by its top handle to change its order.
            </p>
          </div>
        </details>
        <button
          v-if="camera.x || camera.y || zoom !== 1"
          type="button"
          class="center-button"
          aria-label="Center bookshelf"
          title="Center bookshelf"
          @click="centerBookshelf"
        >
          <Icon name="lucide:locate-fixed" aria-hidden="true" />
        </button>
      </div>
      <div
        class="zoom-controls"
        role="group"
        aria-label="Bookshelf zoom"
        title="Wheel or pinch to zoom · Shift + wheel to pan vertically"
      >
        <button
          type="button"
          aria-label="Zoom out"
          :disabled="zoom <= MIN_ZOOM"
          @click="zoom = Math.max(MIN_ZOOM, +(zoom - 0.1).toFixed(1))"
        >
          <Icon name="lucide:minus" aria-hidden="true" />
        </button>
        <button type="button" aria-label="Reset zoom" @click="zoom = 1">
          {{ Math.round(zoom * 100) }}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          :disabled="zoom >= MAX_ZOOM"
          @click="zoom = Math.min(MAX_ZOOM, +(zoom + 0.1).toFixed(1))"
        >
          <Icon name="lucide:plus" aria-hidden="true" />
        </button>
      </div>
      <div class="toolbar-right" :class="{ problem: conflict || saveError }">
        <span
          class="save-status"
          :class="{ problem: conflict || saveError, pending: saving || dirty }"
          role="status"
          >{{ status }}</span
        >
        <button v-if="saveError" type="button" @click="retrySave">
          Retry save
        </button>
        <button v-if="conflict" type="button" @click="reloadNewer">
          Load newer arrangement
        </button>
      </div>
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
      book onto a sideways spine to stack it. Hold Control and drag to select
      books, then drag the selection to move it.
    </p>
    <div
      ref="wall"
      class="wall-viewport"
      :class="{ 'pan-ready': spaceHeld, panning: pan }"
      tabindex="0"
      aria-label="Bookshelf. Swipe, use arrow keys, or hold Space and drag to pan. Use Alt and an arrow key while focused on a book."
      @keydown="onWallKeydown"
      @pointerdown.capture="startPan"
      @pointerenter="pointerOverWall = true"
      @pointerleave="pointerOverWall = false"
      @click.capture="preventPanClick"
      @contextmenu.prevent
      @focusin="onWallFocus"
      @focusout="
        focusedCaseId = null;
        focusedShelfId = null;
      "
    >
      <div
        v-if="marquee"
        class="selection-rectangle"
        :style="{
          left: `${Math.min(marquee.startX, marquee.x) - (wall?.getBoundingClientRect().left ?? 0)}px`,
          top: `${Math.min(marquee.startY, marquee.y) - (wall?.getBoundingClientRect().top ?? 0)}px`,
          width: `${Math.abs(marquee.x - marquee.startX)}px`,
          height: `${Math.abs(marquee.y - marquee.startY)}px`,
        }"
      />
      <div
        v-if="arrangement && !loading"
        class="floor-line"
        :style="{ top: `${floorTop}px` }"
      />
      <div
        v-if="arrangement && !loading"
        class="wall"
        :style="{
          transform: `translate(${camera.x}px, ${camera.y}px)`,
          gap: `${SHELF_CASE_GAP * scale}px`,
        }"
      >
        <BookshelfBookcase
          v-for="(bookcase, caseIndex) in arrangement.bookcases"
          :key="bookcase.id"
          :bookcase="bookcase"
          :case-index="caseIndex"
          :bookcase-count="arrangement.bookcases.length"
          :case-left="casePositions[caseIndex]!"
          :controls-layer="controlsLayer"
          :scale="scale"
          :editing="editing"
          :selected="selected"
          :selected-books="selectedBooks"
          :adjustments="adjustments"
          :matches="matches"
          :books-by-id="byId"
          :render-books="visibleCaseIds.has(bookcase.id)"
          :floor-top="floorTop"
          :viewport-height="viewportHeight"
          :focused-shelf-id="focusedShelfId"
          :moving-shelf-id="drag?.moved ? drag.shelfId : null"
          :moving-book-id="drag?.moved ? drag.bookId : null"
          :resize-shelf-id="
            resizing?.axis === 'height' ? resizing.shelfId : null
          "
          :resize-case-id="
            resizing?.axis === 'width' ? resizing.bookcaseId : null
          "
          :dragging="bookcaseDrag?.id === bookcase.id && bookcaseDrag.moved"
          :drop-before="
            !!bookcaseDrag?.moved && bookcaseDrag.beforeId === bookcase.id
          "
          :drop-after="
            !!bookcaseDrag?.moved &&
            bookcaseDrag.beforeId === null &&
            lastOtherBookcaseId === bookcase.id
          "
          :case-offset="
            bookcaseDrag?.id === bookcase.id && bookcaseDrag.moved
              ? bookcaseDrag.x -
                bookcaseDrag.startX -
                bookcaseDrag.cameraX +
                bookcaseDrag.startCameraX
              : undefined
          "
          @move-case="startBookcaseDrag"
          @reorder-case="moveBookcaseBy"
          @move-book="startBook"
          @select-book="onBookClick"
          @resize-shelf="startResize"
          @resize-case="startBookcaseResize"
          @adjust-shelf="adjustShelfHeight"
          @adjust-case="adjustBookcaseWidth"
          @add-shelf="addShelf"
          @remove-shelf="removeShelf"
          @remove-case="removeBookcase"
        />
      </div>
      <template v-if="arrangement && !loading">
        <div
          v-for="picture in arrangement.pictures ?? []"
          :key="picture.id"
          class="shelf-picture"
          :class="{ editable: editing, active: selectedPicture === picture.id }"
          :style="{
            left: `${shelfFrame(zoom).left + camera.x + (pictureDrag?.id === picture.id ? pictureDrag.previewX : picture.x) * scale}px`,
            top: `${floorTop - (pictureDrag?.id === picture.id ? pictureDrag.previewY : picture.y) * scale}px`,
            width: `${picture.width * scale}px`,
            height: `${picture.height * scale}px`,
            transform: `translate(-50%, -50%) rotate(${picture.rotation}deg)`,
          }"
          @pointerdown.stop="startPicture($event, picture)"
        >
          <img
            :src="`${picturePath}?asset=${encodeURIComponent(picture.assetId)}`"
            alt="Bookshelf decoration"
            draggable="false"
          />
        </div>
      </template>
      <div ref="controlsLayer" class="controls-layer" />
    </div>
    <aside
      v-if="editing && currentPicture"
      class="shelf-panel"
      aria-label="Picture options"
    >
      <div class="panel-heading">
        <strong>Picture</strong
        ><button
          type="button"
          aria-label="Close picture options"
          @click="selectedPicture = null"
        >
          <Icon name="lucide:x" aria-hidden="true" />
        </button>
      </div>
      <label
        >Size · {{ currentPicture.width
        }}<input
          type="range"
          min="10"
          max="1000"
          :value="currentPicture.width"
          @input="changePicture('width', $event)"
          @change="changePicture('width', $event, true)"
      /></label>
      <label
        >Rotation · {{ currentPicture.rotation }}°<input
          type="range"
          min="-180"
          max="180"
          :value="currentPicture.rotation"
          @input="changePicture('rotation', $event)"
          @change="changePicture('rotation', $event, true)"
      /></label>
      <button type="button" @click="removePicture">Remove picture</button>
    </aside>
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
          <Icon name="lucide:x" aria-hidden="true" />
        </button>
      </div>
      <p v-if="personalShelfId && !bookFor(selected).canResize">
        Only an editor of this book's collection can change its size.
      </p>
      <div
        v-if="
          getItem(selected)?.item.horizontal &&
          (getItem(selected)?.item.books.length ?? 0) > 1
        "
      >
        <p>Shift this book in its stack</p>
        <button type="button" @click="shiftBook(selected!, -5)">Left</button>
        <button type="button" @click="shiftBook(selected!, 5)">Right</button>
      </div>
      <label v-if="!personalShelfId || bookFor(selected).canResize"
        >Height · {{ selectedBook.height }}
        <input
          type="range"
          min="120"
          max="230"
          :value="selectedBook.height"
          @input="changeSize(selected!, 'height', $event)"
          @change="changeSize(selected!, 'height', $event, true)"
      /></label>
      <label v-if="!personalShelfId || bookFor(selected).canResize"
        >Thickness · {{ selectedBook.width }}
        <input
          type="range"
          min="20"
          max="55"
          :value="selectedBook.width"
          @input="changeSize(selected!, 'width', $event)"
          @change="changeSize(selected!, 'width', $event, true)"
      /></label>
    </aside>
    <Teleport to="body"
      ><div
        v-if="groupDrag?.moved"
        class="group-ghost"
        :style="{ left: `${groupDrag.x + 12}px`, top: `${groupDrag.y + 12}px` }"
      >
        {{ selectedBooks.size }} books
      </div>
      <div
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
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  gap: 10px;
}
.bookshelf-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  min-height: 36px;
  padding: 2px 8px;
  border-bottom: 1px solid var(--contrast-border-color);
}
.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.toolbar-right {
  justify-content: flex-end;
}
.bookshelf-toolbar button,
.shelf-panel button,
.case-menu summary,
.navigation-help summary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  border: 1px solid
    color-mix(in srgb, var(--contrast-border-color) 60%, transparent);
  border-radius: 8px;
  padding: 6px 11px;
  background: var(--bg-color);
  color: var(--contrast-text-color);
  font-size: 13px;
  font-weight: 550;
  cursor: pointer;
  transition:
    background-color 140ms,
    border-color 140ms;
}
.bookshelf-toolbar button:not(:disabled):hover,
.shelf-panel button:hover,
.case-menu summary:hover,
.navigation-help summary:hover {
  background: color-mix(in srgb, var(--main-color) 10%, var(--bg-color));
  border-color: var(--contrast-main-color);
}
.bookshelf-toolbar :is(button, summary):focus-visible,
.shelf-panel :is(button, input):focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
.bookshelf-toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}
.bookshelf-toolbar .edit-button,
.bookshelf-toolbar .center-button,
.bookshelf-toolbar .zoom-controls button,
.bookshelf-toolbar .case-menu summary,
.bookshelf-toolbar .navigation-help summary {
  min-width: 30px;
  min-height: 30px;
  padding: 4px 7px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--contrast-main-color);
}
.bookshelf-toolbar .edit-button.active,
.bookshelf-toolbar .edit-button:hover,
.bookshelf-toolbar .center-button:hover,
.bookshelf-toolbar .zoom-controls button:hover:not(:disabled),
.bookshelf-toolbar .case-menu summary:hover,
.bookshelf-toolbar .navigation-help summary:hover {
  background: color-mix(in srgb, var(--sub-color) 25%, transparent);
}
.zoom-controls {
  display: flex;
  align-items: center;
}
.zoom-controls button {
  font-variant-numeric: tabular-nums;
}
.zoom-controls button:nth-child(2) {
  min-width: 50px;
  font-size: 12px;
  font-weight: 400;
}
.save-status {
  color: var(--contrast-text-color);
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.toolbar-right button {
  min-height: 28px;
  padding: 4px 7px;
  font-size: 12px;
}
.save-status::before {
  content: '';
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--contrast-main-color);
}
.save-status.pending::before {
  opacity: 0.5;
}
.save-status.problem::before {
  background: var(--contrast-error-color);
}
.case-menu,
.navigation-help {
  position: relative;
}
.case-menu summary,
.navigation-help summary {
  list-style: none;
  cursor: pointer;
}
.case-menu summary::-webkit-details-marker,
.navigation-help summary::-webkit-details-marker {
  display: none;
}
.case-menu button {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 12;
  white-space: nowrap;
  box-shadow: 0 8px 24px #0002;
}
.navigation-help-panel {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  z-index: 20;
  width: min(275px, calc(100vw - 32px));
  padding: 12px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 8px;
  background: var(--bg-color);
  color: var(--contrast-text-color);
  box-shadow: 0 8px 24px #0002;
  font-size: 12px;
}
.navigation-help-panel p {
  margin-top: 7px;
}
.notice {
  color: var(--contrast-main-color);
  font-size: 13px;
  padding: 9px 12px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--main-color) 9%, var(--bg-color));
}
.notice button {
  text-decoration: underline;
}
.wall-viewport {
  position: relative;
  display: flex;
  align-items: safe center;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  overflow: clip;
  touch-action: none;
}
.wall-viewport:focus {
  outline: none;
}
.controls-layer {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
}
.selection-rectangle {
  position: absolute;
  z-index: 15;
  pointer-events: none;
  border: 1px solid #dfad56;
  background: #dfad5633;
}
.group-ghost {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
  padding: 6px 10px;
  border-radius: 6px;
  color: var(--contrast-main-color);
  background: var(--bg-color);
  box-shadow: 0 2px 8px #0005;
}
.shelf-picture {
  position: absolute;
  z-index: 4;
  pointer-events: none;
}
.shelf-picture.editable {
  pointer-events: auto;
  cursor: grab;
  touch-action: none;
}
.shelf-picture.active {
  outline: 2px solid #e5ba72;
  outline-offset: 2px;
}
.shelf-picture img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: fill;
  pointer-events: none;
}
.wall-viewport.pan-ready,
.wall-viewport.pan-ready :deep(*) {
  cursor: grab;
}
.wall-viewport.panning,
.wall-viewport.panning :deep(*) {
  cursor: grabbing !important;
  user-select: none;
}
.wall {
  will-change: transform;
  position: relative;
  display: flex;
  flex: 0 0 auto;
  flex-wrap: nowrap;
  align-items: flex-end;
  justify-content: center;
  box-sizing: border-box;
  width: max-content;
  min-width: 100%;
  padding: var(--wall-top-padding) var(--wall-side-padding)
    var(--floor-line-height);
}
.floor-line {
  position: absolute;
  left: 0;
  right: 0;
  height: var(--floor-line-height);
  background: var(--main-color);
  pointer-events: none;
}
.shelf-panel {
  position: absolute;
  z-index: 10;
  top: 55px;
  right: 12px;
  width: 250px;
  max-height: 65%;
  overflow: auto;
  padding: 16px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 12px;
  background: var(--bg-color);
  color: var(--contrast-main-color);
  box-shadow: 0 5px 25px #0003;
}
.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}
.panel-heading button {
  min-height: 30px;
  padding: 6px;
}
.shelf-panel label {
  display: block;
  margin: 12px 0;
  font-size: 12px;
}
.shelf-panel p {
  margin-top: 8px;
  color: var(--contrast-text-color);
  font-size: 12px;
}
.shelf-panel input[type='range'] {
  display: block;
  width: 100%;
  height: 24px;
  margin-top: 7px;
  appearance: none;
  background: transparent;
  cursor: pointer;
}
.shelf-panel input[type='range']::-webkit-slider-runnable-track {
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--contrast-main-color) 28%, transparent);
}
.shelf-panel input[type='range']::-webkit-slider-thumb {
  appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -6.5px;
  border: 2px solid var(--bg-color);
  border-radius: 50%;
  background: var(--contrast-main-color);
  box-shadow: 0 1px 5px #0005;
}
.shelf-panel input[type='range']::-moz-range-track {
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--contrast-main-color) 28%, transparent);
}
.shelf-panel input[type='range']::-moz-range-thumb {
  width: 15px;
  height: 15px;
  border: 2px solid var(--bg-color);
  border-radius: 50%;
  background: var(--contrast-main-color);
  box-shadow: 0 1px 5px #0005;
}
.shelf-panel input[type='range']:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 3px;
  border-radius: 8px;
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
  .toolbar-right.problem {
    grid-column: 1 / -1;
    justify-content: flex-end;
    flex-wrap: wrap;
  }
}
</style>

<style scoped>
.stack-hint {
  font-size: 12px;
  color: var(--contrast-text-color);
  padding: 0 4px;
}
</style>
