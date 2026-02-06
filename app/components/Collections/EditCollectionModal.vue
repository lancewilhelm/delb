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

// Members / Sharing state (minimal v1)
type MemberRow = CollectionMember & { email?: string | null };
const membersLoading = ref(false);
const membersErrorMessage = ref<string | null>(null);
const members = ref<MemberRow[]>([]);

const addUserEmail = ref('');
const addRole = ref<MutableCollectionRole>('viewer');
const memberSaving = ref(false);

// Leave collection (self-remove) confirmation
const leaveConfirmOpen = ref(false);
const leaving = ref(false);
const leaveErrorMessage = ref<string | null>(null);

// Transfer ownership confirmation
const transferEmail = ref('');
const transferConfirmOpen = ref(false);
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
    leaveConfirmOpen.value = false;
    leaving.value = false;
    leaveErrorMessage.value = null;

    transferEmail.value = '';
    transferConfirmOpen.value = false;
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

const title = computed(() => {
  if (props.collection?.isPersonal) return 'Edit Personal collection';
  return 'Edit collection';
});

const subtitle = computed(() => {
  if (props.collection?.isPersonal) {
    return 'This is your default collection. All uploads go here by default.';
  }
  return 'Update your collection name, members, and settings.';
});

async function save() {
  if (saving.value) return;

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
    emit('close');
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
  if (memberSaving.value) return;

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
  if (memberSaving.value) return;

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
    leaveConfirmOpen.value = true;
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
  if (deleting.value) return;

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
  if (leaving.value) return;

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
  if (transferring.value) return;

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

    transferConfirmOpen.value = false;
    transferEmail.value = '';
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
  if (
    saving.value ||
    deleting.value ||
    memberSaving.value ||
    leaving.value ||
    transferring.value
  )
    return;
  emit('close');
}
</script>

<template>
  <ModalWindow :open="open" @close="close">
    <div class="flex flex-col gap-4 w-110 max-w-[90vw]">
      <div class="flex items-start justify-between gap-4">
        <div>
          <div class="text-lg font-semibold">{{ title }}</div>
          <div class="text-sm opacity-80">
            {{ subtitle }}
          </div>
        </div>

        <Icon
          v-tooltip="'Close'"
          name="lucide:x"
          class="scale-150 cursor-pointer opacity-80 hover:opacity-100"
          @click="close"
        />
      </div>

      <div v-if="collection?.isPersonal" class="text-xs opacity-70">
        <div class="flex items-center gap-2">
          <span
            class="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border border-(--sub-color) opacity-70"
          >
            Personal
          </span>
          <span>Non-deletable and not shareable.</span>
        </div>
      </div>

      <!-- Rename -->
      <div class="space-y-2">
        <div class="text-sm font-semibold">Name</div>

        <input
          v-model="name"
          type="text"
          placeholder="Collection name…"
          class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
          :disabled="saving || !canEdit"
          @keyup.enter="save"
        />

        <p v-if="!canEdit" class="text-sm text-(--error-color)">
          You do not have permission to edit this collection.
        </p>

        <p v-else-if="errorMessage" class="text-sm text-(--error-color)">
          {{ errorMessage }}
        </p>

        <div class="flex gap-2 justify-end">
          <button
            v-tooltip="'Cancel'"
            class="px-3 py-2"
            :disabled="saving"
            @click="close"
          >
            Cancel
          </button>

          <button
            v-tooltip="'Save changes'"
            class="px-3 py-2 bg-(--main-color) text-(--bg-color)"
            :disabled="saving || !canEdit || !name.trim()"
            @click="save"
          >
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
        </div>
      </div>

      <!-- Sharing / Members -->
      <div v-if="collection && !collection.isPersonal" class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          <div class="text-sm font-semibold">Sharing</div>
          <div v-if="!canManageMembers" class="text-xs opacity-70">
            Owners and editors can manage members.
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2">
          <button
            class="px-3 py-2 border rounded-md"
            :disabled="!canLeave || leaving || memberSaving || deleting"
            @click="leaveConfirmOpen = true"
          >
            Leave collection
          </button>

          <button
            v-if="canTransferOwnership"
            class="px-3 py-2 border rounded-md"
            :disabled="transferring || memberSaving || deleting"
            @click="transferConfirmOpen = true"
          >
            Transfer ownership
          </button>
        </div>

        <!-- Leave confirmation -->
        <div v-if="leaveConfirmOpen" class="border rounded-md p-3 space-y-2">
          <div class="text-sm font-semibold">Leave collection</div>
          <div class="text-sm opacity-80">
            This will remove your access to this collection. This can be
            re-granted later by an owner/editor.
          </div>

          <p v-if="leaveErrorMessage" class="text-sm text-(--error-color)">
            {{ leaveErrorMessage }}
          </p>

          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-2"
              :disabled="leaving"
              @click="leaveConfirmOpen = false"
            >
              Cancel
            </button>
            <button
              class="px-3 py-2 bg-(--error-color) text-(--text-color)"
              :disabled="leaving"
              @click="confirmLeave"
            >
              {{ leaving ? 'Leaving…' : 'Leave' }}
            </button>
          </div>
        </div>

        <!-- Transfer ownership confirmation -->
        <div v-if="transferConfirmOpen" class="border rounded-md p-3 space-y-2">
          <div class="text-sm font-semibold">Transfer ownership</div>
          <div class="text-sm opacity-80">
            Transferring ownership is irreversible from your perspective. The
            new owner will become the sole owner, and you will become an editor.
          </div>

          <input
            v-model="transferEmail"
            type="email"
            placeholder="New owner email…"
            class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
            :disabled="transferring"
          />

          <p v-if="transferErrorMessage" class="text-sm text-(--error-color)">
            {{ transferErrorMessage }}
          </p>

          <div class="flex justify-end gap-2">
            <button
              class="px-3 py-2"
              :disabled="transferring"
              @click="transferConfirmOpen = false"
            >
              Cancel
            </button>
            <button
              class="px-3 py-2 bg-(--error-color) text-(--text-color)"
              :disabled="transferring || !transferEmail.trim()"
              @click="confirmTransferOwnership"
            >
              {{ transferring ? 'Transferring…' : 'Transfer ownership' }}
            </button>
          </div>
        </div>

        <div
          v-if="canManageMembers"
          class="flex flex-col gap-2 border rounded-md p-3 bg-(--bg-color)"
        >
          <div class="text-xs opacity-70">Add a member by email</div>

          <div class="flex flex-wrap items-center gap-2">
            <input
              v-model="addUserEmail"
              type="email"
              placeholder="Email…"
              class="flex-1 min-w-55 px-3 py-2 border rounded-md bg-(--bg-color)"
              :disabled="membersLoading || memberSaving || deleting"
              @keyup.enter="addOrUpdateMember"
            />

            <select
              v-model="addRole"
              class="px-3 py-2 border rounded-md bg-(--bg-color)"
              :disabled="membersLoading || memberSaving || deleting"
            >
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
            </select>

            <button
              class="px-3 py-2 bg-(--main-color) text-(--bg-color)"
              :disabled="
                membersLoading ||
                memberSaving ||
                deleting ||
                !addUserEmail.trim()
              "
              @click="addOrUpdateMember"
            >
              {{ memberSaving ? 'Saving…' : 'Add / Update' }}
            </button>
          </div>

          <p v-if="membersErrorMessage" class="text-sm text-(--error-color)">
            {{ membersErrorMessage }}
          </p>

          <div v-if="membersLoading" class="text-sm opacity-70">
            Loading members…
          </div>

          <div v-else-if="!members.length" class="text-sm opacity-70">
            No members yet.
          </div>

          <div v-else class="space-y-2">
            <div
              v-for="m in members"
              :key="m.userId"
              class="flex items-center justify-between gap-3 border rounded-md px-3 py-2"
            >
              <div class="min-w-0">
                <div class="text-sm font-mono truncate">
                  {{ m.email || m.userId }}
                </div>
                <div class="text-xs opacity-70">role: {{ m.role }}</div>
              </div>

              <button
                class="px-3 py-1.5 border rounded-md"
                :class="m.role === 'owner' ? 'hidden!' : ''"
                :disabled="memberSaving || deleting || m.role === 'owner'"
                @click="removeMember(m.userId)"
              >
                Remove
              </button>
            </div>

            <div class="text-xs opacity-70">
              Note: you cannot remove the owner. Delete the collection or
              transfer ownership.
            </div>
          </div>
        </div>

        <div v-else class="text-sm opacity-70">
          You can view this collection, but cannot manage members.
        </div>
      </div>

      <!-- Delete -->
      <div
        v-if="canDelete && collection && !collection.isPersonal"
        class="space-y-2"
      >
        <div class="text-sm font-semibold text-(--error-color)">
          Delete collection
        </div>

        <div class="text-xs opacity-70">
          Deleting a collection removes it for all members. Books are not
          deleted; only the collection and its links are removed.
        </div>

        <div class="border border-(--error-color)/50 rounded-md p-3 space-y-2">
          <div class="text-sm">
            Type the collection name to confirm deletion:
            <span class="font-semibold">{{ collection.name }}</span>
          </div>

          <input
            v-model="deleteConfirmText"
            type="text"
            class="w-full px-3 py-2 border rounded-md bg-(--bg-color)"
            :disabled="deleting || saving || memberSaving"
            placeholder="Collection name…"
          />

          <p v-if="deleteErrorMessage" class="text-sm text-(--error-color)">
            {{ deleteErrorMessage }}
          </p>

          <div class="flex justify-end">
            <button
              class="px-3 py-2 bg-(--error-color) text-(--text-color)"
              :disabled="
                deleting ||
                saving ||
                memberSaving ||
                deleteConfirmText.trim() !== collection.name.trim()
              "
              @click="deleteThisCollection"
            >
              {{ deleting ? 'Deleting…' : 'Delete collection' }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </ModalWindow>
</template>
