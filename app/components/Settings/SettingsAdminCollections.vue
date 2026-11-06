<script setup lang="ts">
import EditCollectionModal from '~/components/Collections/EditCollectionModal.vue';
import type { Collection } from '~/stores/collections';
import type { previewCollectionMigration } from '~~/server/utils/collections/migration';

type Preview = Awaited<ReturnType<typeof previewCollectionMigration>>;
type AdminCollection = Collection & { ownerEmail: string; bookCount: number };
const preview = ref<Preview | null>(null);
const collections = ref<AdminCollection[]>([]);
const choices = ref<Record<string, string>>({});
const backupConfirmed = ref(false);
const dropboxTargetId = ref<string | null>(null);
const busy = ref(false);
const loading = ref(false);
const error = ref('');
const status = ref('');
const editing = ref<AdminCollection | null>(null);
const store = useCollectionsStore();
const ready = computed(
  () =>
    preview.value &&
    backupConfirmed.value &&
    (!preview.value.dropboxTargets.needsChoice ||
      dropboxTargetId.value !== null) &&
    !preview.value.blockers.length &&
    preview.value.splits.every((split) => choices.value[split.bookId]),
);

async function refresh() {
  loading.value = true;
  try {
    const response = await $fetch<{ data: Preview }>(
      '/api/settings/admin/collections-migration',
    );
    preview.value = response.data;
    for (const choice of response.data.retainedChoices)
      choices.value[choice.bookId] = choice.collectionId;
    if (response.data.retainedDropboxTargetId !== null)
      dropboxTargetId.value = response.data.retainedDropboxTargetId;
    if (response.data.state === 'exclusive')
      collections.value = (
        await $fetch<{ data: { collections: AdminCollection[] } }>(
          '/api/settings/admin/collections',
        )
      ).data.collections;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Unable to load collections';
  } finally {
    loading.value = false;
  }
}
onMounted(refresh);

async function applyMigration() {
  if (!ready.value || !preview.value || busy.value) return;
  busy.value = true;
  error.value = '';
  status.value = '';
  try {
    await $fetch('/api/settings/admin/collections-migration', {
      method: 'POST',
      body: {
        fingerprint: preview.value.fingerprint,
        choices: preview.value.splits.map((split) => ({
          bookId: split.bookId,
          collectionId: choices.value[split.bookId],
        })),
        backupConfirmed: true,
        ...(dropboxTargetId.value !== null
          ? { dropboxTargetId: dropboxTargetId.value }
          : {}),
      },
    });
    status.value = 'Collection migration complete.';
    await store.fetchCollections();
  } catch (cause) {
    error.value =
      cause instanceof Error
        ? cause.message
        : 'Migration could not complete. The retained plan can be resumed.';
  } finally {
    busy.value = false;
    await refresh();
  }
}
async function makeDefault(collection: AdminCollection) {
  busy.value = true;
  error.value = '';
  status.value = '';
  try {
    await $fetch('/api/settings/admin/collections/default', {
      method: 'PUT',
      body: { collectionId: collection.id },
    });
    await store.fetchCollections();
    await refresh();
    status.value = `${collection.name} is now the default. Existing books and memberships were kept.`;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : 'Unable to change the default';
  } finally {
    busy.value = false;
  }
}
async function closeSettings() {
  editing.value = null;
  await refresh();
  await store.fetchCollections();
}
</script>

<template>
  <div class="flex flex-col gap-4 p-4">
    <div class="text-lg font-semibold">Collections</div>
    <p v-if="error" role="alert" class="text-sm text-(--contrast-error-color)">
      {{ error }}
    </p>
    <p v-if="status" role="status" class="text-sm">{{ status }}</p>
    <p v-if="loading && !preview" role="status">Loading collections…</p>
    <template v-if="preview && preview.state !== 'exclusive'">
      <div
        class="border border-(--contrast-border-color) rounded p-4 flex flex-col gap-3"
      >
        <div class="font-semibold">Collection migration required</div>
        <p class="text-sm">
          The library is paused while legacy collections are migrated. Back up
          the database and managed library together before applying this plan.
        </p>
        <p class="text-sm">
          {{ preview.privateCollections }} Personal collections become ordinary
          private collections. {{ preview.users }} existing users join a new
          shared Default as editors. {{ preview.splits.length }} shared books
          split into independent entries. {{ preview.recoveredBooks }} books
          enter a private Recovered books collection.
        </p>
        <p class="text-sm">
          Reading history is preserved. Copies of queued books stay adjacent.
          The selected entry keeps the original book ID and any Calibre
          relationship; other copies remain independent.
        </p>
        <p v-if="preview.state === 'migrating'" class="text-sm">
          A retained migration plan is available. Resume it with the same
          choices. Completed file copies are verified and reused.
        </p>
        <p
          v-for="blocker in preview.blockers"
          :key="blocker"
          role="alert"
          class="text-sm text-(--contrast-error-color)"
        >
          {{ blocker }}
        </p>
        <label
          v-for="split in preview.splits"
          :key="split.bookId"
          class="flex flex-col gap-1 text-sm"
        >
          {{ split.title }}: collection keeping the original entry{{
            split.calibreBookId ? ` and Calibre ID ${split.calibreBookId}` : ''
          }}
          <select
            v-model="choices[split.bookId]"
            :disabled="busy || preview.state === 'migrating'"
            class="border border-(--contrast-border-color) rounded p-2 bg-(--bg-color)"
          >
            <option :value="undefined" disabled>Choose a collection</option>
            <option
              v-for="collection in split.collections"
              :key="collection.id"
              :value="collection.id"
            >
              {{ collection.name }}
            </option>
          </select>
        </label>
        <label
          v-if="preview.dropboxTargets.needsChoice"
          class="flex flex-col gap-1 text-sm"
          >Dropbox has multiple or stale destinations. Choose one destination
          for future batches.
          <select
            v-model="dropboxTargetId"
            :disabled="busy || preview.state === 'migrating'"
            class="border border-(--contrast-border-color) rounded p-2 bg-(--bg-color)"
          >
            <option :value="null" disabled>Choose a destination</option>
            <option value="">Use the new shared default</option>
            <option
              v-for="collection in preview.dropboxTargets.options"
              :key="collection.id"
              :value="collection.id"
            >
              {{ collection.name }}
            </option>
          </select>
        </label>
        <label class="flex gap-2 items-start text-sm"
          ><input v-model="backupConfirmed" type="checkbox" :disabled="busy" />I
          have a matching backup of the database and managed library.</label
        >
        <button
          type="button"
          :disabled="busy || !ready"
          class="self-start px-3 py-2 rounded bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-50"
          @click="applyMigration"
        >
          {{
            busy
              ? 'Migrating…'
              : preview.state === 'migrating'
                ? 'Resume migration'
                : 'Apply migration'
          }}
        </button>
      </div>
    </template>
    <template v-else-if="preview">
      <p class="text-sm">
        New users join the default as editors. Changing the default affects
        future enrollment and uploads. Existing books and memberships stay where
        they are.
      </p>
      <p class="text-sm">
        These administrative controls include collections you have not joined.
        Your ordinary library still shows only your memberships.
      </p>
      <div
        v-for="collection in collections"
        :key="collection.id"
        class="border border-(--contrast-border-color) rounded p-3 flex flex-wrap items-center justify-between gap-3"
      >
        <div>
          <div class="font-semibold">
            {{ collection.name }}
            <span v-if="collection.isDefault" class="text-xs font-normal"
              >Default</span
            >
          </div>
          <div class="text-sm opacity-70">
            Owner: {{ collection.ownerEmail }} ·
            {{ collection.bookCount }} books
          </div>
        </div>
        <div class="flex gap-2">
          <button
            v-if="!collection.isDefault"
            type="button"
            :disabled="busy"
            class="px-3 py-2 border border-(--contrast-border-color) rounded"
            @click="makeDefault(collection)"
          >
            Make default</button
          ><button
            type="button"
            :disabled="busy"
            class="px-3 py-2 border border-(--contrast-border-color) rounded"
            @click="editing = collection"
          >
            Collection settings
          </button>
        </div>
      </div>
      <EditCollectionModal
        :open="Boolean(editing)"
        :collection="editing"
        @close="closeSettings"
        @saved="refresh"
      />
    </template>
  </div>
</template>
