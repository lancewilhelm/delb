<script setup lang="ts">
defineOptions({ name: 'SettingsAdminDropbox' });

type CollectionOption = { id: string; name: string; isPersonal?: boolean };
type UserOption = { id: string; email: string; role?: string };

const { isAdmin } = useAuth();
const globalSettingsStore = useGlobalSettingsStore();

const collectionsLoading = ref(false);
const collections = ref<CollectionOption[]>([]);

const usersLoading = ref(false);
const users = ref<UserOption[]>([]);

async function fetchCollections() {
  collectionsLoading.value = true;
  try {
    const res = await $fetch<{
      success: boolean;
      data?: {
        collections?: Array<{
          id: string;
          name: string;
          isPersonal?: boolean;
        }>;
      };
    }>('/api/collections', { method: 'GET' });

    collections.value = (res?.data?.collections ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      isPersonal: Boolean(c.isPersonal),
    }));
  } finally {
    collectionsLoading.value = false;
  }
}

onMounted(fetchCollections);

async function fetchUsers() {
  usersLoading.value = true;
  try {
    const { admin } = useAuth();
    const { data, error } = await admin.listUsers({ query: { limit: 200 } });

    if (error) {
      const msg =
        error && typeof error === 'object' && 'message' in error
          ? String((error as { message?: unknown }).message ?? 'Unknown error')
          : String(error ?? 'Unknown error');
      logger.error(`dropbox settings: failed to fetch users: ${msg}`);
      users.value = [];
      return;
    }

    users.value = (data?.users ?? [])
      .map((u) => ({
        id: u.id,
        email: u.email,
        role: (u as { role?: unknown })?.role
          ? String((u as { role?: unknown }).role)
          : undefined,
      }))
      .filter((u) => u.id && u.email);
  } finally {
    usersLoading.value = false;
  }
}

onMounted(fetchUsers);

function getDropboxSettings() {
  return globalSettingsStore.settings.dropbox ?? {};
}

async function updateDropbox(partial: Record<string, unknown>) {
  await globalSettingsStore.updateSettings({
    dropbox: { ...getDropboxSettings(), ...partial },
  });
  await globalSettingsStore.pullLatest();
}

const enabled = computed({
  get: () => Boolean(getDropboxSettings().enabled),
  set: async (v: boolean) => updateDropbox({ enabled: v }),
});

const dir = computed({
  get: () => (getDropboxSettings().dir ?? 'dropbox').toString(),
  set: async (v: string) => updateDropbox({ dir: v }),
});

function extensionsToString(v: unknown): string {
  if (Array.isArray(v))
    return v
      .map((s) => String(s).trim())
      .filter(Boolean)
      .join(', ');
  return (v ?? '').toString();
}

const extensionsInput = ref<string>('');
watch(
  () => globalSettingsStore.settings.dropbox?.extensions,
  (v) => {
    extensionsInput.value =
      extensionsToString(v) || '.epub, .pdf, .mobi, .azw3';
  },
  { immediate: true },
);

async function saveExtensions() {
  const parts = extensionsInput.value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('.') ? s : `.${s}`));
  await updateDropbox({ extensions: parts });
}

const pollIntervalMs = computed({
  get: () => Number(getDropboxSettings().pollIntervalMs ?? 2500),
  set: async (v: number) => updateDropbox({ pollIntervalMs: v }),
});

const stablePassesRequired = computed({
  get: () => Number(getDropboxSettings().stablePassesRequired ?? 2),
  set: async (v: number) => updateDropbox({ stablePassesRequired: v }),
});

const stableMaxAgeMs = computed({
  get: () => Number(getDropboxSettings().stableMaxAgeMs ?? 5 * 60 * 1000),
  set: async (v: number) => updateDropbox({ stableMaxAgeMs: v }),
});

const targetCollectionId = computed({
  get: () => (getDropboxSettings().targetCollectionId ?? '').toString(),
  set: async (v: string) => updateDropbox({ targetCollectionId: v }),
});

const targetUserId = computed({
  get: () => (getDropboxSettings().targetUserId ?? '').toString(),
  set: async (v: string) =>
    updateDropbox({
      targetUserId: v,
      // Avoid ambiguous configs; prefer userId once chosen.
      targetUserEmail: '',
    }),
});
</script>

<template>
  <SettingsUIGroup
    title="dropbox ingestion"
    icon="lucide:inbox"
    description="watch a local folder and auto-ingest supported book files"
  >
    <div class="space-y-4 w-full">
      <label class="flex items-center gap-2 text-sm">
        <input
          v-model="enabled"
          type="checkbox"
          class="peer sr-only"
          :disabled="!isAdmin"
        />
        <span
          class="h-5 w-5 border border-(--sub-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
          :class="!isAdmin ? 'peer-checked:bg-(--sub-color) cursor-default!' : ''"
        ></span>
        <span class="font-semibold">enabled</span>
      </label>

      <div class="space-y-1">
        <div class="text-sm font-semibold">dropbox folder (relative)</div>
        <input
          v-model="dir"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          placeholder="dropbox"
          :disabled="!isAdmin"
        />
        <div class="text-xs opacity-70">
          Relative to the project root. Default: <code>dropbox</code>
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-sm font-semibold">allowed extensions</div>
        <div class="text-xs opacity-70">
          Comma-separated. Example: <code>.epub, .pdf</code>
        </div>
        <div class="flex gap-2">
          <input
            v-model="extensionsInput"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="!isAdmin"
            @keyup.enter="saveExtensions"
          />
          <button
            type="button"
            class="px-3 py-2 rounded-lg bg-(--main-color) text-(--bg-color) disabled:opacity-50 disabled:cursor-not-allowed"
            :disabled="!isAdmin"
            @click="saveExtensions"
          >
            save
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div class="space-y-1">
          <div class="text-sm font-semibold">poll interval (ms)</div>
          <input
            v-model.number="pollIntervalMs"
            type="number"
            min="250"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="!isAdmin"
          />
        </div>
        <div class="space-y-1">
          <div class="text-sm font-semibold">stable passes</div>
          <input
            v-model.number="stablePassesRequired"
            type="number"
            min="1"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="!isAdmin"
          />
        </div>
        <div class="space-y-1">
          <div class="text-sm font-semibold">stable max age (ms)</div>
          <input
            v-model.number="stableMaxAgeMs"
            type="number"
            min="1000"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="!isAdmin"
          />
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-sm font-semibold">target collection (optional)</div>
        <select
          v-model="targetCollectionId"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          :disabled="!isAdmin || collectionsLoading"
        >
          <option value="">(default: personal collection)</option>
          <option v-for="c in collections" :key="c.id" :value="c.id">
            {{ c.name }}{{ c.isPersonal ? ' (Personal)' : '' }}
          </option>
        </select>
        <div class="text-xs opacity-70">
          If unset, the server ingests into a Personal collection.
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-sm font-semibold">book owner (optional)</div>
        <select
          v-model="targetUserId"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          :disabled="!isAdmin || usersLoading"
        >
          <option value="">(default: system owner)</option>
          <option v-for="u in users" :key="u.id" :value="u.id">
            {{ u.email }}{{ u.role ? ` (${u.role})` : '' }}
          </option>
        </select>
        <div class="text-xs opacity-70">
          This user will be set as the uploader/adder for ingested books. If the
          target collection is unset, the book is also added to this user’s
          Personal collection.
        </div>
      </div>
    </div>
  </SettingsUIGroup>
</template>
