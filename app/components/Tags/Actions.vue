<script setup lang="ts">
const props = defineProps<{ tag: { id: string; name: string } }>();
const emit = defineEmits<{ changed: [targetId?: string] }>();
const { isAdmin } = useAuth();
type TagRef = { id: string; name: string };
type DialogState =
  | { kind: 'closed' }
  | { kind: 'delete' }
  | { kind: 'merge'; target: TagRef | null };
const state = ref<DialogState>({ kind: 'closed' });
const menuOpen = ref(false);
const id = useId();
const titleId = `${id}-title`;
const searchId = `${id}-search`;
const pending = ref(false);
const error = ref('');
const query = ref('');
const results = ref<TagRef[]>([]);
const menu = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const menuPosition = ref({ left: 0, top: 0 });
const dialog = ref<HTMLDialogElement | null>(null);
let searchGeneration = 0;
async function openMenu() {
  if (!isAdmin.value) return;
  menuOpen.value = true;
  await nextTick();
  const anchor = trigger.value?.getBoundingClientRect();
  const bounds = panel.value?.getBoundingClientRect();
  if (!anchor || !bounds) return;
  menuPosition.value = {
    left: Math.max(
      8,
      Math.min(
        anchor.right - bounds.width,
        window.innerWidth - bounds.width - 8,
      ),
    ),
    top:
      anchor.bottom + bounds.height + 4 <= window.innerHeight - 8
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - bounds.height - 4),
  };
  panel.value?.querySelector('button')?.focus();
}
function toggleMenu() {
  if (menuOpen.value) menuOpen.value = false;
  else void openMenu();
}
function closeMenu() {
  menuOpen.value = false;
}

defineExpose({ openMenu });
function closeDialog() {
  if (!pending.value) dialog.value?.close();
}
function openDialog(kind: 'delete' | 'merge') {
  menuOpen.value = false;
  error.value = '';
  query.value = '';
  results.value = [];
  state.value = kind === 'delete' ? { kind } : { kind, target: null };
  nextTick(() => dialog.value?.showModal());
}
function onClose() {
  state.value = { kind: 'closed' };
  trigger.value?.focus();
}
function onOutside(event: MouseEvent) {
  if (
    menuOpen.value &&
    event.target instanceof Node &&
    !menu.value?.contains(event.target) &&
    !panel.value?.contains(event.target)
  )
    menuOpen.value = false;
}
function onFocus(event: FocusEvent) {
  if (
    menuOpen.value &&
    event.target instanceof Node &&
    !panel.value?.contains(event.target)
  )
    closeMenu();
}
function onKey(event: KeyboardEvent) {
  if (!menuOpen.value || !panel.value?.contains(document.activeElement)) return;
  if (event.key === 'Tab') {
    closeMenu();
    trigger.value?.focus();
    return;
  }
  if (event.key === 'Escape') {
    closeMenu();
    trigger.value?.focus();
    return;
  }
  const items = Array.from(panel.value?.querySelectorAll('button') ?? []);
  const index = items.findIndex((item) => item === document.activeElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = (index + 1) % items.length;
      break;
    case 'ArrowUp':
      next = (index - 1 + items.length) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  items[next]?.focus();
}
onMounted(() => {
  document.addEventListener('mousedown', onOutside);
  document.addEventListener('keydown', onKey);
  document.addEventListener('focusin', onFocus);
  document.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutside);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('focusin', onFocus);
  document.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
});
watch(query, async (value) => {
  const generation = ++searchGeneration;
  results.value = [];
  if (!value.trim()) return;
  try {
    const response = await $fetch<{ data: { results: TagRef[] } }>(
      '/api/tags/search',
      { query: { q: value, limit: 20 } },
    );
    if (generation === searchGeneration)
      results.value = response.data.results.filter(
        (tag) => tag.id !== props.tag.id,
      );
  } catch {
    if (generation === searchGeneration)
      error.value = 'Could not search tags. Try again.';
  }
});
async function submit() {
  if (
    pending.value ||
    state.value.kind === 'closed' ||
    (state.value.kind === 'merge' && !state.value.target)
  )
    return;
  const target = state.value.kind === 'merge' ? state.value.target : null;
  pending.value = true;
  error.value = '';
  try {
    const path = `/api/tags/${encodeURIComponent(props.tag.id)}`;
    if (target)
      await $fetch(`${path}/merge`, {
        method: 'POST',
        body: { targetId: target.id },
      });
    else await $fetch(path, { method: 'DELETE' });
    dialog.value?.close();
    emit('changed', target?.id);
  } catch (e) {
    error.value =
      e instanceof Error ? e.message : 'Could not update tag. Try again.';
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div v-if="isAdmin" ref="menu" class="relative">
    <button
      ref="trigger"
      type="button"
      class="p-2 rounded-md hover:bg-(--sub-color)/20"
      :aria-label="`Actions for ${tag.name}`"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      @click.stop="toggleMenu"
      @keydown.down.prevent="openMenu"
    >
      <Icon name="lucide:ellipsis" />
    </button>
    <Teleport to="body">
      <div
        v-if="menuOpen"
        ref="panel"
        :style="{
          left: `${menuPosition.left}px`,
          top: `${menuPosition.top}px`,
        }"
        role="menu"
        class="fixed z-200 w-40 rounded-md border border-(--sub-color) bg-(--bg-color) shadow-lg"
      >
        <button
          type="button"
          role="menuitem"
          class="w-full px-3 py-2 text-left hover:bg-(--sub-color)/15"
          @click="openDialog('merge')"
        >
          Merge tag
        </button>
        <button
          type="button"
          role="menuitem"
          class="w-full px-3 py-2 text-left hover:bg-(--sub-color)/15"
          @click="openDialog('delete')"
        >
          Delete tag
        </button>
      </div>
      <dialog
        ref="dialog"
        class="m-auto w-[min(32rem,90vw)] rounded-lg border border-(--sub-color) bg-(--bg-color) text-(--text-color) p-6 backdrop:bg-black/50"
        :aria-labelledby="titleId"
        @close="onClose"
        @cancel="pending && $event.preventDefault()"
      >
        <div :id="titleId" class="text-xl font-serif mb-3">
          {{ state.kind === 'merge' ? 'Merge tag' : 'Delete tag' }}
        </div>
        <p v-if="state.kind === 'merge'" class="text-sm mb-4">
          Move all books tagged “{{ tag.name }}” to an existing tag across all
          collections. The destination tag stays and “{{ tag.name }}” is
          deleted. Books are not deleted.
        </p>
        <p v-else class="text-sm mb-4">
          Delete “{{ tag.name }}” from all books across all collections. Books
          are not deleted.
        </p>
        <div v-if="state.kind === 'merge'" class="space-y-2">
          <label :for="searchId" class="text-sm">Destination tag</label>
          <input
            :id="searchId"
            v-model="query"
            class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
            placeholder="Search tags"
            :disabled="pending"
            @input="state.target = null"
          />
          <div v-if="state.target" class="text-sm">
            Selected: {{ state.target.name }}
          </div>
          <div v-else class="max-h-40 overflow-auto">
            <button
              v-for="result in results"
              :key="result.id"
              type="button"
              class="block w-full text-left px-3 py-2 hover:bg-(--sub-color)/15"
              @click="state.target = result"
            >
              {{ result.name }}
            </button>
          </div>
        </div>
        <p v-if="error" role="alert" class="text-sm text-(--error-color) mt-3">
          {{ error }}
        </p>
        <div class="flex justify-end gap-2 mt-5">
          <button
            type="button"
            class="px-3 py-2 rounded-md border border-(--sub-color)"
            :disabled="pending"
            @click="closeDialog"
          >
            Cancel
          </button>
          <button
            type="button"
            class="px-3 py-2 rounded-md bg-(--main-color) text-(--bg-color)"
            :disabled="pending || (state.kind === 'merge' && !state.target)"
            @click="submit"
          >
            {{
              pending
                ? 'Saving...'
                : state.kind === 'merge'
                  ? 'Merge tag'
                  : 'Delete tag'
            }}
          </button>
        </div>
      </dialog>
    </Teleport>
  </div>
</template>
