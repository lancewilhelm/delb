<script setup lang="ts">
import type Book from 'epubjs/types/book';
import type Rendition from 'epubjs/types/rendition';
import type { ReaderTheme } from '~/stores/userSettings';

definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
  layout: false,
});

useHead({
  title: 'Reader',
});

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type ReaderDisplayMode = 'scroll' | 'pages';

const route = useRoute();
const bookId = computed(() => String(route.params.id || ''));

const readerContainer = ref<HTMLElement | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const bookTitle = ref<string>('Reader');
const currentProgress = ref<number | null>(null);
const saveErrorMessage = ref<string | null>(null);

let bookInstance: Book | null = null;
const renditionRef = ref<Rendition | null>(null);

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSavedLocation: string | null = null;

const userSettingsStore = useUserSettingsStore();
const isSettingsOpen = ref(false);
const settingsMenuRef = ref<HTMLElement | null>(null);
// NOTE: the <icon> is a Vue component, so the template ref must be attached to a
// real DOM element (wrapper) for reliable `.contains()` checks.
const settingsButtonRef = ref<HTMLElement | null>(null);
// Wrapper around the reader area (outside the epubjs iframe). We can listen here
// because pointer/click events inside an iframe do not bubble to the parent doc.
const readerAreaRef = ref<HTMLElement | null>(null);

const readerFontSize = userSettingsStore.settingRef<number>('reader.fontSize');
const readerLineHeight =
  userSettingsStore.settingRef<number>('reader.lineHeight');
const readerTheme = userSettingsStore.settingRef<ReaderTheme>('reader.theme');
const readerDisplayMode =
  userSettingsStore.settingRef<ReaderDisplayMode>('reader.displayMode');

const themesRegistered = ref(false);

const router = useRouter();

function backToBook() {
  router.replace(`/books/${encodeURIComponent(bookId.value)}`);
}

function toggleSettings() {
  isSettingsOpen.value = !isSettingsOpen.value;
}

function closeSettings() {
  isSettingsOpen.value = false;
}

function handleDocumentClick(event: Event) {
  if (!isSettingsOpen.value) return;

  const target = event.target as Node | null;
  if (!target) return;

  // Click/tap within the menu or on the settings button should not close it.
  if (settingsMenuRef.value?.contains(target)) return;
  if (settingsButtonRef.value?.contains(target)) return;

  closeSettings();
}

/**
 * We enable swipe paging on mobile devices by configuring epubjs with `snap`.
 * When swipe paging is enabled, we hide the prev/next arrow buttons.
 *
 * NOTE: `isMobileDevice` is declared later in this file, so we must not reference
 * it here (before initialization). Swipe detection is derived directly from
 * `useIsMobileDevice()` inside `getRenditionOptions` and the template condition.
 */

function formatProgress(pct: number | null) {
  if (pct == null) return '—';
  return `${pct.toFixed(1)}%`;
}

function extractProgress(cfi: string | null) {
  if (!bookInstance || !cfi || !bookInstance.locations?.length()) return null;
  const pct = bookInstance.locations.percentageFromCfi(cfi);
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct * 100));
}

function scheduleSave(location: string | null, progress: number | null) {
  if (!location) return;

  if (saveTimeout) clearTimeout(saveTimeout);

  saveTimeout = setTimeout(async () => {
    if (lastSavedLocation === location) return;
    await saveReadingPosition(location, progress ?? undefined);
  }, 1500);
}

function goPrev() {
  renditionRef.value?.prev();
}

function goNext() {
  renditionRef.value?.next();
}

function getThemeTokens() {
  // Grab theme colors from the DOM (for "app" theme)
  const rootStyles = getComputedStyle(document.documentElement);
  const delbBg = rootStyles.getPropertyValue('--bg-color').trim();
  const delbText = rootStyles.getPropertyValue('--text-color').trim();
  const delbMain = rootStyles.getPropertyValue('--main-color').trim();

  switch (readerTheme.value) {
    case 'light':
      return { bg: '#ffffff', text: '#111111', link: '#2563eb' };
    case 'gray':
      return { bg: '#1b1b1b', text: '#dddddd', link: '#93c5fd' };
    case 'shadow':
      return { bg: '#000000', text: '#eeeeee', link: '#eeeeee' };
    default:
      return { bg: delbBg, text: delbText, link: delbMain };
  }
}

function ensureReaderThemeRegistered(rendition: {
  themes: Rendition['themes'];
}) {
  if (themesRegistered.value) return;

  rendition.themes.register('reader-base', {
    body: {
      background: 'var(--reader-bg)',
      color: 'var(--reader-text)',
      'line-height': 'var(--reader-line-height)',
    },
    a: {
      color: 'var(--reader-link)',
    },
  });

  themesRegistered.value = true;
}

function applyReaderSettings() {
  const rendition = renditionRef.value;
  if (!rendition || typeof window === 'undefined') return;

  ensureReaderThemeRegistered(rendition);

  const themeTokens = getThemeTokens();

  // Apply base theme + CSS vars
  rendition.themes.select('reader-base');
  rendition.themes.override('--reader-bg', themeTokens.bg);
  rendition.themes.override('--reader-text', themeTokens.text);
  rendition.themes.override('--reader-link', themeTokens.link);

  // Force a theme refresh in case the rendition just recreated and the first
  // section rendered before overrides were applied.
  rendition.themes.select('reader-base');

  // Apply font size + line height
  const fontSize = readerFontSize.value ?? 100;
  const lineHeight = readerLineHeight.value ?? 120;
  rendition.themes.fontSize(`${fontSize}%`);
  rendition.themes.override('--reader-line-height', `${lineHeight}%`);
}

function getRenditionOptions(mode: ReaderDisplayMode) {
  // Determine swipe capability at call time (avoids referencing `isMobileDevice` before init).
  const swipe = 'ontouchstart' in window || useIsMobileDevice().value;

  if (mode === 'pages') {
    return {
      // On mobile, use continuous manager + snap for swipe paging.
      manager: 'continuous',
      flow: 'paginated',
      snap: swipe ? {} : undefined,
      spread: 'none',
      width: '100%',
      height: '100%',
      minSpreadWidth: 900,
      allowScriptedContent: true,
    };
  }

  return {
    manager: 'continuous',
    flow: 'scrolled',
    width: '100%',
    height: '100%',
    spread: 'none',
    minSpreadWidth: 900,
    allowScriptedContent: true,
  };
}

function attachRenditionHandlers(
  rendition: Pick<Rendition, 'on'> & Partial<Pick<Rendition, 'off'>>,
) {
  rendition.on('relocated', (loc: { start?: { cfi?: string } }) => {
    const cfi = loc?.start?.cfi ?? null;
    const progress = extractProgress(cfi);
    currentProgress.value = progress;
    scheduleSave(cfi, progress);
  });

  rendition.on('click', onRenditionClick);

  // Re-apply theme after sections render (prevents "black text" after mode switch)
  rendition.on('rendered', () => {
    applyReaderSettings();
  });
}

async function recreateRendition({
  displayCfi,
}: {
  displayCfi?: string | null;
} = {}) {
  if (!bookInstance) {
    throw new Error('Book instance not initialized.');
  }

  await bookInstance.ready;

  if (!readerContainer.value) {
    throw new Error('Reader container not ready.');
  }

  // Tear down any previous rendition (mode/size changes require fresh layout)
  renditionRef.value?.destroy();
  renditionRef.value = null;

  // Themes are registered per-rendition in epubjs. Since we just destroyed the
  // old rendition, we must reset our registration flag so the new rendition
  // eagerly re-registers the base theme.
  themesRegistered.value = false;

  renditionRef.value = bookInstance.renderTo(
    readerContainer.value,
    getRenditionOptions(readerDisplayMode.value),
  );

  const rendition = renditionRef.value;
  if (!rendition) {
    throw new Error('Reader not initialized.');
  }

  attachRenditionHandlers(rendition);

  // Apply theme/font settings to the new rendition (and register the base theme)
  applyReaderSettings();

  // Display the requested location (or default)
  if (displayCfi) {
    await rendition.display(displayCfi);
  } else {
    await rendition.display();
  }
}

function getThemeClass(hover?: boolean) {
  const theme = readerTheme.value ?? 'app';

  const base =
    theme === 'gray'
      ? 'bg-[#1b1b1b] text-[#ddd]'
      : theme === 'shadow'
        ? 'bg-black text-[#eee]'
        : theme === 'light'
          ? 'bg-[#fff] text-[#111]'
          : '';

  if (!hover) return base;

  if (theme === 'gray') return base + ' hover:bg-[#222]';
  if (theme === 'shadow') return base + ' hover:bg-[#111]';
  if (theme === 'light') return base + ' hover:bg-[#eee]';
  return base + ' hover:bg-(--sub-color)/5';
}

async function loadReadingPosition() {
  if (!bookId.value) return null;

  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId.value)}/reading-position`,
    { method: 'GET' },
  );

  if (!res.ok) {
    return { location: null, progress: null };
  }

  const json = (await res.json().catch(() => null)) as {
    success?: boolean;
    data?: { location?: string | null; progress?: number | null };
    message?: string;
  } | null;

  if (!json?.success) {
    return { location: null, progress: null };
  }

  return {
    location: json?.data?.location ?? null,
    progress: json?.data?.progress ?? null,
  };
}

async function saveReadingPosition(
  location: string,
  progress?: number | null,
) {
  if (!bookId.value) return;

  const body: { location: string; progress?: number } = { location };
  if (progress != null) {
    body.progress = progress;
  }

  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId.value)}/reading-position`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      throw new Error(`Failed to save reading position (${res.status})`);
    }

    lastSavedLocation = location;
    saveErrorMessage.value = null;
  } catch (err) {
    const e = err as FetchErrorLike;
    saveErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Could not save reading position';
  }
}

async function loadBookTitle() {
  if (!bookId.value) return;

  try {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId.value)}`, {
      method: 'GET',
    });

    if (!res.ok) return;

    const json = (await res.json().catch(() => null)) as {
      data?: {
        book?: {
          title?: string;
          authors?: Array<{ name?: string }> | string[];
          publisher?: { name?: string } | null;
          series?: { name?: string; index?: number | null } | null;
          published?: string | null;
          language?: string | null;
          pages?: number | null;
        };
      };
    } | null;

    const book = json?.data?.book;
    const title = book?.title?.trim() ?? null;

    bookTitle.value = title || bookTitle.value;
    if (title) {
      useHead({ title: `Reading · ${title}` });
    }
  } catch {
    // Title is best-effort; ignore failures.
  }
}

async function fetchBook() {
  if (!bookId.value) {
    errorMessage.value = 'Missing book id';
    return;
  }

  const res = await fetch(
    `/api/books/${encodeURIComponent(bookId.value)}/download`,
    { method: 'GET' },
  );

  if (!res.ok) {
    throw new Error(`Failed to download book (${res.status})`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/epub+zip')) {
    throw new Error('This book is not available as an EPUB.');
  }

  const data = await res.arrayBuffer();
  const { default: ePub } = await import('epubjs');

  bookInstance = ePub(data);
}

async function loadEpub() {
  loading.value = true;
  errorMessage.value = null;

  try {
    await fetchBook();

    const saved = await loadReadingPosition();
    const savedLocation = saved?.location ?? null;
    const shouldGenerateLocations = saved?.progress == null;

    await recreateRendition({ displayCfi: savedLocation });

    const rendition = renditionRef.value;
    if (!rendition) {
      throw new Error('Reader not initialized.');
    }

    if (savedLocation) {
      currentProgress.value = saved?.progress ?? extractProgress(savedLocation);
    }

    if (shouldGenerateLocations) {
      setTimeout(() => {
        bookInstance?.locations
          .generate(400)
          .then(() => {
            if (currentProgress.value == null) {
              const fallbackLocation =
                savedLocation ?? renditionRef.value?.location?.start?.cfi ?? null;
              const progress = extractProgress(fallbackLocation);
              if (progress != null) {
                currentProgress.value = progress;
                if (fallbackLocation) {
                  void saveReadingPosition(fallbackLocation, progress);
                }
              }
            }
          })
          .catch(() => null);
      }, 0);
    }

    showFullscreenTemporarily();
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load reader';
  } finally {
    loading.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowLeft') {
    goPrev();
  } else if (event.key === 'ArrowRight') {
    goNext();
  } else if (event.key === 'Escape') {
    backToBook();
  }
}

onMounted(async () => {
  await loadBookTitle();
  await nextTick();
  await loadEpub();
  window.addEventListener('keydown', onKeydown);

  // Use capture + pointerdown so we catch outside clicks even if something
  // inside stops propagation. NOTE: clicks inside the epubjs iframe won't bubble
  // to the document, so we also attach a listener to `readerAreaRef` in the template.
  document.addEventListener('pointerdown', handleDocumentClick, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('pointerdown', handleDocumentClick, true);
  if (saveTimeout) clearTimeout(saveTimeout);
  if (fullscreenHideTimeout) clearTimeout(fullscreenHideTimeout);
  (
    renditionRef.value as { off?: (event: string, handler: () => void) => void }
  )?.off?.('click', onRenditionClick);
  renditionRef.value?.destroy();
  bookInstance?.destroy();
});

const isMobileDevice = useIsMobileDevice();
const isFullscreen = ref<boolean>(false);
const fullscreenVisible = ref(false);
let fullscreenHideTimeout: ReturnType<typeof setTimeout> | null = null;

function showFullscreenTemporarily() {
  if (!isMobileDevice.value) return;
  fullscreenVisible.value = true;

  if (fullscreenHideTimeout) clearTimeout(fullscreenHideTimeout);
  fullscreenHideTimeout = setTimeout(() => {
    fullscreenVisible.value = false;
  }, 2000);
}

function handleContentTap() {
  showFullscreenTemporarily();
}

const onRenditionClick = () => {
  showFullscreenTemporarily();
};

function toggleFullscreen() {
  isFullscreen.value = !isFullscreen.value;
  renditionRef.value?.start();
}

watch([readerFontSize, readerLineHeight, readerTheme], () => {
  applyReaderSettings();
});

watch(readerDisplayMode, async () => {
  // Preserve current location while switching modes (the container width changes
  // because the prev/next buttons hide/show, so we recreate the rendition to
  // force a fresh layout pass).
  const displayCfi = renditionRef.value?.location?.start?.cfi ?? null;
  await nextTick();
  await recreateRendition({ displayCfi });
});
</script>

<template>
  <div class="flex flex-col h-full w-full overflow-hidden">
    <!-- Page header -->
    <div
      v-if="!isFullscreen"
      class="relative z-60 flex items-center justify-between p-2 border-b border-t border-(--sub-color) bg-(--sub-alt-color)"
    >
      <div class="flex items-center gap-3 min-w-0">
        <!-- Back button -->
        <icon
          v-tooltip="'Back to book'"
          name="lucide:arrow-left"
          class="text-3xl opacity-80 hover:opacity-100 cursor-pointer"
          @click="backToBook"
        />

        <div class="min-w-0">
          <div class="text-lg font-semibold truncate">{{ bookTitle }}</div>
        </div>
      </div>

      <div class="flex items-center gap-3 text-sm">
        <div class="relative">
          <div ref="settingsButtonRef" class="flex">
            <icon
              v-tooltip="'Reader settings'"
              name="lucide:settings-2"
              class="text-2xl opacity-80 hover:opacity-100 cursor-pointer"
              @click.stop="toggleSettings"
            />
          </div>

          <!-- Settings menu -->
          <div
            v-if="isSettingsOpen"
            ref="settingsMenuRef"
            class="absolute right-0 mt-2 w-72 rounded-md border border-(--sub-color) bg-(--bg-color) p-3 shadow-lg"
            @click.stop
          >
            <div class="space-y-3">
              <div class="space-y-1">
                <div class="text-sm">Font size</div>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="readerFontSize"
                    type="range"
                    min="70"
                    max="150"
                    step="1"
                    class="slider w-full!"
                  />
                  <span class="w-10 text-right">{{ readerFontSize }}%</span>
                </div>
              </div>

              <div class="space-y-1">
                <div class="text-sm">Line height</div>
                <div class="flex items-center gap-2">
                  <input
                    v-model.number="readerLineHeight"
                    type="range"
                    min="100"
                    max="200"
                    step="1"
                    class="slider w-full!"
                  />
                  <span class="w-10 text-right">{{ readerLineHeight }}%</span>
                </div>
              </div>

              <div class="space-y-2">
                <div class="text-sm">Theme</div>
                <div class="grid grid-cols-4 gap-2">
                  <label class="cursor-pointer">
                    <input
                      v-model="readerTheme"
                      type="radio"
                      value="light"
                      class="sr-only peer"
                    />
                    <span
                      class="flex items-center justify-center rounded-md px-2 py-1 text-center text-xs font-medium bg-white text-[#111] border-white peer-checked:border-(--main-color) border-2"
                    >
                      Light
                    </span>
                  </label>
                  <label class="cursor-pointer">
                    <input
                      v-model="readerTheme"
                      type="radio"
                      value="gray"
                      class="sr-only peer"
                    />
                    <span
                      class="flex items-center justify-center rounded-md px-2 py-1 text-center text-xs font-medium bg-[#1b1b1b] text-[#ddd] border-[#1b1b1b] peer-checked:border-(--main-color) border-2"
                    >
                      Gray
                    </span>
                  </label>
                  <label class="cursor-pointer">
                    <input
                      v-model="readerTheme"
                      type="radio"
                      value="shadow"
                      class="sr-only peer"
                    />
                    <span
                      class="flex items-center justify-center rounded-md px-2 py-1 text-center text-xs font-medium bg-black text-[#eee] border-black peer-checked:border-(--main-color) border-2"
                    >
                      Shadow
                    </span>
                  </label>
                  <label class="cursor-pointer">
                    <input
                      v-model="readerTheme"
                      type="radio"
                      value="app"
                      class="sr-only peer"
                    />
                    <span
                      class="flex items-center justify-center rounded-md px-2 py-1 text-center text-xs font-medium bg-(--bg-color) text-(--text-color) border-(--sub-color) peer-checked:border-(--main-color) border-2"
                    >
                      Delb
                    </span>
                  </label>
                </div>
              </div>

              <div class="space-y-2">
                <div class="text-sm">Display Mode</div>
                <div class="grid grid-cols-2 gap-2">
                  <label class="cursor-pointer">
                    <input
                      v-model="readerDisplayMode"
                      type="radio"
                      value="pages"
                      class="sr-only peer"
                    />
                    <span
                      class="block rounded-md px-2 py-1 text-center text-xs font-medium bg-(--sub-alt-color) text-(--text-color) peer-checked:bg-(--main-color) peer-checked:text-(--bg-color)"
                    >
                      Pages
                    </span>
                  </label>
                  <label class="cursor-pointer">
                    <input
                      v-model="readerDisplayMode"
                      type="radio"
                      value="scroll"
                      class="sr-only peer"
                    />
                    <span
                      class="block rounded-md px-2 py-1 text-center text-xs font-medium bg-(--sub-alt-color) text-(--text-color) peer-checked:bg-(--main-color) peer-checked:text-(--bg-color)"
                    >
                      Scroll
                    </span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>

        <span class="font-medium">{{ formatProgress(currentProgress) }}</span>
        <span v-if="saveErrorMessage" class="text-(--error-color) text-xs">
          {{ saveErrorMessage }}
        </span>
      </div>
    </div>

    <!-- Page content -->
    <div
      ref="readerAreaRef"
      class="relative flex h-full w-full overflow-hidden"
      :class="{ 'px-4': isMobileDevice && readerDisplayMode === 'pages' }"
      @click="handleContentTap"
    >
      <!-- Overlay: when settings are open, capture any click/tap over the reader (including the epubjs iframe)
           and close the settings menu. -->
      <div
        v-if="isSettingsOpen"
        class="absolute inset-0 z-40"
        @pointerdown="closeSettings"
        @click="closeSettings"
      />
      <!-- Previous page button -->
      <div
        v-if="readerDisplayMode === 'pages' && !isMobileDevice"
        class="flex items-center p-2 cursor-pointer shrink-0"
        :class="getThemeClass(true)"
        @click.stop="goPrev"
      >
        <icon name="lucide:arrow-left" class="text-2xl opacity-80" />
      </div>

      <!-- Page content -->
      <div class="h-full flex-1 min-w-0" :class="getThemeClass()">
        <div ref="readerContainer" class="w-full h-full" />

        <div
          v-if="loading"
          class="flex items-center justify-center w-full h-full"
        >
          <div class="text-sm opacity-80">Loading reader…</div>
        </div>

        <div
          v-else-if="errorMessage"
          class="flex items-center justify-center w-full h-full"
        >
          <div class="text-sm text-(--error-color)">{{ errorMessage }}</div>
        </div>
      </div>

      <!-- Next page button -->
      <div
        v-if="readerDisplayMode === 'pages' && !isMobileDevice"
        class="flex items-center p-2 hover:bg-(--sub-color)/5 cursor-pointer shrink-0"
        :class="getThemeClass(true)"
        @click.stop="goNext"
      >
        <icon name="lucide:arrow-right" class="text-2xl opacity-80" />
      </div>

      <!-- Full screen toggle -->
      <div class="absolute right-0 top-0 h-40 w-40 group">
        <div
          class="flex items-center justify-center absolute right-4 top-4 w-13 h-13 rounded-full bg-(--sub-alt-color) transition-opacity cursor-pointer full-screen-toggle-btn"
          :class="
            isMobileDevice
              ? fullscreenVisible
                ? 'opacity-90 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
              : 'opacity-0 pointer-events-none group-hover:opacity-90 group-hover:pointer-events-auto'
          "
          @click.stop="toggleFullscreen"
        >
          <icon
            :name="
              isFullscreen
                ? 'mingcute:fullscreen-exit-2-fill'
                : 'mingcute:fullscreen-2-fill'
            "
            class="text-3xl"
          />
        </div>
      </div>
    </div>
  </div>
</template>
