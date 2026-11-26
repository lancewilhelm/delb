<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { $fetch } from '~/utils/apiFetch';
import { extractFetchErrorMessage } from '~/utils/responseError';
import {
  buildTagRulesPayload,
  describeTagRules,
  rulesToModes,
  sameTagRules,
  setTagMode,
  type TagRef,
  type TagRuleMode,
  type TagRulesResponse,
} from '~/utils/tagRules';

defineOptions({ name: 'SettingsAdminUserTagRules' });

const props = defineProps<{ userId: string }>();

const MAX_TAG_PAGES = 50;

const loading = ref(false);
const saving = ref(false);
const error = ref('');
const savedMessage = ref('');
const search = ref('');
const tags = ref<TagRef[]>([]);
const savedModes = ref<Record<string, TagRuleMode>>({});
const modes = ref<Record<string, TagRuleMode>>({});

async function fetchAllTags(): Promise<TagRef[]> {
  const out: TagRef[] = [];
  for (let page = 0; page < MAX_TAG_PAGES; page++) {
    const response = await $fetch<{
      data?: { tags?: TagRef[]; hasMore?: boolean };
    }>('/api/tags', {
      query: { limit: 100, offset: page * 100, previewLimit: 0 },
    });
    out.push(
      ...(response.data?.tags ?? []).map((t) => ({ id: t.id, name: t.name })),
    );
    if (!response.data?.hasMore) break;
  }
  return out;
}

async function load() {
  if (!props.userId) return;
  loading.value = true;
  error.value = '';
  savedMessage.value = '';
  try {
    const [rulesResponse, allTags] = await Promise.all([
      $fetch<{ data: TagRulesResponse }>(
        `/api/settings/admin/users/${encodeURIComponent(props.userId)}/tag-rules`,
      ),
      fetchAllTags(),
    ]);
    const rules = rulesResponse.data;
    // A rule can name a tag that no book uses any more, so merge those in.
    const byId = new Map(allTags.map((t) => [t.id, t]));
    for (const t of [...rules.allowTags, ...rules.blockTags]) {
      if (!byId.has(t.id)) byId.set(t.id, t);
    }
    tags.value = [...byId.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
    savedModes.value = rulesToModes(rules);
    modes.value = { ...savedModes.value };
  } catch (err) {
    error.value =
      extractFetchErrorMessage(err) ?? 'Could not load tag visibility rules.';
  } finally {
    loading.value = false;
  }
}

watch(() => props.userId, load, { immediate: true });

const filteredTags = computed(() => {
  const needle = search.value.trim().toLowerCase();
  const list = needle
    ? tags.value.filter((t) => t.name.toLowerCase().includes(needle))
    : tags.value;
  // Tags with rules come first so they stay easy to find.
  return [...list].sort(
    (a, b) =>
      Number(!modes.value[a.id]) - Number(!modes.value[b.id]) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
});

const dirty = computed(() => !sameTagRules(modes.value, savedModes.value));
const summary = computed(() => describeTagRules(modes.value));

function modeFor(tagId: string): TagRuleMode {
  return modes.value[tagId] ?? 'none';
}

function onModeChange(tagId: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value as TagRuleMode;
  modes.value = setTagMode(modes.value, tagId, value);
  savedMessage.value = '';
}

async function save() {
  saving.value = true;
  error.value = '';
  savedMessage.value = '';
  try {
    const response = await $fetch<{ data: TagRulesResponse }>(
      `/api/settings/admin/users/${encodeURIComponent(props.userId)}/tag-rules`,
      { method: 'PUT', body: buildTagRulesPayload(modes.value) },
    );
    savedModes.value = rulesToModes(response.data);
    modes.value = { ...savedModes.value };
    savedMessage.value = 'Tag rules saved.';
  } catch (err) {
    error.value =
      extractFetchErrorMessage(err) ?? 'Could not save tag visibility rules.';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 w-full">
    <div class="text-(--contrast-text-color) text-sm">tag visibility rules</div>
    <p class="text-(--contrast-sub-color) text-xs">
      Allow tags to show this account only books with at least one allowed tag.
      Hide tags to keep books with any hidden tag out of every page, search,
      count, and agent tool for this account. Rules never apply to admins.
    </p>
    <p class="text-xs" aria-live="polite">{{ summary }}</p>

    <div v-if="loading" class="text-sm opacity-80">Loading tags…</div>
    <template v-else>
      <input
        v-model="search"
        type="search"
        placeholder="filter tags"
        aria-label="Filter tags"
        class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
      />
      <div v-if="!tags.length" class="text-sm opacity-80">
        No tags yet. Add shared tags to books first.
      </div>
      <ul
        v-else
        class="max-h-56 overflow-y-auto flex flex-col divide-y divide-(--contrast-border-color) border border-(--contrast-border-color) rounded-lg"
        aria-label="Tag rules"
      >
        <li
          v-for="tag in filteredTags"
          :key="tag.id"
          class="flex items-center justify-between gap-2 px-2 py-1 text-sm"
        >
          <span class="truncate" :title="tag.name">{{ tag.name }}</span>
          <select
            :value="modeFor(tag.id)"
            :aria-label="`Rule for ${tag.name}`"
            class="p-1 border border-(--contrast-border-color) rounded bg-(--bg-color)"
            :disabled="saving"
            @change="onModeChange(tag.id, $event)"
          >
            <option value="none">no rule</option>
            <option value="allow">allow</option>
            <option value="block">hide</option>
          </select>
        </li>
      </ul>
    </template>

    <p v-if="error" role="alert" class="text-xs text-(--contrast-error-color)">
      {{ error }}
    </p>
    <p v-else-if="savedMessage" class="text-xs" role="status">
      {{ savedMessage }}
    </p>
    <button
      class="bg-(--sub-alt-color) text-(--contrast-text-color) p-2 rounded-lg disabled:opacity-50"
      :disabled="loading || saving || !dirty"
      @click="save"
    >
      {{ saving ? 'saving…' : 'save tag rules' }}
    </button>
  </div>
</template>
