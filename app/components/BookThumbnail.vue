<script setup lang="ts">
import type { CoverMenuItem } from '~/utils/coverMenu';
import { readDownloadFilename } from '~/utils/downloadFilename';
import { buildBookCoverUrl } from '~/utils/covers';
import {
  defaultBookFields,
  type BookFieldPreference,
  type BookViewBook,
} from '~/utils/bookFields';
defineOptions({ name: 'BookThumbnail' });

const props = withDefaults(
  defineProps<{
    book: BookViewBook;
    fields?: BookFieldPreference[];
    measureMetadata?: boolean;
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
    fields: () => defaultBookFields(),
    measureMetadata: false,
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

const emit = defineEmits<{
  (e: 'status-change'): void;
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

const visibleFields = computed(() =>
  props.fields.filter((field) => field.visible),
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

      <div v-if="visibleFields.length" class="flex flex-col min-w-0">
        <BooksMetadataField
          v-for="field in visibleFields"
          :key="field.id"
          :book="book"
          :field="field.id"
          mode="grid"
          :measurement="measureMetadata"
          :selectable="selectable"
          @open="onOpenBook"
        />
      </div>
    </div>
  </div>
</template>
