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
    }
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load book';
    book.value = null;
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
        <NuxtLink
          v-tooltip="'Go back'"
          to="/"
          class="opacity-80 hover:opacity-100"
        >
          <icon name="lucide:arrow-left" class="scale-200 translate-x-1" />
        </NuxtLink>
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
              <icon name="lucide:pencil" class="scale-135" />
              Edit
            </NuxtLink>

            <button
              v-if="isAdmin"
              class="px-3 py-2 rounded-md border border-(--error-color) text-(--error-color) hover:bg-(--error-color)/90! text-sm gap-2! disabled:opacity-60 disabled:cursor-not-allowed"
              type="button"
              :disabled="deleting"
              @click="showDeleteConfirm = true"
            >
              <icon name="lucide:trash-2" class="scale-135" />
              Delete
            </button>
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

            <div
              v-if="(book.tags ?? []).length"
              class="flex flex-wrap gap-2 mt-3"
            >
              <div
                v-for="t in book.tags ?? []"
                :key="t.id"
                class="inline-flex items-center px-2 py-1 rounded-md border border-(--sub-color) hover:bg-(--sub-color)/10 text-xs"
              >
                {{ t.name }}
              </div>
            </div>
          </div>

          <div class="grid md:grid-cols-2 gap-2 text-sm">
            <div class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Publisher</div>
              <div class="min-w-0">
                {{ book.publisher?.name ?? '' }}
              </div>
            </div>

            <div v-if="book.published" class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Published</div>
              <div class="min-w-0">
                {{ book.published.substring(0, 10) }}
              </div>
            </div>

            <div v-if="book.language" class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Language</div>
              <div class="min-w-0">{{ book.language }}</div>
            </div>

            <div v-if="book.pages" class="grid grid-cols-[110px_1fr] gap-2">
              <div class="opacity-70">Pages</div>
              <div class="min-w-0">{{ book.pages }}</div>
            </div>

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

            <div
              v-if="book.files && book.files.length"
              class="grid grid-cols-[110px_1fr] gap-2"
            >
              <div class="opacity-70">Files</div>
              <div class="min-w-0 break-all opacity-80">
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
    </div>
  </div>
</template>
