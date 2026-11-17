<script setup lang="ts">
import BookshelfSpine from './BookshelfSpine.vue';
import type { BookViewBook } from '~/utils/bookFields';
import { placementStyle } from '~/utils/bookshelfPlacement';
import {
  itemWidth,
  itemHeight,
  minimumShelfHeight,
  minimumBookcaseWidth,
  type Bookcase,
  type Shelf,
  type ShelfItem,
  type ShelfBook,
} from '~~/shared/bookshelf';

const props = defineProps<{
  bookcase: Bookcase;
  caseIndex: number;
  bookcaseCount: number;
  caseLeft: number;
  controlsLayer: HTMLElement | null;
  scale: number;
  editing: boolean;
  selected: string | null;
  selectedBooks: Set<string>;
  adjustments: string[];
  matches: Set<string>;
  booksById: Map<string, BookViewBook>;
  renderBooks: boolean;
  floorTop: number;
  viewportHeight: number;
  focusedShelfId: string | null;
  movingShelfId: string | null;
  movingBookId: string | null;
  movingBooks: Set<string> | null;
  resizeShelfId: string | null;
  resizeCaseId: string | null;
  dragging: boolean;
  dropBefore: boolean;
  dropAfter: boolean;
  caseOffset?: number;
}>();
const emit = defineEmits<{
  'move-case': [event: PointerEvent, bookcase: Bookcase];
  'reorder-case': [id: string, direction: -1 | 1];
  'move-book': [
    event: PointerEvent,
    shelf: Shelf,
    item: ShelfItem,
    book: ShelfBook,
    whole?: boolean,
  ];
  'select-book': [event: MouseEvent, id: string];
  'remove-case': [shelf: Shelf];
  'resize-shelf': [event: PointerEvent, shelf: Shelf];
  'resize-case': [event: PointerEvent, bookcase: Bookcase];
  'adjust-shelf': [shelf: Shelf, amount: number];
  'adjust-case': [bookcase: Bookcase, amount: number];
  'add-shelf': [shelf: Shelf];
  'remove-shelf': [shelf: Shelf];
}>();
function bookFor(id: string): BookViewBook {
  return props.booksById.get(id) ?? { id, title: 'Unavailable book' };
}
const shelfOffsets = computed(() => {
  let total = 0;
  const offsets = props.bookcase.shelves.map((shelf) => {
    const offset = total;
    total += shelf.height;
    return offset;
  });
  return { total, offsets };
});
function renderShelf(shelfIndex: number) {
  const shelf = props.bookcase.shelves[shelfIndex];
  if (!shelf) return false;
  if (props.movingShelfId === shelf.id || props.focusedShelfId === shelf.id)
    return true;
  if (!props.renderBooks) return false;
  const top =
    props.floorTop -
    (shelfOffsets.value.total - (shelfOffsets.value.offsets[shelfIndex] ?? 0)) *
      props.scale;
  const bottom = top + shelf.height * props.scale;
  return bottom >= -600 && top <= props.viewportHeight + 600;
}
</script>

<template>
  <div
    class="bookcase"
    :data-bookcase-id="bookcase.id"
    :class="{ dragging, 'drop-before': dropBefore, 'drop-after': dropAfter }"
    :style="{
      width: `${bookcase.width * scale}px`,
      transform:
        caseOffset === undefined ? undefined : `translateX(${caseOffset}px)`,
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
          v-for="item in renderShelf(shelfIndex) ? shelf.items : []"
          :key="item.books[0]?.id"
          class="shelf-item"
          :class="{
            moving:
              movingShelfId === shelf.id &&
              item.books.some((book) => book.id === movingBookId),
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
            :data-book-id="book.id"
            :class="{
              selected: selected === book.id || selectedBooks.has(book.id),
              moving: movingBooks?.has(book.id),
              needs: adjustments.includes(book.id),
              arranging: editing,
            }"
            :style="placementStyle(book, item, index)"
            :aria-label="`${bookFor(book.id).title}${editing ? ', arrange book' : ', open book'}`"
            @pointerdown.stop="emit('move-book', $event, shelf, item, book)"
            @click="emit('select-book', $event, book.id)"
          >
            <BookshelfSpine
              :placement="book"
              :book="bookFor(book.id)"
              :horizontal="item.horizontal"
              :dimmed="!matches.has(book.id)"
            />
          </button>
        </div>
      </div>
    </div>
  </div>
  <Teleport
    v-if="editing && controlsLayer && (renderBooks || dragging)"
    :to="controlsLayer"
  >
    <div
      class="bookcase-controls"
      :data-control-case-id="bookcase.id"
      :style="{
        left: `${caseLeft + (caseOffset ?? 0)}px`,
        top: `${floorTop - shelfOffsets.total * scale}px`,
        width: `${bookcase.width * scale}px`,
        height: `${shelfOffsets.total * scale}px`,
      }"
    >
      <button
        type="button"
        class="bookcase-move-handle"
        :aria-label="`Move bookcase ${caseIndex + 1}; drag or use left and right arrow keys`"
        title="Drag to move this bookcase"
        @pointerdown.stop="emit('move-case', $event, bookcase)"
        @keydown.left.prevent="emit('reorder-case', bookcase.id, -1)"
        @keydown.right.prevent="emit('reorder-case', bookcase.id, 1)"
      >
        <Icon name="lucide:grip-horizontal" aria-hidden="true" />
      </button>
      <button
        v-if="
          bookcaseCount > 1 &&
          bookcase.shelves.every((shelf) => shelf.items.length === 0) &&
          bookcase.shelves[0]
        "
        type="button"
        class="bookcase-remove-handle"
        :aria-label="`Remove empty bookcase ${caseIndex + 1}`"
        title="Remove empty bookcase"
        @click="emit('remove-case', bookcase.shelves[0])"
      >
        <Icon name="lucide:trash-2" aria-hidden="true" />
      </button>
      <div
        v-for="(shelf, shelfIndex) in bookcase.shelves"
        :key="shelf.id"
        class="shelf-control-viewport"
        :data-control-shelf-id="shelf.id"
        :style="{
          top: `${(shelfOffsets.offsets[shelfIndex] ?? 0) * scale}px`,
          width: `${bookcase.width * scale}px`,
          height: `${shelf.height * scale}px`,
        }"
      >
        <div
          class="shelf-controls-canvas"
          :style="{
            width: `${bookcase.width}px`,
            height: `${shelf.height}px`,
            transform: `scale(${scale})`,
          }"
        >
          <div
            v-for="item in renderShelf(shelfIndex) ? shelf.items : []"
            :key="item.books[0]?.id"
            class="stack-control"
            :style="{
              left: `${item.x}px`,
              width: `${itemWidth(item)}px`,
              height: `${itemHeight(item)}px`,
            }"
          >
            <button
              v-if="item.books.length > 1 && item.books[0]"
              type="button"
              class="stack-handle"
              aria-label="Drag stack"
              @pointerdown.stop="
                emit('move-book', $event, shelf, item, item.books[0], true)
              "
            >
              ⠿
            </button>
          </div>
          <div
            class="shelf-commands"
            :class="{ compact: bookcase.width < 160 }"
          >
            <button
              type="button"
              class="shelf-action"
              :aria-label="`Add shelf above shelf ${shelfIndex + 1} in bookcase ${caseIndex + 1}`"
              title="Add shelf above"
              @click="emit('add-shelf', shelf)"
            >
              <Icon name="lucide:plus" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="shelf-action"
              :aria-label="`Remove shelf ${shelfIndex + 1} from bookcase ${caseIndex + 1}`"
              :disabled="
                shelf.items.length > 0 || bookcase.shelves.length === 1
              "
              :title="
                shelf.items.length
                  ? 'Move books off this shelf first'
                  : bookcase.shelves.length === 1
                    ? 'A bookcase needs at least one shelf'
                    : 'Remove empty shelf'
              "
              @click="emit('remove-shelf', shelf)"
            >
              <Icon name="lucide:trash-2" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="height-handle"
            :class="{
              active: resizeShelfId === shelf.id,
              limit: shelf.height === minimumShelfHeight(shelf),
            }"
            :aria-label="`Resize bookcase ${caseIndex + 1}, shelf ${shelfIndex + 1}. Drag or use up and down arrow keys`"
            title="Drag or use arrow keys to change shelf height"
            @pointerdown.stop="emit('resize-shelf', $event, shelf)"
            @keydown.up.prevent="emit('adjust-shelf', shelf, 5)"
            @keydown.down.prevent="emit('adjust-shelf', shelf, -5)"
          >
            <span
              ><Icon name="lucide:grip-horizontal" aria-hidden="true" /></span
            ><output v-if="resizeShelfId === shelf.id"
              >{{ shelf.height }} px</output
            >
          </button>
        </div>
      </div>
      <button
        type="button"
        class="width-handle"
        :class="{ limit: bookcase.width === minimumBookcaseWidth(bookcase) }"
        :aria-label="`Resize bookcase ${caseIndex + 1}. Drag or use left and right arrow keys`"
        title="Drag or use arrow keys to change bookcase width"
        @pointerdown.stop="emit('resize-case', $event, bookcase)"
        @keydown.left.prevent="emit('adjust-case', bookcase, -5)"
        @keydown.right.prevent="emit('adjust-case', bookcase, 5)"
      >
        <span><Icon name="lucide:grip-vertical" aria-hidden="true" /></span
        ><output v-if="resizeCaseId === bookcase.id"
          >{{ bookcase.width }} px</output
        >
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.bookcase {
  flex: 0 0 auto;
  position: relative;
}
.bookcase.dragging {
  z-index: 9;
  opacity: 0.78;
  pointer-events: none;
}
.bookcase.drop-before::before,
.bookcase.drop-after::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 4px;
  z-index: 8;
  background: var(--main-color);
  border-radius: 3px;
  pointer-events: none;
}
.bookcase.drop-before::before {
  left: -2px;
}
.bookcase.drop-after::after {
  right: -2px;
}
.bookcase-move-handle,
.bookcase-remove-handle {
  position: absolute;
  top: -29px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 8;
  display: grid;
  place-items: center;
  min-width: 38px;
  height: 25px;
  border: 1px solid var(--contrast-border-color);
  border-radius: 6px;
  background: var(--bg-color);
  color: var(--contrast-main-color);
  box-shadow: 0 2px 6px #0002;
  cursor: grab;
  touch-action: none;
  pointer-events: auto;
}
.bookcase-remove-handle {
  left: calc(50% + 24px);
  transform: none;
  min-width: 25px;
  cursor: pointer;
}
.bookcase-move-handle:active {
  cursor: grabbing;
}
.bookcase-move-handle:focus-visible,
.bookcase-remove-handle:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
.shelf-viewport {
  position: relative;
  overflow: visible;
}
.shelf-canvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 340px;
  transform-origin: top left;
  --shelf-frame: color-mix(in srgb, var(--shelf-color) 86%, #21150e);
  border: 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--shelf-color) 15%, var(--bg-color)),
    color-mix(in srgb, var(--shelf-color) 5%, var(--bg-color)) 38%,
    color-mix(in srgb, var(--shelf-color) 9%, var(--bg-color))
  );
  box-shadow:
    -5px -5px var(--shelf-frame),
    5px -5px var(--shelf-frame),
    -5px 0 var(--shelf-frame),
    5px 0 var(--shelf-frame),
    0 -5px var(--shelf-frame),
    inset 0 5px 9px #0002,
    inset 4px 0 7px #0001,
    inset -4px 0 7px #0001;
  box-sizing: border-box;
}
.shelf-canvas:after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 14px;
  background:
    var(--shelf-grain),
    linear-gradient(
      to bottom,
      color-mix(in srgb, var(--shelf-color) 72%, white),
      var(--shelf-color) 34%,
      color-mix(in srgb, var(--shelf-color) 76%, black)
    );
  box-shadow:
    0 4px 7px #0003,
    inset 0 1px #ffffff55,
    inset 0 -1px #0004;
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
  transition: none;
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
.spine-button.moving {
  opacity: 0.35;
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
  pointer-events: auto;
}
.bookcase-controls,
.shelf-control-viewport,
.shelf-controls-canvas {
  position: absolute;
  pointer-events: none;
}
.shelf-controls-canvas {
  top: 0;
  left: 0;
  transform-origin: top left;
}
.stack-control {
  position: absolute;
  bottom: 14px;
  pointer-events: none;
}
.shelf-commands {
  position: absolute;
  right: 3px;
  top: 3px;
  z-index: 8;
  display: flex;
  gap: 3px;
  pointer-events: none;
}
.shelf-commands.compact {
  top: 28px;
}
.shelf-action {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: 7px;
  background: #ffffffe0;
  color: #605c52;
  padding: 4px;
  box-shadow: 0 1px 4px #0002;
  cursor: pointer;
  pointer-events: auto;
}
.shelf-action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.shelf-action:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
.height-handle {
  position: absolute;
  top: 0;
  left: 50%;
  width: 44px;
  transform: translateX(-50%);
  z-index: 6;
  height: 22px;
  border: 0;
  padding: 0;
  background: transparent;
  text-align: center;
  cursor: ns-resize;
  touch-action: none;
  user-select: none;
  pointer-events: auto;
}
.height-handle > span {
  display: inline-grid;
  place-items: center;
  width: 36px;
  height: 16px;
  border-radius: 999px;
  background: #fffaf0ef;
  color: #594338;
  box-shadow: 0 1px 4px #0004;
  transition:
    transform 150ms ease,
    background-color 150ms ease;
}
.height-handle:hover > span,
.height-handle:focus-visible > span,
.height-handle.active > span {
  transform: scale(1.12);
  background: #fffaf0;
}
.height-handle output {
  position: absolute;
  top: 23px;
  left: 50%;
  transform: translateX(-50%);
  background: #314f42;
  color: white;
  border-radius: 5px;
  padding: 4px 8px;
  white-space: nowrap;
  font-size: 11px;
}
.width-handle {
  position: absolute;
  right: -5px;
  top: 50%;
  transform: translateY(-50%);
  height: 44px;
  width: 24px;
  border: 0;
  padding: 0;
  background: transparent;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ew-resize;
  touch-action: none;
  user-select: none;
  pointer-events: auto;
}
.width-handle > span {
  display: grid;
  place-items: center;
  width: 16px;
  height: 36px;
  border-radius: 999px;
  background: #fffaf0ef;
  color: #594338;
  box-shadow: 0 1px 4px #0004;
  transition:
    transform 150ms ease,
    background-color 150ms ease;
}
.width-handle:hover > span,
.width-handle:focus-visible > span {
  transform: scale(1.12);
  background: #fffaf0;
}
.height-handle:focus-visible,
.width-handle:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
.height-handle.limit > span,
.width-handle.limit > span {
  color: #795f4d;
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

.spine-button:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
</style>
