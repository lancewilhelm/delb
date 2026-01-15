<script setup lang="ts">
defineOptions({ name: 'SettingsAdminMetadata' });

const { isAdmin } = useAuth();
const globalSettingsStore = useGlobalSettingsStore();

const providerOptions = [
  { value: 'googleBooks', label: 'Google Books' },
  { value: 'hardcover', label: 'Hardcover' },
] as const;

const provider = computed({
  get: () => globalSettingsStore.settings.metadataProvider ?? 'googleBooks',
  set: async (v: 'googleBooks' | 'hardcover') => {
    await globalSettingsStore.updateSettings({ metadataProvider: v });
  },
});

// Local input so you can type without immediately persisting each keystroke
const tokenInput = ref<string>('');
watch(
  () => globalSettingsStore.capabilities?.hardcoverAvailable,
  () => {
    // no-op; this exists so the template reacts when capabilities change
  },
);

const saveState = reactive({
  saving: false,
  error: '',
  ok: '',
});

async function saveToken() {
  saveState.error = '';
  saveState.ok = '';

  if (!isAdmin.value) {
    saveState.error = 'You must be an admin to update Hardcover settings.';
    return;
  }

  saveState.saving = true;
  try {
    await $fetch('/api/settings/admin/hardcover-token', {
      method: 'PUT',
      body: { token: tokenInput.value },
    });

    // Refresh capabilities so the UI can enable Hardcover elsewhere
    await globalSettingsStore.pullLatest();

    tokenInput.value = '';
    saveState.ok = 'Hardcover token updated.';
  } catch (e: unknown) {
    saveState.error =
      e instanceof Error ? e.message : 'Failed to update Hardcover token.';
  } finally {
    saveState.saving = false;
  }
}

async function clearToken() {
  tokenInput.value = '';
  await saveToken();
}
</script>

<template>
  <SettingsUIGroup
    title="metadata providers"
    icon="lucide:book-open"
    description="configure external metadata sources (Hardcover, Google Books, etc.)"
  >
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-2">
        <div class="text-sm font-semibold">Default provider</div>

        <select
          v-model="provider"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          :disabled="!isAdmin"
        >
          <option
            v-for="opt in providerOptions"
            :key="opt.value"
            :value="opt.value"
          >
            {{ opt.label }}
          </option>
        </select>

        <div class="text-xs opacity-70">
          This selects which provider the UI should prefer by default. (Actual
          usage depends on the metadata search modal implementation.)
        </div>
      </div>

      <div class="border-t border-(--sub-color) pt-4">
        <div class="flex flex-col gap-2">
          <div class="text-sm font-semibold">Hardcover API token</div>

          <div class="text-xs opacity-70">
            Enter your Hardcover bearer token. You can paste either the raw
            token or
            <span class="font-mono">Bearer &lt;token&gt;</span>. The token is
            stored server-side and is never returned to the client.
          </div>

          <input
            v-model="tokenInput"
            type="password"
            autocomplete="off"
            spellcheck="false"
            placeholder="Hardcover token (stored server-side)"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="!isAdmin || saveState.saving"
            @keyup.enter="saveToken"
          />

          <div class="flex items-center justify-between gap-3">
            <div class="flex gap-1 text-xs opacity-70 min-w-0">
              <span class="font-semibold">Status:</span>
              <span
                v-if="globalSettingsStore.capabilities?.hardcoverAvailable"
                class="opacity-80"
              >
                configured
              </span>
              <span v-else class="opacity-60">not configured</span>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                class="px-3 py-2 rounded-lg bg-(--main-color) text-(--bg-color) disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="!isAdmin || saveState.saving"
                @click="saveToken"
              >
                {{ saveState.saving ? 'saving...' : 'save' }}
              </button>

              <button
                type="button"
                class="px-3 py-2 rounded-lg border border-(--sub-color) disabled:opacity-50 disabled:cursor-not-allowed"
                :disabled="!isAdmin || saveState.saving"
                @click="clearToken"
              >
                clear
              </button>
            </div>
          </div>

          <div v-if="saveState.error" class="text-sm text-(--error-color)">
            {{ saveState.error }}
          </div>
          <div v-else-if="saveState.ok" class="text-sm opacity-80">
            {{ saveState.ok }}
          </div>

          <div class="mt-2 text-xs opacity-70">
            <div class="font-semibold">Security note</div>
            <div>
              This token is stored server-side and is never included in
              <span class="font-mono">/api/settings</span> responses. The client
              only receives a non-secret capability flag indicating whether
              Hardcover is available.
            </div>
          </div>
        </div>
      </div>
    </div>
  </SettingsUIGroup>
</template>
