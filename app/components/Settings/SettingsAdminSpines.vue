<script setup lang="ts">
import { $fetch } from '~/utils/apiFetch';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import SettingsUIGroup from '~/components/Settings/UI/SettingsUIGroup.vue';
import {
  maxSpinePromptLength,
  spinePromptPlaceholders,
} from '~~/shared/spine-generation-prompt';

type PromptResponse = {
  prompt: string;
  savedPrompt: string | null;
  defaultPrompt: string;
};
const promptUrl = '/api/settings/admin/spine-prompt';
const prompt = ref('');
const savedPrompt = ref<string | null>(null);
const defaultPrompt = ref('');
const promptLoaded = ref(false);
const promptBusy = ref(false);
const promptError = ref('');
const promptNotice = ref('');
const promptConflict = ref(false);
const missingPlaceholders = computed(() =>
  spinePromptPlaceholders.filter((item) => !prompt.value.includes(item)),
);
const promptChanged = computed(
  () => prompt.value !== (savedPrompt.value ?? defaultPrompt.value),
);

async function loadPrompt() {
  promptBusy.value = true;
  promptError.value = '';
  try {
    const result = await $fetch<PromptResponse>(promptUrl);
    prompt.value = result.prompt;
    savedPrompt.value = result.savedPrompt;
    defaultPrompt.value = result.defaultPrompt;
    promptLoaded.value = true;
    promptConflict.value = false;
    promptNotice.value = '';
  } catch {
    promptError.value = 'Could not load the generation prompt.';
  } finally {
    promptBusy.value = false;
  }
}
async function savePrompt() {
  promptBusy.value = true;
  promptError.value = '';
  promptNotice.value = '';
  try {
    const result = await $fetch<PromptResponse>(promptUrl, {
      method: 'PUT',
      body: { prompt: prompt.value, previous: savedPrompt.value },
    });
    savedPrompt.value = result.savedPrompt;
    defaultPrompt.value = result.defaultPrompt;
    promptNotice.value = 'Prompt saved for future generations.';
  } catch (error: unknown) {
    if (
      error &&
      typeof error === 'object' &&
      'statusCode' in error &&
      error.statusCode === 409
    ) {
      promptConflict.value = true;
      promptError.value =
        'Another administrator changed the prompt. Copy your edits, then reload the current prompt.';
    } else {
      promptError.value =
        'Could not save the prompt. Check the required placeholders and try again.';
    }
  } finally {
    promptBusy.value = false;
  }
}

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
onMounted(() => {
  void load();
  void loadPrompt();
});
onBeforeUnmount(() => {
  disposed = true;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="w-full">
    <SettingsUIGroup
      title="Spine generation"
      icon="lucide:sparkles"
      description="Connect ChatGPT for experimental spine artwork generation"
    >
      <div class="flex flex-col items-start gap-3 text-sm">
        <p>
          All book editors can use this shared ChatGPT connection to generate
          spine artwork for books they can edit. Delb sends the saved book cover
          and editing instructions to OpenAI through Codex. The service may
          change or be unavailable for some accounts.
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
    <SettingsUIGroup
      title="Generation prompt"
      icon="lucide:scroll-text"
      description="Edit the shared instructions sent with each spine generation request"
    >
      <div class="flex w-full flex-col items-start gap-3 text-sm">
        <p>
          The template applies to new previews and updates for all book editors.
          Delb replaces each required placeholder with the book details,
          reference-image instructions, or the editor's extra instructions.
        </p>
        <p v-pre class="text-(--contrast-sub-color)">
          Required: {{ title }}, {{ authors }}, {{ reference }},
          {{ instructions }}
        </p>
        <label
          v-if="promptLoaded"
          for="spine-generation-prompt"
          class="font-semibold"
          >Prompt template</label
        >
        <textarea
          v-if="promptLoaded"
          id="spine-generation-prompt"
          v-model="prompt"
          :maxlength="maxSpinePromptLength"
          :disabled="promptBusy"
          rows="12"
          spellcheck="true"
          class="w-full rounded-lg border border-(--contrast-border-color) bg-(--bg-color) p-3 font-mono text-sm"
        />
        <p
          v-if="promptLoaded && missingPlaceholders.length"
          role="alert"
          class="text-(--contrast-error-color)"
        >
          Missing: {{ missingPlaceholders.join(', ') }}
        </p>
        <p
          v-if="promptError"
          role="alert"
          class="text-(--contrast-error-color)"
        >
          {{ promptError }}
        </p>
        <p v-if="promptNotice" role="status">{{ promptNotice }}</p>
        <div class="flex flex-wrap gap-2">
          <button
            v-if="promptLoaded"
            type="button"
            :disabled="
              promptBusy ||
              promptConflict ||
              !promptChanged ||
              missingPlaceholders.length > 0
            "
            class="rounded-lg bg-(--main-color) px-3 py-2 text-(--contrast-inverse-color) disabled:opacity-50"
            @click="savePrompt"
          >
            Save prompt
          </button>
          <button
            v-if="promptLoaded"
            type="button"
            :disabled="promptBusy || prompt === defaultPrompt"
            class="rounded-lg border border-(--contrast-border-color) px-3 py-2 disabled:opacity-50"
            @click="
              prompt = defaultPrompt;
              promptNotice = '';
            "
          >
            Restore default
          </button>
          <button
            v-if="promptConflict || !promptLoaded"
            type="button"
            :disabled="promptBusy"
            class="rounded-lg border border-(--contrast-border-color) px-3 py-2 disabled:opacity-50"
            @click="loadPrompt"
          >
            Reload prompt
          </button>
        </div>
      </div>
    </SettingsUIGroup>
  </div>
</template>
