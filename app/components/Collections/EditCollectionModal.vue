<script setup lang="ts">
import type {
  Collection,
  CollectionMember,
  MutableCollectionRole,
} from '~/stores/collections';

defineOptions({ name: 'EditCollectionModal' });

const { user } = useAuth();

const props = defineProps<{
  open: boolean;
  collection: Collection | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'saved', payload: { id: string; name: string }): void;
}>();

type FetchErrorLike = {
  data?: { message?: string };
  statusMessage?: string;
  message?: string;
};

const collectionsStore = useCollectionsStore();

const saving = ref(false);
const errorMessage = ref<string | null>(null);
const name = ref('');
const editingName = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
const actionsOpen = ref(false);
const confirmation = ref<'delete' | 'leave' | 'transfer' | null>(null);
const confirmationInput = ref<HTMLInputElement | HTMLButtonElement | null>(
  null,
);
const renameButton = ref<HTMLButtonElement | null>(null);
const actionsButton = ref<HTMLButtonElement | null>(null);
const statusMessage = ref('');
const dialog = ref<HTMLElement | null>(null);
let previousFocus: HTMLElement | null = null;

watch(
  () => props.open,
  async (open) => {
    if (open) {
      previousFocus = document.activeElement as HTMLElement | null;
      await nextTick();
      dialog.value?.focus();
    } else {
      previousFocus?.focus();
    }
  },
);

function trapFocus(event: KeyboardEvent) {
  if (event.key !== 'Tab') return;
  const controls = Array.from(
    dialog.value?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
    ) ?? [],
  );
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) {
    event.preventDefault();
    dialog.value?.focus();
  } else if (
    event.shiftKey &&
    (document.activeElement === first ||
      document.activeElement === dialog.value)
  ) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (document.activeElement === last || document.activeElement === dialog.value)
  ) {
    event.preventDefault();
    first.focus();
  }
}

const busy = computed(
  () =>
    saving.value ||
    deleting.value ||
    memberSaving.value ||
    leaving.value ||
    transferring.value,
);

async function editName() {
  if (busy.value) return;
  name.value = props.collection?.name ?? '';
  errorMessage.value = null;
  statusMessage.value = '';
  editingName.value = true;
  await nextTick();
  nameInput.value?.focus();
  nameInput.value?.select();
}

async function cancelName() {
  if (busy.value) return;
  editingName.value = false;
  name.value = props.collection?.name ?? '';
  errorMessage.value = null;
  await nextTick();
  renameButton.value?.focus();
}

async function showConfirmation(action: 'delete' | 'leave' | 'transfer') {
  if (busy.value) return;
  confirmation.value = action;
  deleteConfirmText.value = '';
  transferEmail.value = '';
  deleteErrorMessage.value = null;
  transferErrorMessage.value = null;
  leaveErrorMessage.value = null;
  await nextTick();
  confirmationInput.value?.focus();
}

async function cancelConfirmation() {
  if (busy.value) return;
  confirmation.value = null;
  await nextTick();
  actionsButton.value?.focus();
}

// Members / Sharing state (minimal v1)
type MemberRow = CollectionMember & { email?: string | null };
const membersLoading = ref(false);
const membersErrorMessage = ref<string | null>(null);
const members = ref<MemberRow[]>([]);

const addUserEmail = ref('');
const addRole = ref<MutableCollectionRole>('viewer');
const memberSaving = ref(false);

// Leave collection (self-remove) confirmation
const leaving = ref(false);
const leaveErrorMessage = ref<string | null>(null);

// Transfer ownership confirmation
const transferEmail = ref('');
const transferring = ref(false);
const transferErrorMessage = ref<string | null>(null);

// Deletion state
const deleteConfirmText = ref('');
const deleting = ref(false);
const deleteErrorMessage = ref<string | null>(null);

const canEdit = computed(() => {
  const c = props.collection;
  if (!c) return false;
  return collectionsStore.canEditCollection(c);
});

// Per requirements:
// - owner/editor can manage members
// - viewer cannot
const canManageMembers = computed(() => {
  const c = props.collection;
  if (!c) return false;
  return c.role === 'owner' || c.role === 'editor';
});

// Per requirements:
// - only owner can delete
// - never delete personal
const canDelete = computed(() => {
  const c = props.collection;
  if (!c) return false;
  if (c.isPersonal) return false;
  return c.role === 'owner';
});

const canTransferOwnership = computed(() => {
  const c = props.collection;
  if (!c) return false;
  if (c.isPersonal) return false;
  return c.role === 'owner';
});

const canLeave = computed(() => {
  const c = props.collection;
  if (!c) return false;
  if (c.isPersonal) return false;
  // Only non-owners can leave (owners must delete or transfer ownership)
  return c.role !== 'owner';
});

watch(
  () => props.open,
  async (open) => {
    if (!open) return;

    errorMessage.value = null;
    saving.value = false;
    name.value = props.collection?.name ?? '';

    // reset sharing/deletion UI state
    membersLoading.value = false;
    membersErrorMessage.value = null;
    members.value = [];
    addUserEmail.value = '';
    addRole.value = 'viewer';
    memberSaving.value = false;

    // reset leave/transfer/delete UI state
    confirmation.value = null;
    editingName.value = false;
    actionsOpen.value = false;
    statusMessage.value = '';
    leaving.value = false;
    leaveErrorMessage.value = null;

    transferEmail.value = '';
    transferring.value = false;
    transferErrorMessage.value = null;

    deleteConfirmText.value = '';
    deleting.value = false;
    deleteErrorMessage.value = null;

    // Load members for non-personal collections.
    // (Server permissions decide what you can see/do; UI gates for clarity.)
    const c = props.collection;
    if (!c) return;
    if (c.isPersonal) return;

    if (!canManageMembers.value) return;

    membersLoading.value = true;
    try {
      members.value = (await collectionsStore.fetchCollectionMembers(
        c.id,
      )) as MemberRow[];
    } catch (err: unknown) {
      const e = err as FetchErrorLike;
      membersErrorMessage.value =
        e?.data?.message ||
        e?.statusMessage ||
        e?.message ||
        'Failed to load members.';
    } finally {
      membersLoading.value = false;
    }
  },
);

async function save() {
  if (busy.value) return;

  const c = props.collection;
  if (!c) return;

  if (!canEdit.value) {
    errorMessage.value = 'You do not have permission to edit this collection.';
    return;
  }

  const trimmed = name.value.trim();
  if (!trimmed) {
    errorMessage.value = 'Collection name is required.';
    return;
  }

  saving.value = true;
  errorMessage.value = null;

  try {
    await collectionsStore.updateCollectionName(c.id, trimmed);

    // Ensure any other UI reading this list also sees the latest.
    await collectionsStore.fetchCollections();

    emit('saved', { id: c.id, name: trimmed });
    name.value = trimmed;
    editingName.value = false;
    statusMessage.value = 'Collection name saved.';
    await nextTick();
    renameButton.value?.focus();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    errorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to update collection.';
  } finally {
    saving.value = false;
  }
}

async function addOrUpdateMember() {
  if (busy.value) return;

  const c = props.collection;
  if (!c) return;

  if (c.isPersonal) {
    membersErrorMessage.value = 'Personal collections are not shareable.';
    return;
  }

  if (!canManageMembers.value) {
    membersErrorMessage.value = 'You do not have permission to manage members.';
    return;
  }

  const email = addUserEmail.value.trim().toLowerCase();
  if (!email) {
    membersErrorMessage.value = 'Email is required.';
    return;
  }

  memberSaving.value = true;
  membersErrorMessage.value = null;

  try {
    const updated = await collectionsStore.upsertCollectionMember({
      collectionId: c.id,
      email,
      role: addRole.value,
    });

    // Update local list by userId (stable identifier)
    const idx = members.value.findIndex((m) => m.userId === updated.userId);
    if (idx === -1) {
      members.value = [...members.value, { ...updated, email }];
    } else {
      members.value = [
        ...members.value.slice(0, idx),
        { ...members.value[idx]!, role: updated.role, email },
        ...members.value.slice(idx + 1),
      ];
    }

    addUserEmail.value = '';
    addRole.value = 'viewer';
    statusMessage.value = 'Member access saved.';
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    membersErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to update member.';
  } finally {
    memberSaving.value = false;
  }
}

async function removeMember(userId: string) {
  if (busy.value) return;

  const c = props.collection;
  if (!c) return;

  if (c.isPersonal) {
    membersErrorMessage.value = 'Personal collections are not shareable.';
    return;
  }

  if (!canManageMembers.value) {
    membersErrorMessage.value = 'You do not have permission to manage members.';
    return;
  }

  // Never allow removing the owner. Owners must transfer ownership or delete the collection.
  if (userId === c.ownerUserId) {
    membersErrorMessage.value =
      'You cannot remove the owner. Transfer ownership or delete the collection instead.';
    return;
  }

  // If the user clicks "Remove" on their own row (and they are not the owner), treat it as "Leave".
  // This is irreversible from the user's perspective, so we require confirmation.
  //
  // NOTE: We determine "self" by comparing the row email to the current session email.
  // Only do this if the user is allowed to leave (non-owner).
  const self = members.value.find((m) => m.userId === userId) ?? null;

  const myEmail = user.value?.email ?? null;

  const isSelfRow =
    canLeave.value &&
    Boolean(self?.email) &&
    Boolean(myEmail) &&
    self!.email!.trim().toLowerCase() === myEmail!.trim().toLowerCase();

  if (isSelfRow) {
    leaveErrorMessage.value = null;
    await showConfirmation('leave');
    return;
  }

  memberSaving.value = true;
  membersErrorMessage.value = null;

  try {
    await collectionsStore.removeCollectionMember({
      collectionId: c.id,
      userId,
    });

    members.value = members.value.filter((m) => m.userId !== userId);
    statusMessage.value = 'Member removed.';
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    membersErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to remove member.';
  } finally {
    memberSaving.value = false;
  }
}

async function deleteThisCollection() {
  if (busy.value) return;

  const c = props.collection;
  if (!c) return;

  deleteErrorMessage.value = null;

  if (c.isPersonal) {
    deleteErrorMessage.value = 'Personal collections cannot be deleted.';
    return;
  }

  if (!canDelete.value) {
    deleteErrorMessage.value =
      'You do not have permission to delete this collection.';
    return;
  }

  if (deleteConfirmText.value.trim() !== c.name.trim()) {
    deleteErrorMessage.value =
      'Confirmation text does not match the collection name.';
    return;
  }

  deleting.value = true;

  try {
    await collectionsStore.deleteCollection(c.id);

    // Ensure UI refresh
    await collectionsStore.fetchCollections();

    emit('close');
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    deleteErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to delete collection.';
  } finally {
    deleting.value = false;
  }
}

async function confirmLeave() {
  if (busy.value) return;

  const c = props.collection;
  if (!c) return;

  leaveErrorMessage.value = null;

  if (!canLeave.value) {
    leaveErrorMessage.value =
      'Owners cannot leave a collection. Transfer ownership or delete the collection instead.';
    return;
  }

  leaving.value = true;
  try {
    await collectionsStore.leaveCollection(c.id);
    // leaving removes your membership so this modal no longer applies
    emit('close');
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    leaveErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to leave collection.';
  } finally {
    leaving.value = false;
  }
}

async function confirmTransferOwnership() {
  if (busy.value) return;

  const c = props.collection;
  if (!c) return;

  transferErrorMessage.value = null;

  if (!canTransferOwnership.value) {
    transferErrorMessage.value =
      'You do not have permission to transfer ownership.';
    return;
  }

  const email = transferEmail.value.trim().toLowerCase();
  if (!email) {
    transferErrorMessage.value = 'Email is required.';
    return;
  }

  transferring.value = true;
  try {
    await collectionsStore.transferCollectionOwnership({
      collectionId: c.id,
      email,
    });

    // Refresh local modal state (permissions and member list likely changed)
    await collectionsStore.fetchCollections();
    members.value = (await collectionsStore.fetchCollectionMembers(
      c.id,
    )) as MemberRow[];

    confirmation.value = null;
    transferEmail.value = '';
    statusMessage.value = 'Ownership transferred. You are now an editor.';
    await nextTick();
    actionsButton.value?.focus();
  } catch (err: unknown) {
    const e = err as FetchErrorLike;
    transferErrorMessage.value =
      e?.data?.message ||
      e?.statusMessage ||
      e?.message ||
      'Failed to transfer ownership.';
  } finally {
    transferring.value = false;
  }
}

function close() {
  if (busy.value) return;
  if (confirmation.value) {
    void cancelConfirmation();
    return;
  }
  if (editingName.value) {
    void cancelName();
    return;
  }
  emit('close');
}
</script>

<template>
  <ModalWindow :open="open" @close="close">
    <div
      ref="dialog"
      tabindex="-1"
      role="dialog"
      aria-modal="true"
      aria-labelledby="collection-settings-title"
      class="flex flex-col gap-3 sm:w-95 max-w-[85vw] max-h-[80dvh] overflow-y-auto"
      @keydown="trapFocus"
    >
      <div class="flex items-start justify-between gap-4">
        <div id="collection-settings-title" class="text-lg font-semibold">
          {{
            confirmation === 'delete'
              ? 'Delete collection'
              : confirmation === 'leave'
                ? 'Leave collection'
                : confirmation === 'transfer'
                  ? 'Transfer ownership'
                  : 'Collection settings'
          }}
        </div>
        <button
          type="button"
          aria-label="Close collection settings"
          class="shrink-0 opacity-80 hover:opacity-100"
          :disabled="busy"
          @click="close"
        >
          <Icon name="lucide:x" class="text-xl" />
        </button>
      </div>

      <template v-if="confirmation">
        <template v-if="confirmation === 'delete'">
          <p class="text-sm">
            Deleting <strong>{{ collection?.name }}</strong> removes the
            collection for all members. Books are not deleted; only the
            collection and its links are removed.
          </p>
          <div class="space-y-2">
            <label for="collection-delete-name" class="block text-sm"
              >Type <strong>{{ collection?.name }}</strong> to confirm
              deletion.</label
            >
            <input
              id="collection-delete-name"
              ref="confirmationInput"
              v-model="deleteConfirmText"
              type="text"
              autocomplete="off"
              class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
              :disabled="busy"
            />
            <p
              v-if="deleteErrorMessage"
              role="alert"
              class="text-sm text-(--error-color)"
            >
              {{ deleteErrorMessage }}
            </p>
          </div>
        </template>
        <template v-else-if="confirmation === 'transfer'">
          <p class="text-sm">
            The new owner will become the sole owner of
            <strong>{{ collection?.name }}</strong
            >, and you will become an editor. Only the new owner can transfer
            ownership back to you.
          </p>
          <div class="space-y-2">
            <label for="collection-transfer-email" class="block text-sm"
              >New owner email</label
            >
            <input
              id="collection-transfer-email"
              ref="confirmationInput"
              v-model="transferEmail"
              type="email"
              class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
              :disabled="busy"
            />
            <p
              v-if="transferErrorMessage"
              role="alert"
              class="text-sm text-(--error-color)"
            >
              {{ transferErrorMessage }}
            </p>
          </div>
        </template>
        <template v-else>
          <p class="text-sm">
            Leaving <strong>{{ collection?.name }}</strong> removes your access.
            An owner or editor can add you again later.
          </p>
          <p
            v-if="leaveErrorMessage"
            role="alert"
            class="text-sm text-(--error-color)"
          >
            {{ leaveErrorMessage }}
          </p>
        </template>
        <div class="flex justify-end gap-2">
          <button
            v-if="confirmation === 'leave'"
            ref="confirmationInput"
            type="button"
            class="px-3 py-2"
            :disabled="busy"
            @click="cancelConfirmation"
          >
            Cancel
          </button>
          <button
            v-else
            type="button"
            class="px-3 py-2"
            :disabled="busy"
            @click="cancelConfirmation"
          >
            Cancel
          </button>
          <button
            v-if="confirmation === 'delete'"
            type="button"
            class="px-3 py-2 rounded-md bg-(--error-color) text-(--text-color)"
            :disabled="
              busy ||
              !collection ||
              deleteConfirmText.trim() !== collection.name.trim()
            "
            @click="deleteThisCollection"
          >
            {{ deleting ? 'Deleting…' : 'Delete collection' }}
          </button>
          <button
            v-else-if="confirmation === 'transfer'"
            type="button"
            class="px-3 py-2 rounded-md bg-(--error-color) text-(--text-color)"
            :disabled="busy || !transferEmail.trim()"
            @click="confirmTransferOwnership"
          >
            {{ transferring ? 'Transferring…' : 'Transfer ownership' }}
          </button>
          <button
            v-else
            type="button"
            class="px-3 py-2 rounded-md bg-(--error-color) text-(--text-color)"
            :disabled="busy"
            @click="confirmLeave"
          >
            {{ leaving ? 'Leaving…' : 'Leave collection' }}
          </button>
        </div>
      </template>

      <template v-else>
        <section class="space-y-2" aria-label="Collection name">
          <form v-if="editingName" class="space-y-2" @submit.prevent="save">
            <label for="collection-name" class="block text-sm font-semibold"
              >Collection name</label
            >
            <input
              id="collection-name"
              ref="nameInput"
              v-model="name"
              type="text"
              class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
              :disabled="busy"
            />
            <p
              v-if="errorMessage"
              role="alert"
              class="text-sm text-(--error-color)"
            >
              {{ errorMessage }}
            </p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="px-3 py-2"
                :disabled="busy"
                @click="cancelName"
              >
                Cancel
              </button>
              <button
                type="submit"
                class="px-3 py-2 rounded-md bg-(--main-color) text-(--bg-color)"
                :disabled="
                  busy || !name.trim() || name.trim() === collection?.name
                "
              >
                {{ saving ? 'Saving…' : 'Save name' }}
              </button>
            </div>
          </form>
          <div v-else class="flex items-center gap-2">
            <div class="text-lg font-semibold break-words min-w-0">
              {{ collection?.name }}
            </div>
            <button
              v-if="canEdit"
              ref="renameButton"
              v-tooltip="'Rename collection'"
              type="button"
              aria-label="Rename collection"
              class="p-2 shrink-0 opacity-80 hover:opacity-100"
              :disabled="busy"
              @click="editName"
            >
              <Icon name="lucide:pencil" />
            </button>
          </div>
          <p v-if="collection?.isPersonal" class="text-sm opacity-70">
            Your personal collection receives uploads by default. It cannot be
            shared or deleted.
          </p>
        </section>

        <section
          v-if="collection && !collection.isPersonal"
          class="space-y-2 border-t border-(--sub-color) pt-3"
          aria-labelledby="collection-sharing-title"
        >
          <div>
            <div id="collection-sharing-title" class="text-sm font-semibold">
              Sharing
            </div>
            <p class="text-xs opacity-70">
              Changes to member access are saved immediately.
            </p>
          </div>
          <template v-if="canManageMembers">
            <form class="space-y-2" @submit.prevent="addOrUpdateMember">
              <label for="collection-member-email" class="block text-sm"
                >Add or update a member by email</label
              >
              <input
                id="collection-member-email"
                v-model="addUserEmail"
                type="email"
                placeholder="Email address"
                class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
                :disabled="busy || membersLoading || editingName"
              />
              <div class="flex items-center gap-2">
                <label for="collection-member-role" class="text-sm"
                  >Access</label
                >
                <select
                  id="collection-member-role"
                  v-model="addRole"
                  class="px-3 py-2 border rounded-md bg-(--bg-color)"
                  :disabled="busy || membersLoading || editingName"
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                </select>
                <button
                  type="submit"
                  class="ml-auto px-3 py-2 rounded-md bg-(--main-color) text-(--bg-color)"
                  :disabled="
                    busy ||
                    membersLoading ||
                    editingName ||
                    !addUserEmail.trim()
                  "
                >
                  {{ memberSaving ? 'Saving…' : 'Save access' }}
                </button>
              </div>
            </form>
            <p
              v-if="membersErrorMessage"
              role="alert"
              class="text-sm text-(--error-color)"
            >
              {{ membersErrorMessage }}
            </p>
            <p v-if="membersLoading" class="text-sm opacity-70">
              Loading members…
            </p>
            <p
              v-else-if="!members.length && !membersErrorMessage"
              class="text-sm opacity-70"
            >
              No members yet.
            </p>
            <ul v-else class="space-y-2">
              <li
                v-for="m in members"
                :key="m.userId"
                class="flex items-center justify-between gap-3 border rounded-md px-3 py-2"
              >
                <div class="min-w-0">
                  <div class="text-sm break-all">{{ m.email || m.userId }}</div>
                  <div class="text-xs opacity-70 capitalize">{{ m.role }}</div>
                </div>
                <button
                  v-if="m.role !== 'owner'"
                  type="button"
                  class="px-3 py-1.5 shrink-0 border rounded-md"
                  :aria-label="`Remove ${m.email || m.userId}`"
                  :disabled="busy || editingName"
                  @click="removeMember(m.userId)"
                >
                  Remove
                </button>
              </li>
            </ul>
          </template>
          <p v-else class="text-sm opacity-70">
            You have viewer access. Owners and editors can manage members.
          </p>
        </section>

        <section
          v-if="canDelete || canTransferOwnership || canLeave"
          class="border-t border-(--sub-color) pt-3 space-y-2"
        >
          <button
            ref="actionsButton"
            type="button"
            class="flex items-center justify-between w-full py-1 text-sm font-semibold"
            :aria-expanded="actionsOpen"
            aria-controls="collection-actions"
            :disabled="busy || editingName"
            @click="actionsOpen = !actionsOpen"
          >
            Collection actions<Icon
              :name="actionsOpen ? 'lucide:chevron-up' : 'lucide:chevron-down'"
            />
          </button>
          <div
            v-if="actionsOpen"
            id="collection-actions"
            class="flex flex-col items-start gap-1"
          >
            <button
              v-if="canTransferOwnership"
              type="button"
              class="px-2 py-2 text-sm"
              :disabled="busy"
              @click="showConfirmation('transfer')"
            >
              Transfer ownership
            </button>
            <button
              v-if="canLeave"
              type="button"
              class="px-2 py-2 text-sm"
              :disabled="busy"
              @click="showConfirmation('leave')"
            >
              Leave collection
            </button>
            <button
              v-if="canDelete"
              type="button"
              class="flex items-center gap-2 px-2 py-2 text-sm text-(--error-color)"
              :disabled="busy"
              @click="showConfirmation('delete')"
            >
              <Icon name="lucide:trash-2" />Delete collection
            </button>
          </div>
        </section>
        <p role="status" aria-live="polite" class="text-sm opacity-80">
          {{ statusMessage }}
        </p>
        <div class="flex justify-end">
          <button
            type="button"
            class="px-3 py-2 border rounded-md"
            :disabled="busy || editingName"
            @click="close"
          >
            Done
          </button>
        </div>
      </template>
    </div>
  </ModalWindow>
</template>
