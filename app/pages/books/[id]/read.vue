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

type TocItem = {
  label: string;
  href: string;
  subitems?: TocItem[];
};

type FlatTocItem = {
  label: string;
  href: string;
  depth: number;
};

const route = useRoute();
const bookId = computed(() => String(route.params.id || ''));

const readerAreaRef = ref<HTMLElement | null>(null);
const readerContainer = ref<HTMLElement | null>(null);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const bookTitle = ref<string>('Reader');
const currentProgress = ref<number | null>(null);
const saveErrorMessage = ref<string | null>(null);
const epubFileId = ref<string | null>(null);

// While EPUB.js locations are generating, progress derived from CFI can be wrong
// (often 0.0%). We keep showing cached progress and display a pending indicator.
const isAwaitingLocations = ref(false);

let bookInstance: Book | null = null;
const renditionRef = ref<Rendition | null>(null);

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSavedLocation: string | null = null;

const userSettingsStore = useUserSettingsStore();
const isSettingsOpen = ref(false);
const isTocOpen = ref(false);
const tocLoading = ref(false);
const tocErrorMessage = ref<string | null>(null);
const tocItems = ref<TocItem[]>([]);
const currentSectionHref = ref<string | null>(null);

const readerFontSize = userSettingsStore.settingRef<number>('reader.fontSize');
const readerLineHeight =
  userSettingsStore.settingRef<number>('reader.lineHeight');
const readerTheme = userSettingsStore.settingRef<ReaderTheme>('reader.theme');
const readerDisplayMode =
  userSettingsStore.settingRef<ReaderDisplayMode>('reader.displayMode');

const themesRegistered = ref(false);

const router = useRouter();

/** Navigate back to the book page. */
function backToBook() {
  const targetPath = `/books/${encodeURIComponent(bookId.value)}`;

  // If the previous history entry is already the book page, going "back" avoids
  // duplicating the book route (book → read → replace-to-book => book twice).
  if (import.meta.client) {
    const back = (window.history.state as { back?: unknown } | null)?.back;
    if (typeof back === 'string') {
      try {
        const backUrl = new URL(back, window.location.origin);
        if (backUrl.pathname === targetPath) {
          router.back();
          return;
        }
      } catch {
        // Ignore invalid URLs and fall back to replace.
      }
    }
  }

  router.replace(targetPath);
}

/** Toggle the settings menu. */
function toggleSettings() {
  if (!isSettingsOpen.value) {
    isTocOpen.value = false;
  }
  isSettingsOpen.value = !isSettingsOpen.value;
}

/** Close the settings menu. */
function closeSettings() {
  isSettingsOpen.value = false;
}

function toggleToc() {
  if (!isTocOpen.value) {
    isSettingsOpen.value = false;
  }
  isTocOpen.value = !isTocOpen.value;
}

function closeToc() {
  isTocOpen.value = false;
}

/**
 * Format the progress percentage.
 * @param pct The progress percentage.
 * @returns The formatted progress percentage string.
 */
function formatProgress(pct: number | null) {
  if (pct == null) return '—';
  return `${pct.toFixed(1)}%`;
}

function isMeaningfullyNonZero(pct: number | null) {
  return pct != null && Number.isFinite(pct) && pct >= 0.05;
}

/**
 * Extracts the progress percentage from the given CFI.
 * @param cfi The CFI string.
 * @returns The progress percentage or null if extraction fails.
 */
function extractProgress(cfi: string | null) {
  // if (!bookInstance || !cfi || !bookInstance.locations?.length()) return null;
  if (!bookInstance) {
    return null;
  } else if (!cfi) {
    return null;
  } else if (!bookInstance.locations?.length()) {
    return null;
  }

  const pct = bookInstance.locations.percentageFromCfi(cfi);
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, pct * 100));
}

/**
 * Debounces saving the reading position.
 * @param location The current location.
 * @param progress The current progress percentage.
 */
function scheduleSave(location: string | null, progress: number | null) {
  if (!location) return;

  // Never persist "unknown" progress. We'll keep showing cached progress
  // until locations are generated and `percentageFromCfi` can produce a value.
  if (progress == null) return;

  if (saveTimeout) clearTimeout(saveTimeout);

  saveTimeout = setTimeout(async () => {
    if (lastSavedLocation === location) return;
    await saveReadingPosition(location, progress);
  }, 1500);
}

/** Navigate to the previous book page. */
function goPrev() {
  renditionRef.value?.prev();
}

/** Navigate to the next book page. */
function goNext() {
  renditionRef.value?.next();
}

/**
 * Gets the current theme tokens.
 * @returns The theme tokens object.
 */
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

/**
 * Registers the base reader theme.
 * @param rendition The rendition object.
 */
function registerBaseReaderTheme(rendition: { themes: Rendition['themes'] }) {
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

/** Applies reader settings to the rendition. */
function applyReaderSettings() {
  const rendition = renditionRef.value;
  if (!rendition || typeof window === 'undefined') return;

  registerBaseReaderTheme(rendition);

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

/**
 * Gets the rendition options for the reader.
 * @param mode The display mode.
 */
function getRenditionOptions(mode: ReaderDisplayMode) {
  // Determine swipe capability at call time (avoids referencing `isMobileDevice` before init).
  const swipe = 'ontouchstart' in window || useIsMobileDevice().value;

  if (mode === 'pages') {
    return {
      // On mobile, use continuous manager + snap for swipe paging.
      manager: 'continuous',
      flow: 'paginated',
      snap: swipe ? {} : undefined,
      width: '100%',
      height: '100%',
      minSpreadWidth: 1100,
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

function flattenToc(items: TocItem[], depth = 0): FlatTocItem[] {
  const out: FlatTocItem[] = [];
  for (const item of items) {
    out.push({ label: item.label, href: item.href, depth });
    if (item.subitems?.length) {
      out.push(...flattenToc(item.subitems, depth + 1));
    }
  }
  return out;
}

const flatToc = computed(() => flattenToc(tocItems.value));

function normalizeHref(href: string) {
  return href.split('#')[0] || href;
}

function isActiveTocHref(href: string) {
  const current = currentSectionHref.value;
  if (!current) return false;
  return normalizeHref(current) === normalizeHref(href);
}

function normalizeToc(raw: unknown): TocItem[] {
  if (!Array.isArray(raw)) return [];

  const normalizeItem = (v: unknown): TocItem | null => {
    if (!v || typeof v !== 'object') return null;
    const obj = v as Record<string, unknown>;

    const labelRaw = obj.label;
    const hrefRaw = obj.href;

    const label =
      typeof labelRaw === 'string'
        ? labelRaw.trim()
        : typeof labelRaw === 'number'
          ? String(labelRaw)
          : '';
    const href = typeof hrefRaw === 'string' ? hrefRaw.trim() : '';

    if (!href) return null;

    const subitems = normalizeToc(obj.subitems);

    return {
      label: label || href,
      href,
      subitems: subitems.length ? subitems : undefined,
    };
  };

  return raw.map(normalizeItem).filter((v): v is TocItem => Boolean(v));
}

async function loadToc() {
  if (!bookInstance) return;

  tocLoading.value = true;
  tocErrorMessage.value = null;

  try {
    const loaded = (bookInstance as unknown as { loaded?: unknown })?.loaded as
      | { navigation?: Promise<unknown> }
      | undefined;

    const rawNav = await loaded?.navigation;

    // epubjs examples resolve navigation directly to a toc array; some builds
    // expose an object with a `toc` property.
    const rawToc =
      Array.isArray(rawNav) && rawNav.length
        ? rawNav
        : (rawNav as { toc?: unknown } | null)?.toc;

    tocItems.value = normalizeToc(rawToc);
  } catch {
    tocItems.value = [];
    tocErrorMessage.value = 'Could not load table of contents';
  } finally {
    tocLoading.value = false;
  }
}

async function goToTocHref(href: string) {
  if (!href) return;

  try {
    await renditionRef.value?.display(href);
  } finally {
    if (isMobileDevice.value) {
      closeToc();
    }
  }
}

async function refreshRenditionLayout() {
  const rendition = renditionRef.value;
  const container = readerContainer.value ?? readerAreaRef.value;
  if (!rendition || !container) return;

  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const rect = container.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  rendition.resize(Math.floor(rect.width), Math.floor(rect.height));
  void rendition.reportLocation();
}

/**
 * Attaches event handlers to the rendition.
 * @param rendition The rendition object.
 */
function attachRenditionHandlers(
  rendition: Pick<Rendition, 'on'> & Partial<Pick<Rendition, 'off'>>,
) {
  rendition.on(
    'relocated',
    (loc: { start?: { cfi?: string; href?: string } }) => {
      const cfi = loc?.start?.cfi ?? null;
      currentSectionHref.value = loc?.start?.href ?? null;
      const progress = extractProgress(cfi);

      // While locations are missing (or still generating), `extractProgress` is null.
      // Also, right after navigation it can transiently show ~0.0% even though the
      // true progress (from percentageFromCfi) is not known yet.
      //
      // Behavior:
      // - If progress is null: keep cached UI value, show pending indicator.
      // - If progress is ~0 but we were previously showing a non-zero value: treat
      //   as pending to avoid misleading 0.0% while awaiting locations.
      // - Otherwise: accept and persist computed progress.
      if (progress == null) {
        isAwaitingLocations.value = true;
        return;
      }

      if (
        isAwaitingLocations.value &&
        !isMeaningfullyNonZero(progress) &&
        isMeaningfullyNonZero(currentProgress.value)
      ) {
        return;
      }

      isAwaitingLocations.value = false;
      currentProgress.value = progress;
      scheduleSave(cfi, progress);
    },
  );

  rendition.on('click', onRenditionClick);

  // Re-apply theme after sections render (prevents "black text" after mode switch)
  rendition.on('rendered', () => {
    applyReaderSettings();
  });
}

/**
 * Creates new rendition and applies settings and themes
 * @param displayCfi The display cfi.
 */
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

  renditionRef.value?.destroy();
  renditionRef.value = null;

  // Needed to properly generate the new theme, if necessary
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

/**
 * Gets tailwind classes for object styling in the settings menu
 * @param hover Whether the element is being hovered over
 * @returns The tailwind classes for the element
 */
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

/**
 * Fetches the reading position from the backend db
 * @returns The reading position data
 */
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

/**
 * Saves the reading position to the backend db
 * @param location The location to save
 * @param progress The progress to save
 */
async function saveReadingPosition(location: string, progress?: number | null) {
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

/**
 * Fetch the book information and assigns it to applicaple refs
 */
async function loadBookMetadata() {
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
          files?: Array<{
            id?: string;
            format?: string | null;
            relativePath?: string;
          }>;
        };
        files?: Array<{
          id?: string;
          format?: string | null;
          relativePath?: string;
        }>;
      };
    } | null;

    const book = json?.data?.book;
    const title = book?.title?.trim() ?? null;

    bookTitle.value = title || bookTitle.value;
    if (title) {
      useHead({ title: `Reading · ${title}` });
    }

    const files = (json?.data?.files ?? book?.files ?? []) as Array<{
      id?: string;
      format?: string | null;
    }>;

    const epub = files.find((f) => (f.format || '').toLowerCase() === 'epub');
    epubFileId.value = epub?.id ? String(epub.id) : null;
  } catch {
    // Title is best-effort; ignore failures.
  }
}

/**
 * Fetches the book file
 */
async function fetchBook() {
  if (!bookId.value) {
    errorMessage.value = 'Missing book id';
    return;
  }

  const url = new URL(
    `/api/books/${encodeURIComponent(bookId.value)}/download`,
    window.location.origin,
  );

  // Reader only supports EPUB for now. Force an EPUB response.
  url.searchParams.set('format', 'epub');
  if (epubFileId.value) {
    url.searchParams.set('fileId', epubFileId.value);
  }

  const res = await fetch(url.toString(), { method: 'GET' });

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error('This book is not available as an EPUB.');
    }
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

/**
 * Load the epub, fetches the book file and initializes the reader
 */
async function loadEpub() {
  loading.value = true;
  errorMessage.value = null;

  try {
    await fetchBook();

    const saved = await loadReadingPosition();
    const savedLocation = saved?.location ?? null;

    // Always kick off location generation in the background. It can be slow,
    // but it should not block the initial render or cached progress display.
    const shouldGenerateLocations = true;

    await recreateRendition({ displayCfi: savedLocation });
    void loadToc();

    const rendition = renditionRef.value;
    if (!rendition) {
      throw new Error('Reader not initialized.');
    }

    // Prefer cached progress immediately (fast) and only replace it once
    // locations are generated and we can compute an authoritative value.
    if (saved?.progress != null) {
      currentProgress.value = saved.progress;
      isAwaitingLocations.value = true;
    }

    if (shouldGenerateLocations) {
      isAwaitingLocations.value = true;

      setTimeout(() => {
        bookInstance?.locations
          .generate(400)
          .then(() => {
            const fallbackLocation =
              savedLocation ?? renditionRef.value?.location?.start?.cfi ?? null;

            const progress = extractProgress(fallbackLocation);

            // Only update UI and persist if we computed progress from
            // `percentageFromCfi` (i.e., not null).
            if (progress != null) {
              isAwaitingLocations.value = false;
              currentProgress.value = progress;
              if (fallbackLocation) {
                void saveReadingPosition(fallbackLocation, progress);
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
    if (isSettingsOpen.value) {
      closeSettings();
    } else if (isTocOpen.value) {
      closeToc();
    } else {
      backToBook();
    }
  }
}

onMounted(async () => {
  await loadBookMetadata();
  await nextTick();
  await loadEpub();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
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
  isSettingsOpen.value = false;
  isTocOpen.value = false;
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

watch(
  isTocOpen,
  () => {
    void refreshRenditionLayout();
  },
  { flush: 'post' },
);
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
          class="text-3xl opacity-80 hover:opacity-100 cursor-pointer shrink-0"
          @click="backToBook"
        />

        <div class="min-w-0">
          <div class="text-lg font-semibold truncate">{{ bookTitle }}</div>
        </div>
      </div>

      <div class="flex items-center gap-3 text-sm">
        <icon
          v-tooltip="'Table of contents'"
          name="lucide:list"
          class="text-2xl opacity-80 hover:opacity-100 cursor-pointer"
          :class="{ 'text-(--main-color) opacity-100': isTocOpen }"
          @click.stop="toggleToc"
        />
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

        <span class="font-medium">
          {{ formatProgress(currentProgress)
          }}<span
            v-if="isAwaitingLocations"
            class="align-top text-xs text-(--muted-color)"
            title="Awaiting updated book locations"
            >*</span
          >
        </span>
        <span v-if="saveErrorMessage" class="text-(--error-color) text-xs">
          {{ saveErrorMessage }}
        </span>
      </div>
    </div>

    <!-- Page content -->
    <div
      ref="readerAreaRef"
      class="relative flex h-full w-full overflow-hidden"
      :class="{ '': isMobileDevice && readerDisplayMode === 'pages' }"
      @click="handleContentTap"
    >
      <!-- Table of contents -->
      <div
        v-if="isTocOpen"
        class="absolute inset-0 z-50 flex md:static md:inset-auto md:z-auto md:shrink-0 md:w-80"
        @click.stop
      >
        <div
          class="flex h-full w-full flex-col border-r border-(--sub-color) bg-(--bg-color)"
        >
          <div
            class="flex items-center justify-between px-3 py-1 border-b border-(--sub-color)"
          >
            <div class="text-sm font-semibold">Contents</div>
            <icon
              v-tooltip="'Close'"
              name="lucide:x"
              class="text-2xl opacity-80 hover:opacity-100 cursor-pointer md:hidden"
              @click="closeToc"
            />
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto p-2">
            <div v-if="tocLoading" class="text-sm opacity-80 p-2">
              Loading table of contents…
            </div>
            <div
              v-else-if="tocErrorMessage"
              class="text-sm text-(--error-color) p-2"
            >
              {{ tocErrorMessage }}
            </div>
            <div v-else-if="!flatToc.length" class="text-sm opacity-80 p-2">
              No table of contents found.
            </div>

            <button
              v-for="item in flatToc"
              :key="item.href"
              type="button"
              class="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-(--sub-color)/10"
              :class="{
                'bg-(--sub-color)/10 text-(--main-color)': isActiveTocHref(
                  item.href,
                ),
              }"
              :style="{ paddingLeft: `${8 + item.depth * 14}px` }"
              @click="goToTocHref(item.href)"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
      </div>

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
