<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import { useMiniCoverStore } from '~/stores/miniCover';
import { useShareCardStore } from '~/stores/shareCard';

type UserBookStatus = 'to_be_read' | 'reading' | 'finished' | 'dnf';

const props = defineProps<{
  bookId: string;
  userStatus?: UserBookStatus | null;
  finishedAt?: string | number | Date | null;
  disabled?: boolean;
}>();

const shareCard = useShareCardStore();
const miniCover = useMiniCoverStore();

const open = ref(false);
const anchorRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const fallbackInputRef = ref<HTMLInputElement | null>(null);

const copyState = ref<'idle' | 'copied' | 'fallback'>('idle');
const liveAnnouncement = ref('');
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const statusCardHint = computed(() => {
  switch (props.userStatus) {
    case 'finished': {
      if (props.finishedAt) {
        const d = new Date(props.finishedAt);
        if (!Number.isNaN(d.getTime())) {
          const formatted = d.toLocaleDateString(undefined, {
            month: 'long',
            year: 'numeric',
          });
          return `Finished · ${formatted}`;
        }
      }
      return 'Share your finished book stats';
    }
    case 'reading':
      return 'Share your current reading progress';
    case 'to_be_read':
      return 'Share as up next on your TBR';
    case 'dnf':
      return 'Share your DNF reading card';
    default:
      return 'Create a shareable card for this book';
  }
});

const bookUrl = computed(() => {
  const path = `/books/${encodeURIComponent(props.bookId)}`;
  if (typeof window === 'undefined') return path;
  try {
    return new URL(path, window.location.origin).href;
  } catch {
    return path;
  }
});

function clearCloseTimer() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function menuItems(): HTMLButtonElement[] {
  if (!panelRef.value) return [];
  return Array.from(
    panelRef.value.querySelectorAll<HTMLButtonElement>(
      'button[role="menuitem"]',
    ),
  );
}

function closeMenu(restoreFocus = false) {
  clearCloseTimer();
  open.value = false;
  copyState.value = 'idle';
  if (restoreFocus) {
    anchorRef.value?.focus();
  }
}

async function openMenu() {
  if (props.disabled) return;
  copyState.value = 'idle';
  liveAnnouncement.value = '';
  open.value = true;
  await nextTick();
  menuItems()[0]?.focus();
}

function toggleMenu() {
  if (open.value) closeMenu();
  else void openMenu();
}

function onMenuKeydown(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeMenu(true);
    return;
  }
  const items = menuItems();
  if (!items.length) return;
  const activeIndex = items.findIndex((el) => el === document.activeElement);
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    const next = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
    items[next]?.focus();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    const prev =
      activeIndex <= 0 ? items.length - 1 : (activeIndex - 1) % items.length;
    items[prev]?.focus();
  } else if (event.key === 'Home') {
    event.preventDefault();
    items[0]?.focus();
  } else if (event.key === 'End') {
    event.preventDefault();
    items[items.length - 1]?.focus();
  }
}

function onDocumentPointerDown(event: MouseEvent) {
  if (!open.value) return;
  const target = event.target as Node | null;
  if (
    (panelRef.value && target && panelRef.value.contains(target)) ||
    (anchorRef.value && target && anchorRef.value.contains(target))
  ) {
    return;
  }
  closeMenu();
}

async function copyBookLink() {
  clearCloseTimer();
  try {
    if (
      typeof navigator === 'undefined' ||
      typeof navigator.clipboard?.writeText !== 'function'
    ) {
      throw new Error('Clipboard unavailable');
    }
    await navigator.clipboard.writeText(bookUrl.value);
    copyState.value = 'copied';
    liveAnnouncement.value = 'Link copied to clipboard';
    closeTimer = setTimeout(() => {
      closeMenu();
    }, 1200);
  } catch {
    copyState.value = 'fallback';
    liveAnnouncement.value = 'Select and copy the book link below';
    await nextTick();
    fallbackInputRef.value?.focus();
    fallbackInputRef.value?.select();
  }
}

function openStatusCard() {
  closeMenu();
  shareCard.open(props.bookId);
}

function openMiniCover() {
  closeMenu();
  miniCover.open(props.bookId);
}

watch(
  () => props.bookId,
  () => {
    if (open.value) closeMenu();
  },
);

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown);
});

onBeforeUnmount(() => {
  clearCloseTimer();
  document.removeEventListener('mousedown', onDocumentPointerDown);
});
</script>

<template>
  <div class="relative">
    <button
      ref="anchorRef"
      v-tooltip="open ? '' : 'Share'"
      aria-label="Share"
      class="px-3 py-2 rounded-md border border-(--contrast-border-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center"
      type="button"
      :disabled="disabled"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggleMenu"
    >
      <Icon name="lucide:share-2" class="text-xl" aria-hidden="true" />
    </button>

    <span class="sr-only" aria-live="polite">{{ liveAnnouncement }}</span>

    <div
      v-if="open"
      ref="panelRef"
      class="absolute right-0 mt-1 w-64 bg-(--bg-color) border border-(--contrast-border-color) rounded-md shadow-lg z-150 overflow-hidden"
      role="menu"
      aria-label="Share this book"
      @keydown="onMenuKeydown"
    >
      <div class="px-3 py-2 border-b border-(--contrast-border-color)">
        <div class="text-xs opacity-70">Share this book</div>
      </div>

      <div class="divide-y divide-(--contrast-border-color)/25">
        <!-- 1. Copy link -->
        <div>
          <button
            class="w-full px-3 py-2.5 text-left justify-start! gap-3 transition rounded-none! flex items-start hover:bg-(--sub-color)/15 text-(--contrast-main-color) opacity-90 hover:opacity-100"
            role="menuitem"
            type="button"
            @click="copyBookLink"
          >
            <Icon
              :name="copyState === 'copied' ? 'lucide:check' : 'lucide:link'"
              class="w-4 h-4 mt-0.5 shrink-0"
              aria-hidden="true"
            />
            <span class="min-w-0 flex flex-col gap-0.5">
              <span class="text-sm font-medium leading-tight">
                {{ copyState === 'copied' ? 'Link copied' : 'Copy link' }}
              </span>
              <span class="text-xs opacity-70 leading-snug">
                Only people with access to this book can open it
              </span>
            </span>
          </button>

          <div
            v-if="copyState === 'fallback'"
            class="px-3 pb-2.5 pt-1 flex flex-col gap-1"
          >
            <input
              ref="fallbackInputRef"
              type="text"
              readonly
              :value="bookUrl"
              aria-label="Book link"
              class="w-full px-2 py-1 text-xs font-mono rounded border border-(--contrast-border-color) bg-(--sub-alt-color) text-(--contrast-text-color)"
              @focus="($event.target as HTMLInputElement).select()"
            />
            <span class="text-[11px] opacity-70">
              Press Ctrl+C or Cmd+C to copy
            </span>
          </div>
        </div>

        <!-- 2. Reading status card -->
        <button
          class="w-full px-3 py-2.5 text-left justify-start! gap-3 transition rounded-none! flex items-start hover:bg-(--sub-color)/15 text-(--contrast-main-color) opacity-90 hover:opacity-100"
          role="menuitem"
          type="button"
          @click="openStatusCard"
        >
          <Icon
            name="lucide:image"
            class="w-4 h-4 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span class="min-w-0 flex flex-col gap-0.5">
            <span class="text-sm font-medium leading-tight">
              Reading status card
            </span>
            <span class="text-xs opacity-70 leading-snug">
              {{ statusCardHint }}
            </span>
          </span>
        </button>

        <!-- 3. Mini book cover -->
        <button
          class="w-full px-3 py-2.5 text-left justify-start! gap-3 transition rounded-none! flex items-start hover:bg-(--sub-color)/15 text-(--contrast-main-color) opacity-90 hover:opacity-100"
          role="menuitem"
          type="button"
          @click="openMiniCover"
        >
          <Icon
            name="lucide:book-copy"
            class="w-4 h-4 mt-0.5 shrink-0"
            aria-hidden="true"
          />
          <span class="min-w-0 flex flex-col gap-0.5">
            <span class="text-sm font-medium leading-tight">
              Mini book cover
            </span>
            <span class="text-xs opacity-70 leading-snug">
              Printable 20 × 10 × 30 mm wrap
            </span>
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
