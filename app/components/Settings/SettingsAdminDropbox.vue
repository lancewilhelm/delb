<script setup lang="ts">
import { useAuth } from '~/composables/useAuth';
import { useGlobalSettingsStore } from '~/stores/globalSettings';
import { logger } from '~/utils/logger';
import { roleCanEditCatalog } from '~/utils/roles';
import { computed, onMounted, ref, watch } from 'vue';
import SettingsUIGroup from '~/components/Settings/UI/SettingsUIGroup.vue';
defineOptions({ name: 'SettingsAdminDropbox' });

type UserOption = { id: string; email: string; role?: string };

const { isAdmin } = useAuth();
const globalSettingsStore = useGlobalSettingsStore();

const usersLoading = ref(false);
const users = ref<UserOption[]>([]);

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

// Readers cannot add books, so only editors and administrators can import.
const importingUsers = computed(() =>
  users.value.filter((u) => roleCanEditCatalog(u.role)),
);

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
    title="Dropbox Ingestion"
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
          class="h-5 w-5 border border-(--contrast-border-color) rounded transition peer-checked:bg-(--main-color) cursor-pointer"
          :class="
            !isAdmin ? 'peer-checked:bg-(--sub-color) cursor-default!' : ''
          "
        ></span>
        <span class="font-semibold">enabled</span>
      </label>

      <div class="space-y-1">
        <div class="text-sm font-semibold">dropbox folder (relative)</div>
        <input
          v-model="dir"
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
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
            class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
            :disabled="!isAdmin"
            @keyup.enter="saveExtensions"
          />
          <button
            type="button"
            class="px-3 py-2 rounded-lg bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-50 disabled:cursor-not-allowed"
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
            class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
            :disabled="!isAdmin"
          />
        </div>
        <div class="space-y-1">
          <div class="text-sm font-semibold">stable passes</div>
          <input
            v-model.number="stablePassesRequired"
            type="number"
            min="1"
            class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
            :disabled="!isAdmin"
          />
        </div>
        <div class="space-y-1">
          <div class="text-sm font-semibold">stable max age (ms)</div>
          <input
            v-model.number="stableMaxAgeMs"
            type="number"
            min="1000"
            class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
            :disabled="!isAdmin"
          />
        </div>
      </div>

      <div class="space-y-2">
        <div class="text-sm font-semibold">importing user (optional)</div>
        <select
          v-model="targetUserId"
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
          :disabled="!isAdmin || usersLoading"
        >
          <option value="">(default: system owner)</option>
          <option v-for="u in importingUsers" :key="u.id" :value="u.id">
            {{ u.email }}{{ u.role ? ` (${u.role})` : '' }}
          </option>
        </select>
        <div class="text-xs opacity-70">
          Dropbox books go into the shared library. This user is recorded as the
          uploader and must be an editor or administrator.
        </div>
      </div>
    </div>
  </SettingsUIGroup>
</template>
