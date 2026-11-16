<script setup lang="ts">
const url = '/api/settings/admin/chatgpt-image';
const connected = ref(false);
const reconnectRequired = ref(false);
const busy = ref(false);
const error = ref('');
const challenge = ref<{
  attemptId: string;
  code: string;
  url: string;
  interval: number;
} | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;

async function load() {
  try {
    const result = await $fetch<{
      connected: boolean;
      reconnectRequired: boolean;
    }>(url);
    connected.value = result.connected;
    reconnectRequired.value = result.reconnectRequired;
  } catch {
    error.value = 'Could not load the ChatGPT connection.';
  }
}
async function connect() {
  busy.value = true;
  error.value = '';
  try {
    challenge.value = await $fetch<{
      attemptId: string;
      code: string;
      url: string;
      interval: number;
    }>(url, { method: 'POST', body: { action: 'start' } });
    poll();
  } catch {
    error.value =
      'Could not start ChatGPT sign-in. Check the server configuration and try again.';
  } finally {
    busy.value = false;
  }
}
function poll() {
  const current = challenge.value;
  if (!current || disposed) return;
  timer = setTimeout(async () => {
    try {
      const result = await $fetch<{ connected: boolean }>(url, {
        method: 'POST',
        body: { action: 'poll', attemptId: current.attemptId },
      });
      if (disposed || challenge.value?.attemptId !== current.attemptId) return;
      if (result.connected) {
        connected.value = true;
        reconnectRequired.value = false;
        challenge.value = null;
      } else poll();
    } catch {
      challenge.value = null;
      error.value = 'ChatGPT sign-in expired or failed. Try connecting again.';
    }
  }, current.interval * 1000);
}
async function disconnect() {
  busy.value = true;
  try {
    await $fetch<{ connected: boolean }>(url, { method: 'DELETE' });
    connected.value = false;
    reconnectRequired.value = false;
    challenge.value = null;
    error.value = '';
    if (timer) clearTimeout(timer);
  } catch {
    error.value = 'Could not disconnect ChatGPT.';
  } finally {
    busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <SettingsUIGroup
    title="Spine generation"
    icon="lucide:sparkles"
    description="Connect ChatGPT for experimental spine artwork generation"
  >
    <div class="flex flex-col items-start gap-3 text-sm">
      <p>
        All book editors can use this shared ChatGPT connection to generate
        spine artwork for books they can edit. Delb sends the saved book cover
        and editing instructions to OpenAI through Codex. The service may change
        or be unavailable for some accounts.
      </p>
      <p v-if="error" role="alert" class="text-(--contrast-error-color)">
        {{ error }}
      </p>
      <p v-if="connected">ChatGPT is connected.</p>
      <p v-else-if="reconnectRequired">
        The ChatGPT connection needs to be renewed.
      </p>
      <p v-else>ChatGPT is not connected.</p>
      <template v-if="challenge">
        <p>
          Open
          <a
            :href="challenge.url"
            target="_blank"
            rel="noopener noreferrer"
            class="underline"
            >ChatGPT sign-in</a
          >
          and enter <strong>{{ challenge.code }}</strong
          >. Waiting for sign-in…
        </p>
        <button
          type="button"
          class="px-3 py-2 rounded-lg border border-(--contrast-border-color)"
          :disabled="busy"
          @click="disconnect"
        >
          Cancel sign-in
        </button>
      </template>
      <div v-else class="flex flex-wrap gap-2">
        <button
          v-if="!connected"
          type="button"
          class="px-3 py-2 rounded-lg bg-(--main-color) text-(--contrast-inverse-color) disabled:opacity-50"
          :disabled="busy"
          @click="connect"
        >
          Connect ChatGPT
        </button>
        <button
          v-if="connected || reconnectRequired"
          type="button"
          class="px-3 py-2 rounded-lg border border-(--contrast-border-color) disabled:opacity-50"
          :disabled="busy"
          @click="disconnect"
        >
          Disconnect ChatGPT
        </button>
      </div>
    </div>
  </SettingsUIGroup>
</template>
