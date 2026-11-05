<script setup lang="ts">
import type { CoverMenuItem } from '~/utils/coverMenu';
import { readDownloadFilename } from '~/utils/downloadFilename';
import { buildBookCoverUrl } from '~/utils/covers';
import {
  bookColumnStyle,
  type BookFieldPreference,
  type BookViewBook,
} from '~/utils/bookFields';
defineOptions({ name: 'BooksListRow' });

const props = withDefaults(
  defineProps<{
    book: BookViewBook;
    fields: BookFieldPreference[];
    rowHeightPx: number;
    layoutMinWidth?: number;
    selectable?: boolean;
    selected?: boolean;
  }>(),
  {
    selectable: false,
    selected: false,
    layoutMinWidth: 0,
  },
);

const emit = defineEmits<{
  (e: 'status-change'): void;
  (e: 'toggle-select', bookId: string, meta?: { shiftKey?: boolean }): void;
  (e: 'measure', bookId: string, height: number): void;
}>();

const rowPaddingY = 6;
const rowPaddingX = 10;

const safeRowHeightPx = computed(() => {
  const raw = Number(props.rowHeightPx);
  if (!Number.isFinite(raw)) return 72;
  return Math.max(40, Math.round(raw));
});

const rowStyle = computed<Record<string, string>>(() => ({
  minHeight: `${safeRowHeightPx.value}px`,
  minWidth: props.layoutMinWidth ? `${props.layoutMinWidth}px` : 'auto',
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

const rowRef = ref<HTMLElement | null>(null);
useResizeObserver(rowRef, () => {
  const height = rowRef.value?.getBoundingClientRect().height;
  if (height) emit('measure', props.book.id, height);
});
const visibleFields = computed(() =>
  props.fields.filter((field) => field.visible),
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
  if (!props.book.id || !props.book.coverImagePath) return null;
  return withCoverCacheKey(
    buildBookCoverUrl({
      bookId: props.book.id,
      variant: 'thumb',
    }),
  );
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
  const filename =
    readDownloadFilename(contentDisposition) ||
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

const { getReadingStatusMenuItem } = useBookReadingStatusMenu({
  bookId: () => props.book.id,
  onChanged: () => emit('status-change'),
});

async function getContextMenuItems(): Promise<CoverMenuItem[]> {
  const items: CoverMenuItem[] = [
    { key: 'view', label: 'View', to: `/books/${props.book.id}` },
    await getReadingStatusMenuItem(),
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
    ref="rowRef"
    class="w-full border-b border-(--contrast-border-color)/50 transition"
    :class="[
      props.selectable ? 'cursor-pointer hover:bg-(--sub-color)/10' : '',
      props.selected ? 'bg-(--sub-color)/15' : '',
    ]"
    :style="rowStyle"
  >
    <div class="flex items-center gap-4 w-full min-w-0">
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
              ? 'bg-(--main-color) border-(--main-color) text-(--contrast-inverse-color)'
              : 'bg-(--bg-color)/80 border-(--contrast-border-color) text-(--contrast-text-color)'
          "
        >
          <Icon :name="props.selected ? 'lucide:check' : ''" />
        </div>
      </div>

      <div
        v-for="field in visibleFields"
        :key="field.id"
        :style="bookColumnStyle(field.id)"
        class="min-w-0"
      >
        <BooksMetadataField
          :book="book"
          :field="field.id"
          mode="list"
          :selectable="selectable"
          @open="onRowClick"
        />
      </div>
    </div>
  </div>
</template>
