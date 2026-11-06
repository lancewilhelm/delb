<script setup lang="ts">
import type { BookMoveSelection } from '~/utils/collectionActions';

const props = defineProps<{ open: boolean; selection: BookMoveSelection }>();
const emit = defineEmits<{ close: []; moved: [] }>();
const store = useCollectionsStore();
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const targetId = ref('');
const confirmed = ref(false);
const dialog=ref<HTMLElement|null>(null);
let previousFocus:HTMLElement|null=null;
function trapFocus(event:KeyboardEvent) {
  const controls=Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),input:not([disabled]),[tabindex="0"]') ?? []).filter((control)=>control.getClientRects().length);
  const first=controls[0],last=controls.at(-1);
  if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
  else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
}

const sources = ref<
  Array<{ bookId: string; collectionId: string; name: string; role: string }>
>([]);
const sourceIds = computed(
  () =>
    new Set(
      props.selection.kind === 'collection'
        ? [props.selection.collectionId]
        : sources.value.map((source) => source.collectionId),
    ),
);
const targets = computed(() =>
  store.collections.filter(
    (collection) =>
      (collection.role === 'owner' || collection.role === 'editor') &&
      !(sourceIds.value.size === 1 && sourceIds.value.has(collection.id)),
  ),
);
const editable = computed(() => {
  const selection = props.selection;
  return selection.kind === 'collection'
    ? store.collections.some(
        (collection) =>
          collection.id === selection.collectionId &&
          (collection.role === 'owner' || collection.role === 'editor'),
      )
    : sources.value.length > 0 &&
        sources.value.every(
          (source) => source.role === 'owner' || source.role === 'editor',
        );
});

watch(
  () => props.open,
  async (open) => {
    if (!open) {previousFocus?.focus();return;}
    previousFocus=document.activeElement instanceof HTMLElement?document.activeElement:null;
    error.value = '';
    targetId.value = '';
    confirmed.value = false;
    sources.value = [];
    loading.value = true;
    try {
      await store.fetchCollections();
      if (props.selection.kind === 'books') {
        const response = await $fetch<{
          data: { sources: typeof sources.value };
        }>('/api/books/collection-sources', {
          method: 'POST',
          body: { bookIds: props.selection.bookIds },
        });
        sources.value = response.data.sources;
      }
    } catch (cause) {
      error.value =
        cause instanceof Error
          ? cause.message
          : 'Unable to load the selected books';
    } finally {
      loading.value = false;
      await nextTick();dialog.value?.querySelector<HTMLElement>('select,button')?.focus();
    }
  },
);

async function move() {
  if (busy.value || !confirmed.value || !targetId.value || !editable.value)
    return;
  busy.value = true;
  error.value = '';
  try {
    if (props.selection.kind === 'collection')
      await $fetch(
        `/api/collections/${encodeURIComponent(props.selection.collectionId)}/books/bulk`,
        {
          method: 'POST',
          body: {
            allInCollection: true,
            excludedBookIds: props.selection.excludedBookIds,
            targetCollectionId: targetId.value,
            confirmed: true,
          },
        },
      );
    else
      await $fetch('/api/books/move', {
        method: 'POST',
        body: {
          bookIds: props.selection.bookIds,
          targetCollectionId: targetId.value,
          expectedSources: sources.value.map((source) => ({
            bookId: source.bookId,
            collectionId: source.collectionId,
          })),
          confirmed: true,
        },
      });
    emit('moved');
    emit('close');
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Unable to move books';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <ModalWindow :open="open" @close="!busy && emit('close')">
    <div ref="dialog" role="dialog" aria-modal="true" aria-labelledby="book-move-title" class="flex flex-col gap-3 sm:w-95 max-w-[90vw]" @keydown.tab="trapFocus">
      <div id="book-move-title" class="text-lg font-semibold">Move books</div>
      <p class="text-sm">
        Choose the one collection these books will belong to. Readers who only
        belong to a source collection will lose access. Reading history stays
        with each book.
      </p>
      <p v-if="loading" role="status">Loading collections…</p>
      <p v-else-if="!editable" class="text-sm">
        Owner or editor access to every source collection is required.
      </p>
      <label v-else class="flex flex-col gap-1 text-sm"
        >Destination collection
        <select
          v-model="targetId"
          :disabled="busy"
          class="border border-(--contrast-border-color) rounded p-2 bg-(--bg-color)"
        >
          <option value="" disabled>Choose a collection</option>
          <option
            v-for="collection in targets"
            :key="collection.id"
            :value="collection.id"
          >
            {{ collection.name }}
          </option>
        </select>
      </label>
      <p v-if="!loading && !targets.length" class="text-sm">
        Create another collection or ask an owner to grant editor access.
      </p>
      <label class="flex gap-2 items-start text-sm"
        ><input v-model="confirmed" type="checkbox" :disabled="busy" />I
        understand that moving changes who can access these books.</label
      >
      <p
        v-if="error"
        role="alert"
        class="text-sm text-(--contrast-error-color)"
      >
        {{ error }}
      </p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          :disabled="busy"
          class="px-3 py-2"
          @click="emit('close')"
        >
          Cancel
        </button>
        <button
          type="button"
          :disabled="busy || loading || !editable || !targetId || !confirmed"
          class="px-3 py-2 rounded bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-50"
          @click="move"
        >
          {{ busy ? 'Moving…' : 'Move books' }}
        </button>
      </div>
    </div>
  </ModalWindow>
</template>
