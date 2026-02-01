<script setup lang="ts">
definePageMeta({
  auth: {
    only: 'user',
    redirectGuestTo: '/login',
  },
});

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

type Book = {
  id: string;
  title: string;
  coverImagePath?: string | null;
  updatedAt?: string | number | Date;

  // List API denormalized fields (best-effort)
  authors?: { id: string; name: string }[];
  authorNames?: string[];
  author?: string;

  publisher?: { id: string; name: string } | null;
  series?: { id: string; name: string } | null;
  seriesIndex?: number | null;

  description?: string | null;

  createdAt: string | number | Date;
};

type SeriesBooksResponse = {
  data?: {
    series?: { id: string; name: string } | null;
    books?: Book[];
  };
  success?: boolean;
  message?: string;
};

const route = useRoute();
const collectionsStore = useCollectionsStore();

const seriesParam = computed(() => String(route.params.id || '').trim());
const seriesId = computed(() => decodeURIComponent(seriesParam.value));

const loading = ref(false);
const errorMessage = ref<string | null>(null);

const seriesName = ref<string>('Series');
const books = ref<Book[]>([]);
// Sort books by seriesIndex
const sortedBooks = computed(() => {
  return [...books.value].sort(
    (a, b) => (a.seriesIndex ?? 999) - (b.seriesIndex ?? 999),
  );
});

const bookCount = computed(() => books.value.length);

function deriveSeriesNameFromBooks(list: Book[], id: string) {
  for (const b of list) {
    if (b.series?.id === id && b.series?.name) return b.series.name;
  }
  return 'Series';
}

function coverThumbUrl(
  coverImagePath: string,
  updatedAt?: string | number | Date,
) {
  // Stored as a relative `library/...` path (typically `.../thumb.webp`)
  // API expects: /api/media/covers/<path under library>
  const base = `/api/media/covers/${coverImagePath.replace(/^library\//, '')}`;
  if (!updatedAt) return base;
  const ts = new Date(updatedAt).getTime();
  if (Number.isNaN(ts)) return base;
  return `${base}?v=${encodeURIComponent(String(ts))}`;
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

async function refresh() {
  if (!seriesId.value) return;

  loading.value = true;
  errorMessage.value = null;

  try {
    const query: Record<string, string> = {};
    if (
      collectionsStore.activeSelection.kind === 'collection' &&
      collectionsStore.activeSelection.collectionId
    ) {
      query.collectionId = collectionsStore.activeSelection.collectionId;
    }

    const res = await $fetch<SeriesBooksResponse>(
      `/api/series/${encodeURIComponent(seriesId.value)}/books`,
      {
        method: 'GET',
        query,
      },
    );

    const list = res?.data?.books ?? [];

    // Endpoint already returns newest-first, but keep this deterministic in UI.
    list.sort((a, b) => {
      const aTime = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    books.value = list;

    // Prefer explicit series metadata returned by the API.
    if (res?.data?.series?.name) {
      seriesName.value = res.data.series.name;
    } else {
      seriesName.value = deriveSeriesNameFromBooks(list, seriesId.value);
    }

    useHead({
      title: `${seriesName.value} · Series`,
    });
  } catch (err) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to load series';
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

watch(seriesId, () => {
  refresh();
});

// Refresh when the active collection scope changes in the header
watch(
  () => collectionsStore.activeSelection,
  () => {
    refresh();
  },
  { deep: true },
);
</script>

<template>
  <div class="flex flex-col w-full h-full overflow-hidden">
    <AppHeader class="w-full" />

    <div class="px-2 shrink-0 border-b border-(--sub-color)">
      <ViewSelectorDropdown />
    </div>

    <div class="w-full h-full p-4 overflow-auto">
      <div class="flex items-center gap-2 mb-4 text-(--main-color)">
        <Icon
          v-tooltip="'Go back'"
          name="lucide:arrow-left"
          class="opacity-80 hover:opacity-100 cursor-pointer text-3xl"
          @click="$router.back()"
        />
        <div v-if="books.length > 0" class="flex flex-col">
          <div class="text-2xl sm:text-3xl font-serif truncate">
            {{ seriesName }}
          </div>
          <div class="text-sm sm:text-md opacity-70 italic text-(--sub-color)">
            {{ bookCount }} book{{ bookCount === 1 ? '' : 's' }}
          </div>
        </div>
      </div>

      <div v-if="loading" class="text-sm opacity-80">Loading...</div>

      <div v-else-if="errorMessage" class="text-sm text-red-600">
        {{ errorMessage }}
      </div>

      <div v-else-if="books.length === 0" class="text-sm opacity-80">
        No books found for this series in your accessible collections.
      </div>

      <div v-else class="flex flex-col gap-4">
        <div class="flex flex-col gap-3 flex-wrap">
          <div
            v-for="b in sortedBooks"
            :key="b.id"
            :book="b"
            class="grid grid-cols-[30px_auto_4fr] gap-4"
          >
            <div class="text-xl sm:text-2xl self-center text-(--sub-color)">
              {{ b.seriesIndex }}
            </div>
            <BookCover
              :src="coverThumbUrl(b.coverImagePath ?? '', b.updatedAt ?? undefined)"
              :alt="b.title"
              :title="b.title"
              class="cursor-pointer w-25! sm:w-40!"
              @click="navigateTo(`/books/${b.id}`)"
            />
            <div class="flex flex-col">
              <!-- Title -->
              <div
                class="text-xl sm:text-3xl leading-tight font-serif hover:underline cursor-pointer"
                @click="navigateTo(`/books/${b.id}`)"
              >
                {{ b.title }}
              </div>

              <!-- Authors -->
              <div class="text-md sm:text-lg font-light opacity-80 font-serif">
                <span v-for="(a, index) in b.authors" :key="a.id">
                  <span
                    class="cursor-pointer hover:underline"
                    @click="navigateTo(`/authors/${a.id}`)"
                  >
                    {{ a.name }}
                  </span>
                  <span v-if="b.authors && index < b.authors.length - 1"
                    >,
                  </span>
                </span>
              </div>

              <!-- Description -->
              <div
                v-if="b.description"
                class="min-w-0 font-light prose prose-sm max-w-none text-(--text-color) opacity-90"
              >
                <div class="relative">
                  <div class="line-clamp-3">
                    <ClientOnly>
                      <!-- eslint-disable-next-line vue/no-v-html -->
                      <div v-html="sanitizeDescriptionHtml(b.description)" />
                      <template #fallback>
                        <span>{{ b.description }}</span>
                      </template>
                    </ClientOnly>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
