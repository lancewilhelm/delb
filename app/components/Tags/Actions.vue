<script setup lang="ts">
type TagRef = { id: string; name: string };
type MenuOrigin =
  | { kind: 'pointer'; x: number; y: number; returnFocus: HTMLElement | null }
  | { kind: 'anchor'; anchor: HTMLElement; returnFocus: HTMLElement | null };
type DialogState =
  | { kind: 'closed' }
  | { kind: 'delete' }
  | { kind: 'merge'; target: TagRef | null };
const props = withDefaults(
  defineProps<{
    tag?: TagRef;
    showTrigger?: boolean;
    focusFallback?: () => void;
  }>(),
  { showTrigger: true, tag: undefined, focusFallback: undefined },
);
const emit = defineEmits<{ changed: [targetId?: string] }>();
const { isAdmin } = useAuth();
const state = ref<DialogState>({ kind: 'closed' });
const source = ref<TagRef | null>(null);
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
let returnFocus: HTMLElement | null = null;
let searchGeneration = 0;
let menuGeneration = 0;
function restoreFocus() {
  if (returnFocus?.isConnected) returnFocus.focus();
  else props.focusFallback?.();
}
function closeMenu() {
  menuOpen.value = false;
  menuGeneration++;
}
async function openFor(tag: TagRef, origin: MenuOrigin) {
  if (!isAdmin.value || pending.value || state.value.kind !== 'closed') return;
  const generation = ++menuGeneration;
  source.value = { id: tag.id, name: tag.name };
  returnFocus = origin.returnFocus;
  menuOpen.value = true;
  await nextTick();
  if (generation !== menuGeneration || !menuOpen.value) return;
  const bounds = panel.value?.getBoundingClientRect();
  if (!bounds) return;
  const anchor =
    origin.kind === 'anchor' ? origin.anchor.getBoundingClientRect() : null;
  const x = origin.kind === 'pointer' ? origin.x : (anchor?.left ?? 0);
  const y = origin.kind === 'pointer' ? origin.y : (anchor?.bottom ?? 0);
  menuPosition.value = {
    left: Math.max(0, Math.min(x, window.innerWidth - bounds.width)),
    top: Math.max(0, Math.min(y, window.innerHeight - bounds.height)),
  };
  panel.value?.querySelector('button')?.focus();
}
function openTriggerMenu() {
  if (props.tag && trigger.value)
    void openFor(props.tag, {
      kind: 'anchor',
      anchor: trigger.value,
      returnFocus: trigger.value,
    });
}
function toggleMenu() {
  if (menuOpen.value) closeMenu();
  else openTriggerMenu();
}
defineExpose({ openFor });
function closeDialog() {
  if (!pending.value) dialog.value?.close();
}
function openDialog(kind: 'delete' | 'merge') {
  if (!source.value || pending.value || state.value.kind !== 'closed') return;
  closeMenu();
  searchGeneration++;
  error.value = '';
  query.value = '';
  results.value = [];
  state.value = kind === 'delete' ? { kind } : { kind, target: null };
  nextTick(() => {
    if (state.value.kind !== 'closed') dialog.value?.showModal();
  });
}
function onClose() {
  searchGeneration++;
  state.value = { kind: 'closed' };
  restoreFocus();
}
function onOutside(event: MouseEvent) {
  if (
    menuOpen.value &&
    event.target instanceof Node &&
    !menu.value?.contains(event.target) &&
    !panel.value?.contains(event.target)
  )
    closeMenu();
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
  if (event.key === 'Tab' || event.key === 'Escape') {
    if (event.key === 'Escape') event.preventDefault();
    closeMenu();
    restoreFocus();
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
  menuGeneration++;
  searchGeneration++;
  document.removeEventListener('mousedown', onOutside);
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('focusin', onFocus);
  document.removeEventListener('scroll', closeMenu, true);
  window.removeEventListener('resize', closeMenu);
});
watch(query, async (value) => {
  const generation = ++searchGeneration;
  const sourceId = source.value?.id;
  results.value = [];
  if (!value.trim() || state.value.kind !== 'merge') return;
  try {
    const response = await $fetch<{ data: { results: TagRef[] } }>(
      '/api/tags/search',
      { query: { q: value, limit: 20 } },
    );
    if (generation === searchGeneration && state.value.kind === 'merge')
      results.value = response.data.results.filter(
        (tag) => tag.id !== sourceId,
      );
  } catch {
    if (generation === searchGeneration && state.value.kind === 'merge')
      error.value = 'Could not search tags. Try again.';
  }
});
async function submit() {
  if (
    pending.value ||
    !source.value ||
    state.value.kind === 'closed' ||
    (state.value.kind === 'merge' && !state.value.target)
  )
    return;
  const sourceId = source.value.id;
  const target = state.value.kind === 'merge' ? state.value.target : null;
  pending.value = true;
  error.value = '';
  try {
    const path = `/api/tags/${encodeURIComponent(sourceId)}`;
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
      v-if="showTrigger && tag"
      ref="trigger"
      type="button"
      class="p-2 rounded-md hover:bg-(--sub-color)/20"
      :aria-label="`Actions for ${tag.name}`"
      :aria-expanded="menuOpen"
      aria-haspopup="menu"
      @click.stop="toggleMenu"
      @keydown.down.prevent="openTriggerMenu"
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
          class="w-full justify-start! px-3 py-2 text-left hover:bg-(--sub-color)/15"
          @click="openDialog('merge')"
        >
          Merge tag
        </button>
        <button
          type="button"
          role="menuitem"
          class="w-full justify-start! px-3 py-2 text-left hover:bg-(--sub-color)/15"
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
          Move all books tagged “{{ source?.name }}” to an existing tag across
          all collections. The destination tag stays and “{{ source?.name }}” is
          deleted. Books are not deleted.
        </p>
        <p v-else class="text-sm mb-4">
          Delete “{{ source?.name }}” from all books across all collections.
          Books are not deleted.
        </p>
        <div v-if="state.kind === 'merge'" class="space-y-2">
          <div
            role="group"
            aria-label="Tag merge preview"
            class="flex items-center gap-3 mb-4"
          >
            <div role="group" aria-label="From tag" class="flex-1 min-w-0">
              <div class="text-xs opacity-70 mb-1">From tag</div>
              <div
                class="border border-(--sub-color) rounded-md px-3 py-2 truncate"
              >
                {{ source?.name }}
              </div>
            </div>
            <Icon
              name="lucide:arrow-right"
              aria-hidden="true"
              class="mt-5 shrink-0"
            />
            <div role="group" aria-label="To tag" class="flex-1 min-w-0">
              <div class="text-xs opacity-70 mb-1">To tag</div>
              <div
                class="border border-(--sub-color) rounded-md px-3 py-2 truncate min-h-10"
              >
                {{ state.target?.name }}
              </div>
            </div>
          </div>
          <label :for="searchId" class="text-sm">Destination tag</label>
          <input
            :id="searchId"
            v-model="query"
            class="w-full px-3 py-2 rounded-md border border-(--sub-color) bg-(--bg-color)"
            placeholder="Search tags"
            :disabled="pending"
            @input="state.target = null"
          />
          <div v-if="!state.target" class="max-h-40 overflow-auto">
            <button
              v-for="result in results"
              :key="result.id"
              type="button"
              class="flex w-full justify-start! text-left px-3 py-2 hover:bg-(--sub-color)/15"
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
