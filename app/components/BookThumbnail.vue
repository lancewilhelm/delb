<script setup lang="ts">
defineOptions({ name: 'BookThumbnail' });

type BookThumb = {
  id: string;
  title: string;

  coverImagePath?: string | null;
  updatedAt?: string | number | Date;

  // Optional: used for subtitle display
  authors?: { id: string; name: string }[];
  authorNames?: string[];
  author?: string;

  // Optional: used by other views (not displayed by default)
  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;
  seriesIndex?: number | null;
};

const props = withDefaults(
  defineProps<{
    book: BookThumb;
    /** Show the author line (if present in `book`). Default: true */
    showAuthor?: boolean;
    /** Show the series line (if present in `book`). Default: true */
    showSeries?: boolean;
    /** Additional classes for the outer wrapper */
    class?: string;
    /** Lock the aspect ratio to 3:2 */
    lockAspectRatio?: boolean;

    /**
     * Selection mode (Phase 3):
     * - When true, clicks toggle selection instead of navigating.
     */
    selectable?: boolean;

    /** Whether this book is currently selected (only relevant when selectable=true). */
    selected?: boolean;
  }>(),
  {
    to: undefined,
    showAuthor: true,
    showSeries: true,
    class: '',
    lockAspectRatio: false,
    selectable: false,
    selected: false,
  },
);

const coverCacheKey = computed(() => {
  const raw = props.book.updatedAt;
  if (!raw) return null;
  const ts = new Date(raw).getTime();
  if (Number.isNaN(ts)) return null;
  return String(ts);
});

function withCoverCacheKey(url: string): string {
  const key = coverCacheKey.value;
  if (!key) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(key)}`;
}

const coverSrc = computed(() => {
  const p = props.book.coverImagePath;
  if (!p) return null;

  // Cover storage model:
  // - DB normally points to `.../thumb.webp` for list/grid usage
  // - Older data (or some imports) may point to a source cover like `.../cover.jpg` or `.../cover.source.jpg`
  // In those cases, prefer serving a sibling `thumb.webp` to keep list/grid views lightweight.
  const normalized = p.replace(/\\/g, '/');

  const base = normalized.replace(/^library\//, '');
  const lastSlash = base.lastIndexOf('/');
  const dir = lastSlash >= 0 ? base.slice(0, lastSlash) : '';
  const thumbRel = (dir ? `${dir}/` : '') + 'thumb.webp';

  const looksLikeSourceCover =
    /\/cover\.(jpe?g|png|webp|gif|svg)$/i.test(normalized) ||
    /\/cover\.source\.[^/]+$/i.test(normalized) ||
    /\/source\.[^/]+$/i.test(normalized);

  if (looksLikeSourceCover) {
    return withCoverCacheKey(`/api/media/covers/${thumbRel}`);
  }

  // API expects: /api/media/covers/<path under library>
  return withCoverCacheKey(`/api/media/covers/${base}`);
});

type BookFile = {
  id: string;
  format: string;
  relativePath: string;
};

type BookFilesResponse = {
  success: true;
  data: { files: BookFile[] };
};

type CoverMenuItemBase = {
  key: string;
  label?: string;
  disabled?: boolean;
};

type CoverMenuItem =
  | (CoverMenuItemBase & { to: string; onSelect?: never; children?: never })
  | (CoverMenuItemBase & {
      onSelect: () => void | Promise<void>;
      to?: never;
      children?: never;
    })
  | (CoverMenuItemBase & {
      label: string;
      children: CoverMenuItem[];
      to?: never;
      onSelect?: never;
    });

function getFileFormatLabel(file: BookFile) {
  const fmt = (file.format || '').trim().toLowerCase();
  if (fmt) return fmt.toUpperCase();

  const fromPath = (file.relativePath || '')
    .split('.')
    .pop()
    ?.trim()
    .toLowerCase();
  return (fromPath || 'FILE').toUpperCase();
}

function guessDownloadFilename(title: string, file?: BookFile | null) {
  const safeTitle = (title || 'book')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ');

  const ext = (file?.format || 'epub').trim().toLowerCase() || 'epub';
  return `${safeTitle}.${ext}`;
}

async function downloadBookFile(file?: BookFile | null) {
  const bookId = props.book.id;
  if (!bookId) return;

  const url = new URL(
    `/api/books/${encodeURIComponent(bookId)}/download`,
    window.location.origin,
  );
  if (file?.id) {
    url.searchParams.set('fileId', file.id);
  }

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

  const blob = await res.blob();

  const contentDisposition = res.headers.get('content-disposition') || '';
  const match =
    /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(
      contentDisposition,
    );
  const fromHeader = match?.[1] || match?.[2] || match?.[3];
  const filename =
    (fromHeader ? decodeURIComponent(fromHeader.trim()) : null) ||
    guessDownloadFilename(props.book.title, file ?? null);

  const blobUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

const fileCache = ref<BookFile[] | null>(null);
const fileCacheLoaded = ref(false);

async function getContextMenuItems(): Promise<CoverMenuItem[]> {
  const items: CoverMenuItem[] = [
    { key: 'view', label: 'View', to: `/books/${props.book.id}` },
  ];

  try {
    if (!fileCacheLoaded.value) {
      const res = await $fetch<BookFilesResponse>(
        `/api/books/${encodeURIComponent(props.book.id)}/files`,
      );
      fileCache.value = res?.data?.files ?? [];
      fileCacheLoaded.value = true;
    }

    const files = fileCache.value ?? [];
    if (!files.length) return items;

    if (files.length === 1) {
      items.push({
        key: 'download',
        label: 'Download',
        onSelect: async () => {
          try {
            await downloadBookFile(files[0] ?? null);
          } catch (e) {
            console.error(e);
          }
        },
      });
      return items;
    }

    const totals = new Map<string, number>();
    for (const f of files) {
      const key = getFileFormatLabel(f);
      totals.set(key, (totals.get(key) ?? 0) + 1);
    }

    const seen = new Map<string, number>();
    const choices = files.map((file) => {
      const label = getFileFormatLabel(file);
      const next = (seen.get(label) ?? 0) + 1;
      seen.set(label, next);

      const total = totals.get(label) ?? 1;
      const displayLabel = total > 1 ? `${label} (${next})` : label;

      return { file, label: displayLabel };
    });

    items.push({
      key: 'download',
      label: 'Download',
      children: choices.map((opt) => ({
        key: `download:${opt.file.id}`,
        label: opt.label,
        onSelect: async () => {
          try {
            await downloadBookFile(opt.file);
          } catch (e) {
            console.error(e);
          }
        },
      })),
    });
  } catch {
    // Hide download option on failure (or unauthorized), keep View.
  }

  return items;
}

const authorLabel = computed(() => {
  const b = props.book;

  if (Array.isArray(b.authors) && b.authors.length > 0) {
    return b.authors
      .map((a) => a.name)
      .filter(Boolean)
      .join(', ');
  }

  if (Array.isArray(b.authorNames) && b.authorNames.length > 0) {
    return b.authorNames.filter(Boolean).join(', ');
  }

  return b.author ?? '';
});

const emit = defineEmits<{
  /** Fired when in selection mode and the user toggles selection for this book. */
  (e: 'toggle-select', bookId: string, meta?: { shiftKey?: boolean }): void;
}>();

function onOpenBook(e?: MouseEvent) {
  if (props.selectable) {
    emit('toggle-select', props.book.id, { shiftKey: e?.shiftKey });
    return;
  }

  navigateTo(`/books/${props.book.id}`);
}

function onToggleSelect(e: MouseEvent) {
  emit('toggle-select', props.book.id, { shiftKey: e.shiftKey });
}

const userSettingsStore = useUserSettingsStore();

const showAnyMetadata = computed(
  () =>
    userSettingsStore.activeSettings.bookGrid.showTitle ||
    userSettingsStore.activeSettings.bookGrid.showAuthors ||
    userSettingsStore.activeSettings.bookGrid.showSeries,
);
</script>

<template>
  <div :class="['w-full', props.class]">
    <div class="flex flex-col gap-1">
      <div class="relative">
        <BookCover
          :src="coverSrc"
          :alt="`Cover for ${props.book.title}`"
          :title="props.book.title"
          class="cursor-pointer"
          :class="lockAspectRatio ? 'aspect-2/3' : ''"
          :context-menu-items="props.selectable ? [] : getContextMenuItems"
          @click="onOpenBook"
        />

        <!-- Selection overlay -->
        <div
          v-if="props.selectable"
          class="absolute inset-0 rounded-md pointer-events-none"
          :class="props.selected ? 'bg-(--sub-color)/25' : ''"
        />

        <!-- Selection toggle target -->
        <button
          v-if="props.selectable"
          type="button"
          class="absolute inset-0 rounded-md border border-transparent hover:border-(--sub-color)"
          :aria-pressed="props.selected ? 'true' : 'false'"
          :aria-label="props.selected ? 'Deselect book' : 'Select book'"
          @click.stop="onToggleSelect"
        >
          <span
            class="absolute top-2 right-2 w-6 h-6 rounded-full border flex items-center justify-center"
            :class="
              props.selected
                ? 'bg-(--main-color) border-(--main-color) text-(--bg-color)'
                : 'bg-(--bg-color)/80 border-(--sub-color) text-(--text-color)'
            "
          >
            <Icon :name="props.selected ? 'lucide:check' : ''" />
          </span>
        </button>
      </div>

      <div v-if="showAnyMetadata" class="flex flex-col">
        <!-- Title -->
        <HoverScrollText
          v-if="userSettingsStore.activeSettings.bookGrid.showTitle"
        >
          <span class="cursor-pointer hover:underline" @click="onOpenBook">
            {{ props.book.title }}
          </span>
        </HoverScrollText>

        <!-- Authors -->
        <HoverScrollText
          v-if="
            userSettingsStore.activeSettings.bookGrid.showAuthors && authorLabel
          "
          class="opacity-70 cursor-pointer"
        >
          <span v-if="props.selectable" @click="onOpenBook">
            {{ authorLabel }}
          </span>

          <template v-else>
            <span v-for="(a, index) in book.authors" :key="a.id">
              <span
                class="cursor-pointer hover:underline"
                @click="navigateTo(`/authors/${a.id}`)"
              >
                {{ a.name }}
              </span>
              <span v-if="book.authors && index < book.authors.length - 1"
                >,
              </span>
            </span>
          </template>
        </HoverScrollText>

        <!-- Series -->
        <HoverScrollText
          v-if="
            userSettingsStore.activeSettings.bookGrid.showSeries &&
            props.book.series
          "
          class="italic opacity-70 text-sm cursor-pointer"
        >
          <div
            class="flex gap-1 hover:underline"
            @click="navigateTo(`/series/${props.book.series.id}`)"
          >
            {{ props.book.series.name }}
            <span v-if="props.book.seriesIndex"
              >#{{ props.book.seriesIndex }}</span
            >
          </div>
        </HoverScrollText>
      </div>
    </div>
  </div>
</template>
