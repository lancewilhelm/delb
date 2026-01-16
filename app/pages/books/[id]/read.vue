<script setup lang="ts">
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
const bookAuthors = ref<string[]>([]);
const bookSeries = ref<string | null>(null);
const bookSeriesIndex = ref<number | null>(null);
const bookPublisher = ref<string | null>(null);
const bookPublished = ref<string | null>(null);
const bookLanguage = ref<string | null>(null);
const bookPages = ref<number | null>(null);
const currentProgress = ref<number | null>(null);
const saveErrorMessage = ref<string | null>(null);

const seriesLabel = computed(() => {
  if (!bookSeries.value) return null;
  if (bookSeriesIndex.value == null) return bookSeries.value;
  return `${bookSeries.value} #${bookSeriesIndex.value}`;
});

const _readerMetadata = computed(() => ({
  bookId: bookId.value || null,
  title: bookTitle.value,
  authors: bookAuthors.value,
  series: bookSeries.value,
  seriesIndex: bookSeriesIndex.value,
  seriesLabel: seriesLabel.value,
  publisher: bookPublisher.value,
  published: bookPublished.value,
  language: bookLanguage.value,
  pages: bookPages.value,
}));

const readerMetadataList = computed(() => {
  const authors = bookAuthors.value.length
    ? bookAuthors.value.join(', ')
    : null;

  return [
    { label: 'Authors', value: authors },
    { label: 'Series', value: seriesLabel.value },
    { label: 'Publisher', value: bookPublisher.value },
    { label: 'Published', value: bookPublished.value },
    { label: 'Language', value: bookLanguage.value },
    {
      label: 'Pages',
      value: bookPages.value != null ? String(bookPages.value) : null,
    },
  ].filter((item) => Boolean(item.value));
});

const debugEnabled = true;

function debugLog(message: string, details?: Record<string, unknown>) {
  if (!debugEnabled) return;
  if (details) {
    console.debug(`[Reader] ${message}`, details);
  } else {
    console.debug(`[Reader] ${message}`);
  }
}

type EpubModule = typeof import('epubjs');
type EpubFn = EpubModule['default'];
type EpubBook = ReturnType<EpubFn>;
type EpubRendition = ReturnType<EpubBook['renderTo']>;

let bookInstance: EpubBook | null = null;
const renditionRef = ref<EpubRendition | null>(null);
let saveTimeout: ReturnType<typeof setTimeout> | null = null;
let lastSavedLocation: string | null = null;

function backToDetails() {
  if (!bookId.value) return;
  navigateTo(`/books/${bookId.value}`);
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

function applyReaderTheme() {
  const rendition = renditionRef.value;
  if (!rendition || typeof window === 'undefined') return;

  const rootStyles = getComputedStyle(document.documentElement);
  const bg = rootStyles.getPropertyValue('--bg-color').trim();
  const text = rootStyles.getPropertyValue('--text-color').trim();
  const main = rootStyles.getPropertyValue('--main-color').trim();
  const sub = rootStyles.getPropertyValue('--sub-color').trim();

  rendition.themes.register('delb', {
    html: {
      background: 'var(--bg-color)',
    },
    body: {
      background: 'var(--bg-color)',
      color: 'var(--text-color)',
      lineHeight: '1.6',
    },
    a: {
      color: 'var(--main-color)',
    },
  });

  rendition.themes.select('delb');

  if (bg) rendition.themes.override('--bg-color', bg);
  if (text) rendition.themes.override('--text-color', text);
  if (main) rendition.themes.override('--main-color', main);
  if (sub) rendition.themes.override('--sub-color', sub);
}

function stripScriptedContent(doc?: Document | null) {
  if (!doc) return { scripts: 0, handlers: 0 };

  const scripts = doc.querySelectorAll('script');
  let handlerCount = 0;

  scripts.forEach((script) => script.remove());

  doc.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) {
        el.removeAttribute(attr.name);
        handlerCount += 1;
      }
    }
  });

  return { scripts: scripts.length, handlers: handlerCount };
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
    const authors = (book?.authors ?? [])
      .map((author) => (typeof author === 'string' ? author : author?.name))
      .filter(Boolean) as string[];

    bookTitle.value = title || bookTitle.value;
    bookAuthors.value = authors;
    bookPublisher.value = book?.publisher?.name ?? null;
    bookSeries.value = book?.series?.name ?? null;
    bookSeriesIndex.value = book?.series?.index ?? null;
    bookPublished.value = book?.published ?? null;
    bookLanguage.value = book?.language ?? null;
    bookPages.value = book?.pages ?? null;

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

    debugLog('Container check before renderTo', {
      hasContainer: Boolean(readerContainer.value),
      containerTag: readerContainer.value?.tagName ?? null,
      containerSize: readerContainer.value
        ? {
            width: readerContainer.value.clientWidth,
            height: readerContainer.value.clientHeight,
          }
        : null,
    });

    if (!readerContainer.value) {
      throw new Error('Reader container not ready.');
    }

    renditionRef.value = bookInstance.renderTo(readerContainer.value, {
      width: '100%',
      height: '100%',
      spread: 'none',
      allowScriptedContent: false,
    });
    const rendition = renditionRef.value;

    if (!rendition) {
      throw new Error('Reader not initialized.');
    }

    const hookApi = rendition as unknown as {
      hooks?: {
        content?: {
          register?: (fn: (contents: { document: Document }) => void) => void;
        };
      };
    };

    hookApi?.hooks?.content?.register?.((contents) => {
      const stripped = stripScriptedContent(contents.document);
      if (stripped.scripts || stripped.handlers) {
        debugLog('Stripped scripted content (rendition)', stripped);
      }
    });

    const spineHookApi = bookInstance as unknown as {
      spine?: {
        hooks?: {
          content?: {
            register?: (fn: (contents: { document: Document }) => void) => void;
          };
        };
      };
    };

    spineHookApi?.spine?.hooks?.content?.register?.((contents) => {
      const stripped = stripScriptedContent(contents.document);
      if (stripped.scripts || stripped.handlers) {
        debugLog('Stripped scripted content (spine)', stripped);
      }
    });

    applyReaderTheme();

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
        debugLog('Generating locations', { chars: 400 });
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
    backToDetails();
  }
}

onMounted(async () => {
  debugLog('Mounted', { bookId: bookId.value });
  await loadBookTitle();
  await nextTick();
  debugLog('After nextTick', {
    hasContainer: Boolean(readerContainer.value),
    containerTag: readerContainer.value?.tagName ?? null,
  });
  await loadEpub();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  if (saveTimeout) clearTimeout(saveTimeout);
  renditionRef.value?.destroy();
  bookInstance?.destroy();
});
</script>

<template>
  <div
    class="flex flex-col w-screen h-screen bg-(--bg-color) text-(--text-color)"
  >
    <div
      class="flex items-center justify-between px-4 py-3 border-b border-(--sub-color) bg-(--bg-color)"
    >
      <div class="flex items-center gap-3 min-w-0">
        <button
          type="button"
          class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm inline-flex items-center gap-2"
          @click="backToDetails"
        >
          <Icon name="lucide:arrow-left" class="text-lg" />
          Back
        </button>

        <div class="min-w-0">
          <div class="text-lg font-semibold truncate">{{ bookTitle }}</div>
          <div class="text-sm text-(--sub-color) truncate">
            {{ bookAuthors.join(', ') }}
          </div>
        </div>
      </div>

      <div class="flex items-center gap-3 text-sm opacity-80">
        <span>Progress</span>
        <span class="font-medium">{{ formatProgress(currentProgress) }}</span>
        <span v-if="saveErrorMessage" class="text-(--error-color) text-xs">
          {{ saveErrorMessage }}
        </span>
      </div>
    </div>

    <div
      v-if="readerMetadataList.length"
      class="px-4 py-2 border-b border-(--sub-color) bg-(--bg-color)"
    >
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span
          v-for="item in readerMetadataList"
          :key="item.label"
          class="inline-flex items-center gap-1 text-(--sub-color)"
        >
          <span class="opacity-70">{{ item.label }}:</span>
          <span class="text-(--text-color)">{{ item.value }}</span>
        </span>
      </div>
    </div>

    <div class="relative flex-1">
      <div ref="readerContainer" class="w-full h-full" />

      <div
        v-if="loading"
        class="absolute inset-0 flex items-center justify-center"
      >
        <div class="text-sm opacity-80">Loading reader…</div>
      </div>

      <div
        v-else-if="errorMessage"
        class="absolute inset-0 flex items-center justify-center"
      >
        <div class="text-sm text-(--error-color)">{{ errorMessage }}</div>
      </div>
    </div>

    <div
      class="flex items-center justify-center gap-3 px-4 py-3 border-t border-(--sub-color) bg-(--bg-color)"
    >
      <button
        type="button"
        class="px-4 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
        @click="goPrev"
      >
        Previous
      </button>
      <button
        type="button"
        class="px-4 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
        @click="goNext"
      >
        Next
      </button>
    </div>
  </div>
</template>
