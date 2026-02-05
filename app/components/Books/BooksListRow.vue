<script setup lang="ts">
defineOptions({ name: 'BooksListRow' });

type Book = {
  id: string;
  title: string;

  authors?: { id: string; name: string }[];
  authorNames?: string[];
  author?: string;

  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;
  seriesIndex?: number | null;

  coverImagePath?: string | null;
  updatedAt?: string | number | Date;
};

const props = withDefaults(
  defineProps<{
    book: Book;
    rowHeightPx: number;
    columnMinWidths?: { title: number; authors: number; series: number };
    layoutMinWidth?: number;
    selectable?: boolean;
    selected?: boolean;
  }>(),
  {
    selectable: false,
    selected: false,
    columnMinWidths: () => ({ title: 0, authors: 0, series: 0 }),
    layoutMinWidth: 0,
  },
);

const emit = defineEmits<{
  (e: 'toggle-select', bookId: string, meta?: { shiftKey?: boolean }): void;
}>();

const rowPaddingY = 6;
const rowPaddingX = 10;

const safeRowHeightPx = computed(() => {
  const raw = Number(props.rowHeightPx);
  if (!Number.isFinite(raw)) return 72;
  return Math.max(40, Math.round(raw));
});

const rowStyle = computed<Record<string, string>>(() => ({
  height: `${safeRowHeightPx.value}px`,
  padding: `${rowPaddingY}px ${rowPaddingX}px`,
}));

const coverHeightPx = computed(() =>
  Math.max(24, safeRowHeightPx.value - rowPaddingY * 2),
);

const coverWidthPx = computed(() =>
  Math.max(16, Math.round(coverHeightPx.value * (2 / 3))),
);

const coverStyle = computed<Record<string, string>>(() => ({
  width: `${coverWidthPx.value}px`,
  height: `${coverHeightPx.value}px`,
}));

const columnStyles = computed(() => {
  const widths = props.columnMinWidths ?? { title: 0, authors: 0, series: 0 };
  return {
    title: {
      flex: `2 1 ${widths.title}px`,
      minWidth: `${widths.title}px`,
    },
    authors: {
      flex: `1.5 1 ${widths.authors}px`,
      minWidth: `${widths.authors}px`,
    },
    series: {
      flex: `1 1 ${widths.series}px`,
      minWidth: `${widths.series}px`,
    },
  };
});

const rowLayoutStyle = computed<Record<string, string>>(() => ({
  minWidth: props.layoutMinWidth ? `${props.layoutMinWidth}px` : 'auto',
}));

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

const hasLinkedAuthors = computed(
  () => Array.isArray(props.book.authors) && props.book.authors.length > 0,
);

const seriesLabel = computed(() => {
  if (!props.book.series?.name) return '';
  if (props.book.seriesIndex) {
    return `${props.book.series.name} #${props.book.seriesIndex}`;
  }
  return props.book.series.name;
});

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

function onRowClick(e?: MouseEvent) {
  if (props.selectable) {
    emit('toggle-select', props.book.id, { shiftKey: e?.shiftKey });
    return;
  }
  navigateTo(`/books/${props.book.id}`);
}
</script>

<template>
  <div
    class="w-full border-b border-(--sub-color)/50 transition"
    :class="[
      props.selectable ? 'cursor-pointer hover:bg-(--sub-color)/10' : '',
      props.selected ? 'bg-(--sub-color)/15' : '',
    ]"
    :style="rowStyle"
  >
    <div class="flex items-center gap-4 w-full h-full min-w-0" :style="rowLayoutStyle">
      <div class="shrink-0 relative" :style="coverStyle">
        <BookCover
          :src="coverSrc"
          :alt="`Cover for ${props.book.title}`"
          :title="props.book.title"
          class="cursor-pointer h-full w-full"
          :context-menu-items="props.selectable ? [] : getContextMenuItems"
          @click.stop="onRowClick"
        />

        <div
          v-if="props.selectable"
          class="absolute top-1 right-1 w-5 h-5 rounded-full border flex items-center justify-center text-xs"
          :class="
            props.selected
              ? 'bg-(--main-color) border-(--main-color) text-(--bg-color)'
              : 'bg-(--bg-color)/80 border-(--sub-color) text-(--text-color)'
          "
        >
          <Icon :name="props.selected ? 'lucide:check' : ''" />
        </div>
      </div>

      <div :style="columnStyles.title" class="min-w-0 flex items-center">
        <HoverScrollText>
          <span
            class="text-sm sm:text-base hover:underline cursor-pointer"
            @click.stop="onRowClick"
          >
            {{ props.book.title }}
          </span>
        </HoverScrollText>
      </div>

      <div :style="columnStyles.authors" class="min-w-0 flex items-center">
        <HoverScrollText class="text-sm sm:text-base opacity-80">
          <span v-if="props.selectable" @click.stop="onRowClick">
            {{ authorLabel }}
          </span>
          <template v-else-if="hasLinkedAuthors">
            <span v-for="(a, index) in props.book.authors" :key="a.id">
              <span
                class="cursor-pointer hover:underline"
                @click.stop="navigateTo(`/authors/${a.id}`)"
              >
                {{ a.name }}
              </span>
              <span
                v-if="
                  props.book.authors && index < props.book.authors.length - 1
                "
                >,
              </span>
            </span>
          </template>
          <template v-else>
            <span>{{ authorLabel }}</span>
          </template>
        </HoverScrollText>
      </div>

      <div :style="columnStyles.series" class="min-w-0 flex items-center">
        <HoverScrollText class="text-sm sm:text-base opacity-70">
          <span v-if="props.selectable" @click.stop="onRowClick">
            {{ seriesLabel }}
          </span>
          <span
            v-else-if="props.book.series"
            class="cursor-pointer hover:underline"
            @click.stop="navigateTo(`/series/${props.book.series.id}`)"
          >
            {{ seriesLabel }}
          </span>
          <span v-else>{{ seriesLabel }}</span>
        </HoverScrollText>
      </div>
    </div>
  </div>
</template>
