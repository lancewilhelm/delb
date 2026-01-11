<script setup lang="ts">
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

// Page metadata
useHead({
  title: 'Book',
});

type Book = {
  id: string;
  title: string;
  coverImagePath?: string | null;

  /**
   * Per-user rating for this book.
   * Stored as integer half-stars (1..10 => 0.5..5.0), or null if unset.
   */
  userRating?: number | null;

  // New schema: authors are related entities (many-to-many)
  authors?: { id: string; name: string }[];

  // New schema: tags are related entities (many-to-many)
  tags?: { id: string; name: string }[];

  // New schema: publisher is a related entity; API returns denormalized for now
  publisher?: { id: string; name: string } | null;

  // New schema: series is a related entity; API returns denormalized for now
  series?: { id: string; name: string; index?: number | null } | null;

  // New schema: identifiers (multiple possible types)
  identifiers?: { type: string; value: string }[];

  // New schema: files (multiple formats possible); API returns denormalized for now
  files?: { id: string; format: string; relativePath: string }[];

  // Extended metadata (best-effort; may be null/undefined)
  description?: string | null;
  published?: string | null;
  language?: string | null;
  pages?: number | null;

  createdAt: string | number | Date;
};

type BookGetResponse = {
  data?: {
    book?: Book;
    authors?: { id: string; name: string; position?: number | null }[];
    files?: {
      id: string;
      bookId: string;
      format: string;
      relativePath: string;
    }[];
  };
  success?: boolean;
  message?: string;
};

type CollectionRole = 'owner' | 'editor' | 'viewer';

type BookCollectionsRow = {
  id: string;
  name: string;
  ownerUserId: string;
  isPersonal: boolean;
  role: CollectionRole;
};

type BookCollectionsGetResponse = {
  success?: boolean;
  data?: {
    collections?: BookCollectionsRow[];
  };
  message?: string;
};

type PutBookCollectionsResponse = {
  success?: boolean;
  data?: {
    added?: string[];
    removed?: string[];
    forbidden?: string[];
    ignoredPersonalRemovals?: string[];
  };
  message?: string;
};

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

const route = useRoute();
const bookId = computed(() => String(route.params.id || ''));

const loading = ref(false);
const errorMessage = ref<string | null>(null);
const book = ref<Book | null>(null);

const { isAdmin } = useAuth();

const showDeleteConfirm = ref(false);
const deleting = ref(false);

const descriptionExpanded = ref(false);

// ------------------------------
// Collections (Phase 2: per-book management)
// ------------------------------
const collectionsStore = useCollectionsStore();

const collectionsLoading = ref(false);
const collectionsErrorMessage = ref<string | null>(null);

const collectionsManageOpen = ref(false);
const collectionsSaving = ref(false);
const collectionsSaveError = ref<string | null>(null);

const bookCollections = ref<BookCollectionsRow[]>([]);
const desiredCollectionIds = ref<string[]>([]);

const personalCollectionId = computed(() => {
  return collectionsStore.collections.find((c) => c.isPersonal)?.id ?? null;
});

const canEditCollectionsForBook = computed(() => {
  // Only show Manage if the user can edit at least one of the collections
  // the book is currently in (owner/editor).
  return bookCollections.value.some(
    (c) => c.role === 'owner' || c.role === 'editor',
  );
});

const editableCollections = computed(() => {
  // Collections the user can mutate (owner/editor).
  return (collectionsStore.collections ?? []).filter((c) =>
    collectionsStore.canEditCollection(c),
  );
});

const editableBookCollections = computed(() => {
  // Collections the book is already in, but only those the user can mutate (owner/editor).
  // NOTE: This list will *not* include the user's Personal collection unless the book is
  // actually in it already.
  return bookCollections.value.filter((c) => c.role !== 'viewer');
});

const addableEditableCollections = computed(() => {
  // Other editable collections the book is NOT currently in.
  // IMPORTANT: exclude Personal so we cannot implicitly "pull" a shared book into Personal.
  const inSet = new Set(bookCollections.value.map((c) => c.id));

  return editableCollections.value.filter((c) => {
    if (inSet.has(c.id)) return false;
    if (c.isPersonal) return false;
    return true;
  });
});

async function loadBookCollections() {
  if (!bookId.value) return;

  collectionsLoading.value = true;
  collectionsErrorMessage.value = null;

  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId.value)}/collections`,
      { method: 'GET' },
    );

    if (!res.ok) {
      throw new Error(`Failed to load book collections (${res.status})`);
    }

    const json = (await res
      .json()
      .catch(() => null)) as BookCollectionsGetResponse | null;

    bookCollections.value = json?.data?.collections ?? [];
    desiredCollectionIds.value = bookCollections.value.map((c) => c.id);
  } catch (err) {
    const e = err as FetchErrorLike;
    collectionsErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load book collections';
    bookCollections.value = [];
    desiredCollectionIds.value = [];
  } finally {
    collectionsLoading.value = false;
  }
}

function openCollectionsManager() {
  collectionsSaveError.value = null;
  collectionsManageOpen.value = true;

  // Initialize from server truth: only collections the book is already in.
  // (Do NOT force Personal into the selection.)
  desiredCollectionIds.value = bookCollections.value.map((c) => c.id);
}

function closeCollectionsManager() {
  collectionsManageOpen.value = false;
  collectionsSaveError.value = null;
}

function onToggleDesiredCollection(id: string) {
  // Toggling is used both for:
  // - removing from a collection the book is already in
  // - adding to another editable collection (non-personal) not currently in
  const pid = personalCollectionId.value;
  if (pid && id === pid) return; // cannot remove Personal (server also enforces)

  const set = new Set(desiredCollectionIds.value);
  if (set.has(id)) set.delete(id);
  else set.add(id);

  desiredCollectionIds.value = Array.from(set);
}

const collectionsDelta = computed(() => {
  const current = new Set(bookCollections.value.map((c) => c.id));
  const desired = new Set(desiredCollectionIds.value);

  const add = Array.from(desired).filter((id) => !current.has(id));
  const remove = Array.from(current).filter((id) => !desired.has(id));

  const pid = personalCollectionId.value;
  const removeFiltered = pid ? remove.filter((id) => id !== pid) : remove;

  return { add, remove: removeFiltered };
});

const collectionsDirty = computed(() => {
  return (
    collectionsDelta.value.add.length > 0 ||
    collectionsDelta.value.remove.length > 0
  );
});

async function saveCollections() {
  if (!bookId.value || collectionsSaving.value) return;

  // IMPORTANT:
  // Do NOT force-add Personal. The book may not belong to this user's Personal collection,
  // and we must not implicitly add it (prevents "pulling" the book into Personal).
  const delta = collectionsDelta.value;
  if (!delta.add.length && !delta.remove.length) {
    closeCollectionsManager();
    return;
  }

  collectionsSaving.value = true;
  collectionsSaveError.value = null;

  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId.value)}/collections`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          addCollectionIds: delta.add,
          removeCollectionIds: delta.remove,
        }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Failed to update collections (${res.status})`);
    }

    const json = (await res
      .json()
      .catch(() => null)) as PutBookCollectionsResponse | null;

    if (!json?.success) {
      throw new Error(json?.message || 'Failed to update collections');
    }

    // Partial success is fine: reload authoritative state.
    await loadBookCollections();
    closeCollectionsManager();
  } catch (err) {
    const e = err as FetchErrorLike;
    collectionsSaveError.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to update collections';
  } finally {
    collectionsSaving.value = false;
  }
}

// ------------------------------
// Rating (per-user, half-stars)
// ------------------------------
// Stored as integer half-stars (1..10). `null` means unset.
const ratingValue = ref<number | null>(null);
const ratingHoverValue = ref<number | null>(null);
const ratingSaving = ref(false);

const effectiveRatingValue = computed(() => {
  return ratingHoverValue.value ?? ratingValue.value;
});

function clampHalfStarInt(v: number) {
  if (!Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 1) return 1;
  if (n > 10) return 10;
  return n;
}

function ratingToStarsText(v: number | null) {
  if (!v) return 'No rating';
  const stars = v / 2;
  // Keep one decimal only when needed
  const s = Number.isInteger(stars) ? String(stars) : stars.toFixed(1);
  return `${s} / 5`;
}

function iconForStarIndex(starIndex: number, v: number | null) {
  // starIndex is 1..5, v is half-star int 1..10 or null
  // NOTE: Per your spec, if there is no rating we render all as "filled" in sub color.
  if (v == null) return 'typcn:star-full-outline';

  const threshold = starIndex * 2; // full star boundary in half-star units
  if (v >= threshold) return 'typcn:star-full-outline';
  if (v === threshold - 1) return 'typcn:star-half-outline';
  return 'typcn:star-outline';
}

function computeHalfStarValueFromPointer(
  e: MouseEvent,
  starIndex: number,
): number | null {
  const el = e.currentTarget as HTMLElement | null;
  if (!el) return null;

  const rect = el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const half = x < rect.width / 2 ? 1 : 2; // left=half, right=full
  return clampHalfStarInt(starIndex * 2 - (2 - half));
}

function onRatingMouseMove(e: MouseEvent, starIndex: number) {
  const v = computeHalfStarValueFromPointer(e, starIndex);
  if (v == null) return;
  ratingHoverValue.value = v;
}

function onRatingMouseLeave() {
  ratingHoverValue.value = null;
}

async function setRating(newRating: number | null) {
  if (!bookId.value || ratingSaving.value) return;

  ratingSaving.value = true;
  try {
    const res = await fetch(
      `/api/books/${encodeURIComponent(bookId.value)}/rating`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: newRating }),
      },
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Failed to save rating (${res.status}).`);
    }

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: { rating?: number | null };
    } | null;

    // Server returns half-star int or null
    const saved = (json?.data?.rating ?? null) as number | null;

    ratingValue.value = saved;
    if (book.value) book.value.userRating = saved;
  } finally {
    ratingSaving.value = false;
  }
}

async function onRatingClick(e: MouseEvent, starIndex: number) {
  const v = computeHalfStarValueFromPointer(e, starIndex);
  if (v == null) return;

  // Clicking the same value toggles it off (clear)
  const next = ratingValue.value === v ? null : v;
  await setRating(next);
}

function sanitizeDescriptionHtml(input: string): string {
  // Minimal, conservative sanitizer:
  // - remove <script> / <style> / iframes
  // - strip inline event handlers (onclick, onload, etc)
  // - disallow javascript: URLs / data: URLs
  // - allow a limited set of tags, unwrap others (keep text)
  //
  // If parsing fails, fall back to empty string.
  if (typeof window === 'undefined') {
    // During SSR we avoid DOM parsing (and also avoid rendering raw HTML server-side).
    return '';
  }

  try {
    const doc = document.implementation.createHTMLDocument('');
    const container = doc.createElement('div');
    container.innerHTML = input ?? '';

    // Remove dangerous elements entirely
    for (const el of Array.from(
      container.querySelectorAll('script,style,iframe,object,embed'),
    )) {
      el.remove();
    }

    // Allowed tags (basic book-description formatting)
    const allowedTags = new Set([
      'DIV',
      'P',
      'BR',
      'EM',
      'I',
      'STRONG',
      'B',
      'UL',
      'OL',
      'LI',
      'BLOCKQUOTE',
      'A',
      'SPAN',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'HR',
    ]);

    const walk = (node: Node) => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;

        // Remove event handlers + risky attributes
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          const value = attr.value;

          if (name.startsWith('on')) {
            el.removeAttribute(attr.name);
            continue;
          }

          if (name === 'href' || name === 'src') {
            const v = String(value || '')
              .trim()
              .toLowerCase();
            if (v.startsWith('javascript:') || v.startsWith('data:')) {
              el.removeAttribute(attr.name);
              continue;
            }
          }

          // Keep only a small set of harmless attributes
          if (name !== 'href' && name !== 'title' && name !== 'style') {
            el.removeAttribute(attr.name);
          }
        }

        // If tag not allowed, unwrap it (replace element with its children)
        if (!allowedTags.has(el.tagName)) {
          const parent = el.parentNode;
          if (parent) {
            while (el.firstChild) {
              parent.insertBefore(el.firstChild, el);
            }
            parent.removeChild(el);
            return;
          }
        }
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    };

    walk(container);

    return container.innerHTML;
  } catch {
    return '';
  }
}

const safeDescriptionHtml = computed(() => {
  const desc = book.value?.description;
  if (!desc) return '';
  return sanitizeDescriptionHtml(desc);
});

const coverThumbUrl = computed(() => {
  const b = book.value;
  if (!b?.coverImagePath) return null;

  // Stored as a relative `library/...` path (typically `.../thumb.webp`)
  // API expects: /api/media/covers/<path under library>
  return `/api/media/covers/${b.coverImagePath.replace(/^library\//, '')}`;
});

/**
 * Full-resolution cover URL.
 *
 * Use the dedicated API so the client does not need to guess file extensions.
 * This returns the TRUE original cover bytes stored on disk (or best-effort fallback).
 */
const coverSourceUrl = computed(() => {
  const id = bookId.value;
  if (!id) return null;
  return `/api/books/${encodeURIComponent(id)}/cover-source`;
});

const coverViewerOpen = ref(false);
const coverViewerSrc = ref<string | null>(null);

function openCoverViewer() {
  // Start optimistic: try the derived source URL; if it fails, we fall back to thumb in `onCoverViewerError`.
  coverViewerSrc.value = coverSourceUrl.value ?? coverThumbUrl.value;
  coverViewerOpen.value = Boolean(coverViewerSrc.value);
}

function closeCoverViewer() {
  coverViewerOpen.value = false;
  coverViewerSrc.value = null;
}

function onCoverViewerError() {
  // If the derived source wasn't available (wrong ext / missing file), fall back to thumb.
  if (coverViewerSrc.value !== coverThumbUrl.value) {
    coverViewerSrc.value = coverThumbUrl.value;
    return;
  }

  // If even thumb fails, close viewer.
  closeCoverViewer();
}

const downloadUrl = computed(() => {
  if (!bookId.value) return null;
  return `/api/books/${encodeURIComponent(bookId.value)}/download`;
});

const downloading = ref(false);

function guessDownloadFilename(b: Book) {
  const title = (b.title || 'book').trim();

  const preferred =
    b.files?.find((f) => (f.format || '').toLowerCase() === 'epub') ??
    b.files?.[0];

  const ext = (preferred?.format || 'epub').trim().toLowerCase() || 'epub';
  return `${title}.${ext}`;
}

async function downloadBook() {
  if (!book.value || !downloadUrl.value || downloading.value) return;

  downloading.value = true;

  try {
    const res = await fetch(downloadUrl.value, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Download failed (${res.status})`);
    }

    const blob = await res.blob();

    // Try to honor server-provided filename when available
    const contentDisposition = res.headers.get('content-disposition') || '';
    const match =
      /filename\*=UTF-8''([^;]+)|filename="([^"]+)"|filename=([^;]+)/i.exec(
        contentDisposition,
      );
    const fromHeader = match?.[1] || match?.[2] || match?.[3];
    const filename =
      (fromHeader ? decodeURIComponent(fromHeader.trim()) : null) ||
      guessDownloadFilename(book.value);

    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to download book';
  } finally {
    downloading.value = false;
  }
}

async function deleteBook() {
  if (!bookId.value || deleting.value) return;

  deleting.value = true;
  errorMessage.value = null;

  try {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId.value)}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      throw new Error(`Delete failed (${res.status})`);
    }

    showDeleteConfirm.value = false;
    await navigateTo('/');
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to delete book';
  } finally {
    deleting.value = false;
  }
}

async function loadBook() {
  if (!bookId.value) return;

  loading.value = true;
  errorMessage.value = null;

  try {
    const res = await fetch(`/api/books/${encodeURIComponent(bookId.value)}`, {
      method: 'GET',
    });

    if (!res.ok) {
      throw new Error(`Failed to load book (${res.status})`);
    }

    const json = (await res.json()) as BookGetResponse;

    book.value = json?.data?.book ?? null;

    // Initialize per-user rating state from API response
    ratingValue.value = book.value?.userRating ?? null;

    // Allow either nested `book.authors/files` or top-level `data.authors/files`
    if (book.value) {
      if (!book.value.authors && json?.data?.authors) {
        book.value.authors = json.data.authors.map((a) => ({
          id: a.id,
          name: a.name,
        }));
      }
      if (!book.value.files && json?.data?.files) {
        book.value.files = json.data.files.map((f) => ({
          id: f.id,
          format: f.format,
          relativePath: f.relativePath,
        }));
      }
    }

    if (!book.value) {
      errorMessage.value = 'Book not found';
    } else {
      useHead({ title: book.value.title });

      // Collections require the global list (for Personal detection + editable options)
      await collectionsStore.fetchCollections();
      await loadBookCollections();
    }
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load book';
    book.value = null;
    ratingValue.value = null;
    ratingHoverValue.value = null;

    // Reset collections state on failure
    bookCollections.value = [];
    desiredCollectionIds.value = [];
    collectionsErrorMessage.value = null;
    collectionsSaveError.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadBook();
});

watch(
  () => bookId.value,
  () => {
    loadBook();
  },
);
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="w-full h-full p-4 overflow-auto">
      <div class="flex items-center gap-2 mb-4 text-(--main-color)">
        <icon
          v-tooltip="'Go back'"
          class="opacity-80 hover:opacity-100 text-3xl"
          name="lucide:arrow-left"
          @click="navigateTo('/')"
        />
      </div>

      <div v-if="loading" class="text-sm opacity-80">Loading...</div>

      <div v-else-if="errorMessage" class="text-sm text-(--error-color)">
        {{ errorMessage }}
      </div>

      <div
        v-else-if="book"
        class="flex flex-col md:flex-row gap-3 sm:gap-6 items-start"
      >
        <!-- Cover (left) -->
        <div
          class="flex flex-col justify-center items-center w-full sm:w-80 shrink-0 self-center md:self-start"
        >
          <!-- Keep a consistent aspect ratio; cover itself is max 320px wide -->
          <BookCover
            :src="coverThumbUrl"
            :alt="`Cover for ${book.title}`"
            :title="book.title"
            class="cursor-pointer w-50! sm:w-full!"
            @click="openCoverViewer"
          />

          <!-- Simple modal viewer for full-resolution cover -->
          <div
            v-if="coverViewerOpen"
            class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
            @click.self="closeCoverViewer"
          >
            <div class="relative max-w-[95vw] max-h-[95vh]">
              <button
                type="button"
                class="absolute -top-3 -right-3 bg-(--bg-color) border border-(--sub-color) rounded-full w-9 h-9 flex items-center justify-center hover:bg-(--sub-color)/10"
                @click="closeCoverViewer"
              >
                <icon name="lucide:x" class="scale-135" />
              </button>

              <img
                v-if="coverViewerSrc"
                :src="coverViewerSrc"
                :alt="`Cover for ${book.title}`"
                class="block max-w-[95vw] max-h-[95vh] object-contain rounded-md"
                @error="onCoverViewerError"
              />
            </div>
          </div>

          <!-- Actions -->
          <div class="flex flex-wrap gap-1 pt-2">
            <button
              v-if="book.files && book.files.length > 0"
              class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
              type="button"
              :disabled="downloading"
              @click="downloadBook"
            >
              <icon
                :name="
                  downloading ? 'lucide:loader-circle' : 'lucide:book-down'
                "
                :class="[downloading ? 'animate-spin' : '', 'scale-135']"
              />
              {{ downloading ? 'Downloading...' : 'Download' }}
            </button>

            <NuxtLink
              v-if="isAdmin"
              class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm gap-2! inline-flex items-center"
              :to="`/books/${book.id}/edit`"
            >
              <icon name="lucide:pencil" class="text-lg" />
              Edit
            </NuxtLink>

            <button
              v-if="isAdmin"
              class="px-3 py-2 rounded-md border border-(--error-color) text-(--error-color) hover:bg-(--error-color)/90! text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
              type="button"
              :disabled="deleting"
              @click="showDeleteConfirm = true"
            >
              <icon name="lucide:trash-2" class="text-lg" />
              Delete
            </button>
          </div>
          <div
            class="grid grid-cols-[min-content_1fr] gap-4 mt-4 w-full items-center"
          >
            <div class="flex gap-2 items-center">
              <div class="font-semibold">Collections</div>
              <icon
                v-if="canEditCollectionsForBook"
                name="lucide:pencil"
                class="text-md cursor-pointer opacity-50 hover:opacity-80"
                @click="openCollectionsManager"
              />
            </div>

            <div v-if="collectionsLoading" class="text-sm opacity-70">
              Loading…
            </div>

            <div
              v-else-if="collectionsErrorMessage"
              class="text-sm text-(--error-color)"
            >
              {{ collectionsErrorMessage }}
            </div>

            <div v-else class="flex flex-wrap gap-2 items-center justify-end">
              <span
                v-for="c in bookCollections"
                :key="c.id"
                class="border border-(--sub-color) px-2 py-1 rounded-md text-xs"
              >
                {{ c.name }}
              </span>

              <span v-if="!bookCollections.length" class="text-sm opacity-70">
                No collections.
              </span>
            </div>
          </div>
        </div>

        <!-- Details (right) -->
        <div class="min-w-0 flex flex-col gap-4">
          <!-- Series -->
          <div class="min-w-0 space-y-1">
            <div
              v-if="book.series"
              class="font-serif italic text-lg opacity-80"
            >
              <span
                class="cursor-pointer hover:underline"
                @click="navigateTo(`/series/${book.series.id}`)"
                >{{ book.series.name }}</span
              >
              {{ book.series.index ? `#${book.series.index}` : '' }}
            </div>

            <!-- Title -->
            <div class="text-4xl leading-tight font-serif">
              {{ book.title }}
            </div>

            <!-- Authors -->
            <div class="text-xl font-light opacity-80 font-serif">
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
            </div>

            <!-- Description -->
            <div
              v-if="book.description"
              class="min-w-0 font-light prose prose-sm max-w-none text-(--text-color) opacity-90"
            >
              <div class="relative">
                <div
                  :class="[
                    descriptionExpanded ? '' : 'max-h-75 overflow-hidden',
                  ]"
                >
                  <ClientOnly>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div v-html="safeDescriptionHtml" />
                    <template #fallback>
                      <span>{{ book.description }}</span>
                    </template>
                  </ClientOnly>
                </div>

                <div
                  v-if="!descriptionExpanded"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-(--bg-color) to-transparent"
                />
              </div>

              <div
                class="mt-2 text-sm underline opacity-80 hover:opacity-100 cursor-pointer"
                @click="descriptionExpanded = !descriptionExpanded"
              >
                {{ descriptionExpanded ? 'Read less' : 'Read more...' }}
              </div>
            </div>

            <!-- Tags -->
            <div
              v-if="(book.tags ?? []).length"
              class="flex flex-wrap gap-2 mt-3"
            >
              <div
                v-for="t in book.tags ?? []"
                :key="t.id"
                class="inline-flex items-center px-2 py-1 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs cursor-pointer"
                @click="navigateTo(`/tags/${encodeURIComponent(t.id)}`)"
              >
                {{ t.name }}
              </div>
            </div>
          </div>

          <!-- Right lower details grid -->
          <div class="grid lg:grid-cols-2 gap-y-2 gap-x-6 text-sm">
            <!-- Publisher -->
            <div class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Publisher</div>
              <div class="min-w-0">
                {{ book.publisher?.name ?? '' }}
              </div>
            </div>

            <!-- Published Date -->
            <div v-if="book.published" class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Published</div>
              <div class="min-w-0">
                {{ book.published.substring(0, 10) }}
              </div>
            </div>

            <!-- Language -->
            <div v-if="book.language" class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Language</div>
              <div class="min-w-0">{{ book.language }}</div>
            </div>

            <!-- Pages -->
            <div v-if="book.pages" class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Pages</div>
              <div class="min-w-0">{{ book.pages }}</div>
            </div>

            <!-- Date Added to Library -->
            <div class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Added</div>
              <div class="min-w-0">
                {{
                  typeof book.createdAt === 'string' ||
                  typeof book.createdAt === 'number'
                    ? new Date(book.createdAt).toLocaleString()
                    : new Date(book.createdAt).toLocaleString()
                }}
              </div>
            </div>

            <!-- Book File Details -->
            <div
              v-if="book.files && book.files.length"
              class="grid grid-cols-[110px_1fr] gap-2"
            >
              <div class="opacity-70">Files</div>
              <div class="min-w-0 break-all">
                {{
                  book.files
                    .map((f) => {
                      const fmt = (f.format || '').toUpperCase();
                      const p = f.relativePath || '';
                      return fmt ? `${fmt}: ${p}` : p;
                    })
                    .filter(Boolean)
                    .join(' • ')
                }}
              </div>
            </div>

            <!-- Identifiers -->
            <div
              v-if="book.identifiers && book.identifiers.length"
              class="grid grid-cols-[110px_1fr] gap-2"
            >
              <div class="opacity-70">Identifiers</div>
              <div class="min-w-0 flex flex-wrap gap-2">
                <span
                  v-for="(id, index) in book.identifiers"
                  :key="index"
                  class="border border-(--sub-color) px-2 py-1 rounded-md"
                  ><span v-if="id.type && id.value"
                    ><span class="border-r border-(--sub-color) pr-1">
                      {{ id.type }}
                    </span>
                    <span class="pl-1">{{ id.value }}</span>
                  </span>
                </span>
              </div>
            </div>

            <!-- Rating -->
            <div class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70 mt-1">Rating</div>

              <div>
                <div class="flex gap-2 items-center">
                  <div
                    class="flex gap-0.125 select-none"
                    role="radiogroup"
                    aria-label="Your rating"
                    @mouseleave="onRatingMouseLeave"
                  >
                    <div
                      v-for="starIndex in 5"
                      :key="starIndex"
                      type="button"
                      class="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60 translate-y-0.5"
                      :disabled="ratingSaving"
                      :aria-label="`${starIndex} star`"
                      @mousemove="(e) => onRatingMouseMove(e, starIndex)"
                      @click="(e) => onRatingClick(e, starIndex)"
                    >
                      <Icon
                        :name="
                          iconForStarIndex(starIndex, effectiveRatingValue)
                        "
                        class="text-2xl"
                        :class="
                          effectiveRatingValue
                            ? 'text-(--main-color)'
                            : 'text-(--sub-color)'
                        "
                      />
                    </div>
                  </div>

                  <div class="text-xs opacity-70 whitespace-nowrap">
                    <span v-if="ratingSaving">Saving...</span>
                    <span v-else>{{ ratingToStarsText(ratingValue) }}</span>
                  </div>

                  <div
                    v-if="ratingValue != null"
                    type="button"
                    class="text-xs underline cursor-pointer opacity-70 hover:opacity-100 disabled:opacity-60 disabled:cursor-not-allowed"
                    :disabled="ratingSaving"
                    @click="() => setRating(null)"
                  >
                    Clear
                  </div>
                </div>
              </div>
            </div>
          </div>

          <ModalWindow
            :open="showDeleteConfirm"
            @close="() => (showDeleteConfirm = false)"
          >
            <div class="flex flex-col gap-4 w-90 max-w-full">
              <div class="text-lg font-semibold text-(--error-color)">
                Delete book?
              </div>

              <div class="text-sm opacity-80">
                This will permanently delete the database record and remove the
                file from the books folder. This action cannot be undone.
              </div>

              <div class="text-sm">
                <div class="opacity-70">Book</div>
                <div class="font-medium">{{ book.title }}</div>
                <div class="opacity-70">
                  {{
                    (book.authors ?? [])
                      .map((a) => a.name)
                      .filter(Boolean)
                      .join(', ')
                  }}
                </div>
              </div>

              <div class="flex gap-2 justify-end">
                <button
                  class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
                  type="button"
                  :disabled="deleting"
                  @click="showDeleteConfirm = false"
                >
                  Cancel
                </button>

                <button
                  class="px-3 py-2 rounded-md bg-(--error-color) text-(--bg-color) hover:opacity-90 text-sm disabled:opacity-60 disabled:cursor-not-allowed"
                  type="button"
                  :disabled="deleting"
                  @click="deleteBook"
                >
                  <span v-if="deleting">Deleting...</span>
                  <span v-else>Yes, delete</span>
                </button>
              </div>
            </div>
          </ModalWindow>
        </div>
      </div>

      <div v-else class="text-sm opacity-80">No book loaded.</div>

      <!-- Bottom of the Page -->
      <!-- Collections -->

      <!-- Manage collections modal -->
      <ModalWindow
        :open="collectionsManageOpen"
        @close="closeCollectionsManager"
      >
        <div class="flex flex-col gap-4 w-110 max-w-[90vw]">
          <div class="flex items-start justify-between gap-4">
            <div>
              <div class="text-lg font-semibold">Manage collections</div>
              <div class="text-sm opacity-80">
                Add or remove this book from collections you can edit.
              </div>
            </div>

            <Icon
              name="lucide:x"
              class="text-xl cursor-pointer opacity-80 hover:opacity-100"
              @click="closeCollectionsManager"
            />
          </div>

          <div v-if="collectionsSaveError" class="text-sm text-(--error-color)">
            {{ collectionsSaveError }}
          </div>

          <div class="border border-(--sub-color) rounded-lg p-3">
            <div class="text-sm font-semibold mb-2">
              Your editable collections
            </div>

            <div v-if="collectionsStore.loading" class="text-sm opacity-70">
              Loading…
            </div>

            <div
              v-else-if="!editableCollections.length"
              class="text-sm opacity-70"
            >
              You don’t have any editable collections.
            </div>

            <div v-else class="flex flex-col gap-4">
              <!-- Current memberships (editable) -->
              <div class="flex flex-col gap-2">
                <div class="text-sm font-semibold">In these collections</div>

                <label
                  v-for="c in editableBookCollections"
                  :key="c.id"
                  class="flex items-center justify-between gap-3 text-sm"
                >
                  <div class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      class="accent-(--main-color)"
                      :checked="desiredCollectionIds.includes(c.id)"
                      :disabled="c.isPersonal || collectionsSaving"
                      @change="onToggleDesiredCollection(c.id)"
                    />
                    <span>{{ c.name }}</span>
                    <span v-if="c.isPersonal" class="text-xs opacity-70">
                      (Personal)
                    </span>
                  </div>

                  <span class="text-xs opacity-70">{{ c.role }}</span>
                </label>

                <div class="text-xs opacity-70">
                  Personal cannot be removed.
                </div>
              </div>

              <!-- Add to other editable collections -->
              <div class="flex flex-col gap-2">
                <div class="text-sm font-semibold">
                  Add to another collection
                </div>

                <div
                  v-if="!addableEditableCollections.length"
                  class="text-sm opacity-70"
                >
                  No other editable collections available.
                </div>

                <label
                  v-for="c in addableEditableCollections"
                  :key="c.id"
                  class="flex items-center justify-between gap-3 text-sm"
                >
                  <div class="flex items-center gap-2">
                    <input
                      type="checkbox"
                      class="accent-(--main-color)"
                      :checked="desiredCollectionIds.includes(c.id)"
                      :disabled="collectionsSaving"
                      @change="onToggleDesiredCollection(c.id)"
                    />
                    <span>{{ c.name }}</span>
                  </div>

                  <span class="text-xs opacity-70">{{ c.role }}</span>
                </label>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-end gap-2">
            <button
              class="px-3 py-2 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-sm"
              type="button"
              :disabled="collectionsSaving"
              @click="closeCollectionsManager"
            >
              Cancel
            </button>

            <button
              class="px-3 py-2 rounded-md border border-(--main-color) hover:bg-(--main-color)/10 text-sm"
              type="button"
              :disabled="collectionsSaving || !collectionsDirty"
              @click="saveCollections"
            >
              <span v-if="collectionsSaving">Saving…</span>
              <span v-else>Save</span>
            </button>
          </div>
        </div>
      </ModalWindow>
    </div>
  </div>
</template>
