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
  scale: number;
  editing: boolean;
  selected: string | null;
  adjustments: string[];
  matches: Set<string>;
  booksById: Map<string, BookViewBook>;
  movingShelfId: string | null;
  movingBookId: string | null;
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
  'select-shelf': [id: string];
  'resize-shelf': [event: PointerEvent, shelf: Shelf];
  'resize-case': [event: PointerEvent, bookcase: Bookcase];
}>();
function bookFor(id: string): BookViewBook {
  return props.booksById.get(id) ?? { id, title: 'Unavailable book' };
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
    <button
      v-if="editing"
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
            :class="{
              selected: selected === book.id,
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
          <button
            v-if="editing && item.books.length > 1 && item.books[0]"
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
        <button
          v-if="editing"
          type="button"
          class="shelf-options"
          :aria-label="`Options for bookcase ${caseIndex + 1}, shelf ${shelfIndex + 1}`"
          @click="emit('select-shelf', shelf.id)"
        >
          <Icon name="lucide:ellipsis" aria-hidden="true" />
        </button>
        <div
          v-if="editing"
          class="height-handle"
          :class="{
            active: resizeShelfId === shelf.id,
            limit: shelf.height === minimumShelfHeight(shelf),
          }"
          title="Drag to change shelf height"
          @pointerdown.stop="emit('resize-shelf', $event, shelf)"
        >
          <span>↕</span
          ><output v-if="resizeShelfId === shelf.id"
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
      @pointerdown.stop="emit('resize-case', $event, bookcase)"
    >
      <span>↔</span
      ><output v-if="resizeCaseId === bookcase.id"
        >{{ bookcase.width }} px</output
      >
    </div>
  </div>
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
.bookcase-move-handle {
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
}
.bookcase-move-handle:active {
  cursor: grabbing;
}
.bookcase-move-handle:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
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
  background: var(--bg-color);
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
  border-radius: 7px;
  background: #ffffffe0;
  color: #605c52;
  padding: 5px;
  box-shadow: 0 1px 4px #0002;
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

.spine-button:focus-visible {
  outline: 2px solid var(--contrast-main-color);
  outline-offset: 2px;
}
</style>
