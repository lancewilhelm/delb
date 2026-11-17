<script setup lang="ts">
type Connection = {
  id: string;
  name: string;
  canWrite: boolean;
  createdAt: string;
  expiresAt: string;
};
const connections = ref<Connection[]>([]);
const name = ref('Hermes');
const canWrite = ref(false);
const token = ref('');
const error = ref('');
const busy = ref(false);
const copied = ref(false);

async function refresh() {
  connections.value = await $fetch<Connection[]>('/api/mcp-connections');
}
async function create() {
  busy.value = true;
  error.value = '';
  token.value = '';
  copied.value = false;
  try {
    const created = await $fetch<Connection & { token: string }>(
      '/api/mcp-connections',
      { method: 'POST', body: { name: name.value, canWrite: canWrite.value } },
    );
    token.value = created.token;
    await refresh().catch(() => {
      error.value =
        'Connection created, but the list could not be refreshed. Copy the token before reloading.';
    });
  } catch {
    error.value =
      'Could not create the connection. Check its name and try again.';
  } finally {
    busy.value = false;
  }
}
async function revoke(id: string) {
  if (!confirm('Revoke this connection? The agent will lose access.')) return;
  busy.value = true;
  error.value = '';
  try {
    await $fetch('/api/mcp-connections', { method: 'DELETE', body: { id } });
    connections.value = connections.value.filter(
      (connection) => connection.id !== id,
    );
  } catch {
    error.value = 'Could not revoke the connection.';
  } finally {
    busy.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(token.value);
    copied.value = true;
  } catch {
    error.value = 'Select and copy the token below.';
  }
}
onMounted(() => {
  refresh().catch(() => {
    error.value = 'Could not load connections.';
  });
});
</script>

<template>
  <div class="w-full">
    <SettingsUIGroup title="MCP connections" icon="lucide:plug">
      <div class="flex flex-col gap-4 max-w-2xl">
        <p>
          Connect an agent to the books you can access. Each connection has its
          own token and expires after one year.
        </p>
        <label class="flex flex-col gap-1"
          >Connection name
          <input
            v-model="name"
            maxlength="80"
            class="px-3 py-2 rounded-lg bg-(--sub-alt-color)"
          />
        </label>
        <label class="flex gap-2 items-start"
          ><input v-model="canWrite" type="checkbox" class="mt-1" /> Allow
          changes to my reading status and personal shelves</label
        >
        <button
          :disabled="busy || !name.trim()"
          class="self-start px-4 py-2 rounded-lg bg-(--sub-alt-color) disabled:opacity-50"
          @click="create"
        >
          Create connection
        </button>
        <div
          v-if="token"
          class="flex flex-col gap-2 p-4 rounded-lg bg-(--sub-alt-color)"
        >
          <p>
            Copy this token now. Delb cannot show it again. Store it in your
            agent's secrets.
          </p>
          <textarea
            :value="token"
            readonly
            rows="3"
            aria-label="Connection token"
            class="w-full p-2 break-all rounded bg-(--bg-color)"
          />
          <div class="flex gap-3">
            <button @click="copy">{{ copied ? 'Copied' : 'Copy token' }}</button
            ><button @click="token = ''">Done</button>
          </div>
        </div>
        <p v-if="error" role="alert">{{ error }}</p>
        <div
          v-for="connection in connections"
          :key="connection.id"
          class="flex flex-wrap items-center justify-between gap-2 border-t border-(--contrast-border-color) pt-3"
        >
          <div>
            <strong>{{ connection.name }}</strong>
            <p>
              {{
                connection.canWrite ? 'Read and personal changes' : 'Read only'
              }}
              · Expires
              {{ new Date(connection.expiresAt).toLocaleDateString() }}
            </p>
          </div>
          <button
            :disabled="busy"
            class="px-3 py-2 rounded-lg bg-(--sub-alt-color)"
            @click="revoke(connection.id)"
          >
            Revoke
          </button>
        </div>
      </div>
    </SettingsUIGroup>
  </div>
</template>
