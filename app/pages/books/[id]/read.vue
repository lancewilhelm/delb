<script setup lang="ts">
import type Book from 'epubjs/types/book';
import type Rendition from 'epubjs/types/rendition';

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
const settingsButtonRef = ref<HTMLElement | null>(null);
const readerFontSize = userSettingsStore.settingRef<number>('reader.fontSize');
const readerLineHeight =
  userSettingsStore.settingRef<number>('reader.lineHeight');
const readerTheme = userSettingsStore.settingRef<'light' | 'dark' | 'app'>(
  'reader.theme',
);
const readerDisplayMode = userSettingsStore.settingRef<'scroll' | 'pages'>(
  'reader.displayMode',
);
const themesRegistered = ref(false);

const router = useRouter();
function backToBook() {
  router.replace(`/books/${encodeURIComponent(bookId.value)}`);
}

function toggleSettings() {
  isSettingsOpen.value = !isSettingsOpen.value;
}

function handleDocumentClick(event: MouseEvent) {
  if (!isSettingsOpen.value) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (settingsMenuRef.value?.contains(target)) return;
  if (settingsButtonRef.value?.contains(target)) return;
  isSettingsOpen.value = false;
}

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
    await saveReadingPosition(location, progress);
  }, 1500);
}

function goPrev() {
  renditionRef.value?.prev();
}

function goNext() {
  renditionRef.value?.next();
}

function applyReaderSettings() {
  const rendition = renditionRef.value;
  if (!rendition || typeof window === 'undefined') return;

  // Grab theme colors from the DOM
  const rootStyles = getComputedStyle(document.documentElement);
  const delbBg = rootStyles.getPropertyValue('--bg-color').trim();
  const delbText = rootStyles.getPropertyValue('--text-color').trim();
  const delbMain = rootStyles.getPropertyValue('--main-color').trim();

  // Register a base theme
  if (!themesRegistered.value) {
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

  // Set the themes
  const themeTokens =
    readerTheme.value === 'light'
      ? { bg: '#ffffff', text: '#111111', link: '#2563eb' }
      : readerTheme.value === 'dark'
        ? { bg: '#1b1b1b', text: '#dddddd', link: '#93c5fd' }
        : { bg: delbBg, text: delbText, link: delbMain };

  // Override the base theme with the theme tokens
  rendition.themes.select('reader-base');
  rendition.themes.override('--reader-bg', themeTokens.bg);
  rendition.themes.override('--reader-text', themeTokens.text);
  rendition.themes.override('--reader-link', themeTokens.link);

  // Handle font size and line height
  const fontSize = readerFontSize.value ?? 100;
  const lineHeight = readerLineHeight.value ?? 120;
  rendition.themes.fontSize(`${fontSize}%`);
  rendition.themes.override('--reader-line-height', `${lineHeight}%`);

  // Handle display mode
  // if (readerDisplayMode.value === 'pages') {
  //   renditionRef.value?.flow('paginated');
  // } else if (readerDisplayMode.value === 'scroll') {
  //   renditionRef.value?.requireManager('continuous');
  //   renditionRef.value?.flow('scrolled');
  // }
}

function getThemeClass(hover?: boolean) {
  const theme = readerTheme.value ?? 'app';
  if (theme === 'app') {
    const base = '';
    return hover ? base + ' hover:bg-(--sub-color)/5' : base;
  } else if (theme === 'dark') {
    const base = 'bg-[#1b1b1b] text-[#ddd]';
    return hover ? base + ' hover:bg-[#222]' : base;
  } else if (theme === 'light') {
    const base = 'bg-[#fff] text-[#111]';
    return hover ? base + ' hover:bg-[#eee]' : base;
  }
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

async function saveReadingPosition(location: string, progress: number | null) {
  if (!bookId.value) return;

  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId.value)}/reading-position`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, progress }),
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

async function loadEpub() {
  if (!bookId.value) {
    errorMessage.value = 'Missing book id';
    return;
  }

  loading.value = true;
  errorMessage.value = null;

  try {
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
    await bookInstance.ready;

    if (!readerContainer.value) {
      throw new Error('Reader container not ready.');
    }

    renditionRef.value = bookInstance.renderTo(readerContainer.value, {
      width: '100%',
      height: '100%',
      minSpreadWidth: 900,
      allowScriptedContent: true,
    });
    const rendition = renditionRef.value;

    if (!rendition) {
      throw new Error('Reader not initialized.');
    }

    applyReaderSettings();

    const saved = await loadReadingPosition();
    const savedLocation = saved?.location ?? null;
    const shouldGenerateLocations = saved?.progress == null;

    if (savedLocation) {
      await rendition.display(savedLocation);
      currentProgress.value = saved?.progress ?? extractProgress(savedLocation);
    } else {
      await rendition.display();
    }

    if (shouldGenerateLocations) {
      setTimeout(() => {
        bookInstance?.locations
          .generate(400)
          .then(() => {
            if (savedLocation && currentProgress.value == null) {
              const progress = extractProgress(savedLocation);
              if (progress != null) {
                currentProgress.value = progress;
              }
            }
          })
          .catch(() => null);
      }, 0);
    }

    rendition.on('relocated', (loc: { start?: { cfi?: string } }) => {
      const cfi = loc?.start?.cfi ?? null;
      const progress = extractProgress(cfi);
      currentProgress.value = progress;
      scheduleSave(cfi, progress);
    });

    rendition.on('click', onRenditionClick);
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
  document.addEventListener('click', handleDocumentClick);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('click', handleDocumentClick);
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

watch(
  [readerFontSize, readerLineHeight, readerTheme, readerDisplayMode],
  () => {
    applyReaderSettings();
  },
);
</script>

<template>
  <div class="flex flex-col h-full w-full overflow-hidden">
    <!-- Page header -->
    <div
      v-if="!isFullscreen"
      class="relative z-30 flex items-center justify-between p-2 border-b border-t border-(--sub-color) bg-(--sub-alt-color)"
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
          <icon
            ref="settingsButtonRef"
            v-tooltip="'Reader settings'"
            name="lucide:settings-2"
            class="text-2xl opacity-80 hover:opacity-100 cursor-pointer"
            @click.stop="toggleSettings"
          />

          <!-- Settings menu -->
          <div
            v-if="isSettingsOpen"
            ref="settingsMenuRef"
            class="absolute right-0 mt-2 w-72 rounded-md border border-(--sub-color) bg-(--bg-color) p-3 shadow-lg z-50"
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
                <div class="grid grid-cols-3 gap-2">
                  <label class="cursor-pointer">
                    <input
                      v-model="readerTheme"
                      type="radio"
                      value="light"
                      class="sr-only peer"
                    />
                    <span
                      class="block rounded-md px-2 py-1 text-center text-xs font-medium bg-white text-[#111] peer-checked:bg-(--main-color) peer-checked:text-(--bg-color)"
                    >
                      Light
                    </span>
                  </label>
                  <label class="cursor-pointer">
                    <input
                      v-model="readerTheme"
                      type="radio"
                      value="dark"
                      class="sr-only peer"
                    />
                    <span
                      class="block rounded-md px-2 py-1 text-center text-xs font-medium bg-[#1b1b1b] text-[#ddd] peer-checked:bg-(--main-color) peer-checked:text-(--bg-color)"
                    >
                      Dark
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
                      class="block rounded-md px-2 py-1 text-center text-xs font-medium bg-(--sub-alt-color) text-(--text-color) peer-checked:bg-(--main-color) peer-checked:text-(--bg-color)"
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
      class="relative flex h-full w-full overflow-hidden"
      @click="handleContentTap"
    >
      <!-- Previous page button -->
      <div
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
        class="flex items-center p-2 hover:bg-(--sub-color)/5 cursor-pointer shrink-0"
        :class="getThemeClass(true)"
        @click.stop="goNext"
      >
        <icon name="lucide:arrow-right" class="text-2xl opacity-80" />
      </div>

      <!-- Full screen toggle -->
      <div class="absolute right-0 top-0 h-40 w-40 group">
        <icon
          :name="
            isFullscreen
              ? 'mingcute:fullscreen-exit-2-fill'
              : 'mingcute:fullscreen-2-fill'
          "
          class="absolute right-4 top-4 text-3xl cursor-pointer transition-opacity"
          :class="
            isMobileDevice
              ? fullscreenVisible
                ? 'opacity-80 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
              : 'opacity-0 pointer-events-none group-hover:opacity-80 group-hover:pointer-events-auto'
          "
          @click.stop="toggleFullscreen"
        />
      </div>
    </div>
  </div>
</template>
