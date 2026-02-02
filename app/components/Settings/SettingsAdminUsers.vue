<script setup lang="ts">
import type { UserWithRole } from 'better-auth/plugins';

const users = ref<UserWithRole[]>([]);
const sortedUsers = ref<UserWithRole[]>([]);

const globalSettingsStore = useGlobalSettingsStore();

type EditableRole = 'admin' | 'user';

// Fetch users data
const fetchUsers = async () => {
  const { admin } = useAuth();
  const { data, error } = await admin.listUsers({ query: { limit: 100 } });

  if (error) {
    const msg =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? 'Unknown error')
        : String(error ?? 'Unknown error');
    logger.error(`Error fetching users: ${msg}`);
    return;
  }

  users.value = data?.users || [];
  // Sort users by createdAt date (newest first)
  sortedUsers.value = [...users.value].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
};

// Call fetchUsers on component mount
onMounted(fetchUsers);

const allowRegistration = computed({
  get: () => globalSettingsStore.settings.allowRegistration,
  set: async (value) => {
    await globalSettingsStore.updateSettings({
      allowRegistration: value,
    });

    // Then re-pull the canonical server settings so the UI reflects what was persisted.
    await globalSettingsStore.pullLatest();
  },
});

// Create user handlers
const createUserModalVisible = ref(false);
const newUserName = ref('');
const newUserEmail = ref('');
const newUserPassword = ref('');
const newUserRole = ref<'admin' | 'user'>('user');
const createUserEmailInput = ref<HTMLInputElement | null>(null);
async function createUser() {
  if (
    !newUserName.value.trim() ||
    !newUserEmail.value ||
    !newUserPassword.value
  ) {
    alert('Please fill in all fields');
    return;
  }

  const { admin } = useAuth();
  const { error } = await admin.createUser({
    email: newUserEmail.value,
    password: newUserPassword.value,
    role: newUserRole.value,
    name: newUserName.value.trim(),
  });

  if (error) {
    alert(`Error creating user: ${error.message}`);
    return;
  }

  // Reset the form
  newUserName.value = '';
  newUserEmail.value = '';
  newUserPassword.value = '';
  newUserRole.value = 'user';
  createUserModalVisible.value = false;

  // Refetch users to update the list
  await fetchUsers();
}

// Delete user handlers
const deleteUserModalVisible = ref(false);
const deleteUserEmail = ref('');
const deleteUserEmailConfirmation = ref('');
const deleteUserEmailConfirmationRef = ref<HTMLInputElement | null>(null);
const deleteUserId = ref('');
async function deleteUser() {
  if (deleteUserEmailConfirmation.value !== deleteUserEmail.value) {
    alert('Email confirmation does not match');
    return;
  }

  const { admin } = useAuth();
  const { error } = await admin.removeUser({
    userId: deleteUserId.value,
  });

  if (error) {
    alert(`Error deleting user: ${error.message}`);
    return;
  }

  // Reset the form
  deleteUserModalVisible.value = false;
  deleteUserEmailConfirmation.value = '';
  deleteUserEmail.value = '';
  deleteUserId.value = '';

  // Refetch users to update the list
  await fetchUsers();
}

// Ban user handlers
const banUserModalVisible = ref(false);
const banUserEmail = ref('');
const banUserId = ref('');
async function banUser() {
  const { admin } = useAuth();
  const { error } = await admin.banUser({
    userId: banUserId.value,
  });
  if (error) {
    alert(`Error banning user: ${error.message}`);
    return;
  }
  // Reset the form
  banUserModalVisible.value = false;
  banUserEmail.value = '';
  banUserId.value = '';

  // Refetch users to update the list
  await fetchUsers();
}
async function unbanUser(userId: string) {
  const { admin } = useAuth();
  const { error } = await admin.unbanUser({
    userId,
  });
  if (error) {
    alert(`Error unbanning user: ${error.message}`);
    return;
  }

  // Refetch users to update the list
  await fetchUsers();
}

function canEditUser(user: UserWithRole) {
  const { user: currentUser } = useAuth();
  if (!currentUser.value) return false;
  if (user.id === currentUser.value.id) return false; // Can't edit self
  if (user.role === 'admin' && currentUser.value.role !== 'owner') return false; // Can't edit admin if not owner
  if (user.role === 'owner') return false; // Can't edit owner
  return true;
}

// Edit user handlers
const editUserModalVisible = ref(false);
const editUserOriginal = ref<UserWithRole | null>(null);
const editUserId = ref('');
const editUserName = ref('');
const editUserEmail = ref('');
const editUserRole = ref<EditableRole>('user');
const editUserNewPassword = ref('');
const editUserSaving = ref(false);
const editUserPasswordSaving = ref(false);
const editUserEmailInput = ref<HTMLInputElement | null>(null);

function openEditUser(user: UserWithRole) {
  if (!canEditUser(user)) return;
  editUserOriginal.value = user;
  editUserId.value = user.id;
  editUserName.value = (user.name ?? '').toString();
  editUserEmail.value = (user.email ?? '').toString();
  editUserRole.value = user.role === 'admin' ? 'admin' : 'user';
  editUserNewPassword.value = '';
  editUserModalVisible.value = true;
  nextTick(() => {
    editUserEmailInput.value?.focus();
  });
}

function closeEditUser() {
  editUserModalVisible.value = false;
  editUserOriginal.value = null;
  editUserId.value = '';
  editUserName.value = '';
  editUserEmail.value = '';
  editUserRole.value = 'user';
  editUserNewPassword.value = '';
  editUserSaving.value = false;
  editUserPasswordSaving.value = false;
}

function generatePassword(length = 16) {
  const charset =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*-_=+';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => charset[b % charset.length]).join('');
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function showAlert(message: string) {
  alert(message);
}

async function saveUserEdits() {
  if (!editUserOriginal.value || !editUserId.value) return;

  const name = editUserName.value.trim();
  const email = editUserEmail.value.trim().toLowerCase();

  if (!name) {
    alert('Please provide a name');
    return;
  }
  if (!email) {
    alert('Please provide an email');
    return;
  }

  const data: Record<string, unknown> = {};
  if ((editUserOriginal.value.name ?? '') !== name) data.name = name;
  if ((editUserOriginal.value.email ?? '') !== email) data.email = email;
  if ((editUserOriginal.value.role ?? 'user') !== editUserRole.value)
    data.role = editUserRole.value;

  if (Object.keys(data).length === 0) {
    alert('No changes to save');
    return;
  }

  editUserSaving.value = true;
  try {
    const { admin } = useAuth();
    const { error } = await admin.updateUser({
      userId: editUserId.value,
      data,
    });
    if (error) {
      alert(`Error updating user: ${error.message}`);
      return;
    }
    closeEditUser();
    await fetchUsers();
  } finally {
    editUserSaving.value = false;
  }
}

async function setUserPassword() {
  if (!editUserId.value) return;
  const newPassword = editUserNewPassword.value;
  if (!newPassword) {
    alert('Please provide a new password');
    return;
  }

  editUserPasswordSaving.value = true;
  try {
    const { admin } = useAuth();
    const { error } = await admin.setUserPassword({
      userId: editUserId.value,
      newPassword,
    });
    if (error) {
      alert(`Error setting password: ${error.message}`);
      return;
    }
    alert('Password updated. Be sure to share it securely with the user.');
    editUserNewPassword.value = '';
  } finally {
    editUserPasswordSaving.value = false;
  }
}
</script>

<template>
  <div class="w-full">
    <SettingsUIGroup title="Users" icon="lucide:users">
      <div class="w-full mt-4 overflow-x-auto">
        <table class="min-w-full">
          <thead class="bg-(--sub-color) text-(--main-color)">
            <tr>
              <th scope="col" class="px-6 py-1 text-left font-medium">email</th>
              <th scope="col" class="px-6 py-1 text-left font-medium">name</th>
              <th scope="col" class="px-6 py-1 text-left font-medium">role</th>
              <th scope="col" class="px-6 py-1 text-left font-medium">
                date created
              </th>
              <th scope="col" class="px-6 py-1 text-left font-medium w-37.5">
                actions
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--sub-color) text-(--text-color)">
            <template v-if="sortedUsers.length > 0">
              <tr v-for="u in sortedUsers" :key="u.id" class="h-10">
                <td class="px-6 py-1 whitespace-nowrap text-sm">
                  {{ u.email }}
                </td>
                <td class="px-6 py-1 whitespace-nowrap text-sm">
                  {{ u.name }}
                </td>
                <td class="px-6 py-1 whitespace-nowrap text-sm">
                  {{ u.role }}
                </td>
                <td class="px-6 py-1 whitespace-nowrap text-sm">
                  {{ new Date(u.createdAt).toLocaleDateString() }}
                </td>
                <td class="px-6 py-1 whitespace-nowrap text-sm">
                  <div v-if="canEditUser(u)" class="flex gap-2">
                    <button
                      class="flex items-center bg-(--sub-alt-color) p-2 rounded-lg text-(--text-color)"
                      @click="() => openEditUser(u)"
                    >
                      <Icon
                        name="lucide:user-pen"
                        class="text-(--text-color) scale-125"
                      />
                    </button>
                    <button
                      class="flex items-center p-2 rounded-lg text-(--bg-color)"
                      :class="[
                        u.banned ? 'bg-(--main-color)!' : 'bg-(--error-color)!',
                      ]"
                      @click="
                        () => {
                          if (u.banned) {
                            unbanUser(u.id);
                          } else {
                            banUserModalVisible = true;
                            banUserEmail = u.email;
                            banUserId = u.id;
                          }
                        }
                      "
                    >
                      <Icon
                        v-if="!u.banned"
                        name="lucide:pause"
                        class="text-(--bg-color) scale-125"
                      />
                      <Icon
                        v-else
                        name="lucide:play"
                        class="text-(--bg-color) scale-125"
                      />
                    </button>
                    <button
                      class="flex items-center bg-(--error-color)! p-2 rounded-lg text-(--bg-color)"
                      @click="
                        () => {
                          deleteUserModalVisible = true;
                          deleteUserEmail = u.email;
                          deleteUserId = u.id;
                          nextTick(() => {
                            deleteUserEmailConfirmationRef?.focus();
                          });
                        }
                      "
                    >
                      <Icon
                        name="lucide:trash-2"
                        class="text-(--bg-color) scale-125"
                      />
                    </button>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-else>
              <td colspan="5" class="px-6 py-4 text-center text-sm">
                Loading users...
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="w-full flex justify-center">
        <button
          class="flex items-center gap-2 mt-4 bg-(--main-color)! text-(--bg-color)! p-2 rounded-lg px-4 cursor-pointer"
          @click="
            () => {
              createUserModalVisible = true;
              nextTick(() => {
                createUserEmailInput?.focus();
              });
            }
          "
        >
          <Icon name="lucide:user-plus" class="text-(--bg-color) scale-125" />
          add user
        </button>
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup title="Allow Registration" icon="lucide:lock">
      <SettingsUIToggle
        v-model="allowRegistration"
        description="allow users to register themselves at /register"
      />
    </SettingsUIGroup>

    <!-- Create User Modal -->
    <ModalWindow
      :open="createUserModalVisible"
      @close="createUserModalVisible = false"
    >
      <div class="flex flex-col gap-4 items-center">
        <div class="text-(--main-color) text-lg self-start">
          create new user
        </div>
        <div class="flex flex-col gap-2 w-62.5">
          <input
            v-model="newUserName"
            type="text"
            placeholder="name"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            @keyup.enter="createUser"
          />
          <input
            ref="createUserEmailInput"
            v-model="newUserEmail"
            type="email"
            placeholder="email"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            @keyup.enter="createUser"
          />
          <input
            v-model="newUserPassword"
            type="password"
            placeholder="password"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            @keyup.enter="createUser"
          />
          <select
            v-model="newUserRole"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <button
          class="bg-(--main-color) text-(--bg-color) p-2 rounded-lg"
          @click="createUser"
        >
          create
        </button>
      </div>
    </ModalWindow>

    <!-- Delete User Modal -->
    <ModalWindow
      :open="deleteUserModalVisible"
      @close="
        () => {
          deleteUserModalVisible = false;
          deleteUserEmailConfirmation = '';
        }
      "
    >
      <div class="flex flex-col items-center justify-center gap-2">
        <div class="text-(--text-color) text-lg text-center">
          Are you sure you want to delete {{ deleteUserEmail }}? This action
          cannot be undone.
        </div>
        <div class="text-(--text-color) text-lg text-center">
          If you are sure, please type their email below.
        </div>
        <input
          ref="deleteUserEmailConfirmationRef"
          v-model="deleteUserEmailConfirmation"
          type="email"
          placeholder="user email"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          @keyup.enter="deleteUser"
        />
        <button
          :class="[
            'flex items-center gap-2 mt-2 bg-(--main-color) text-(--bg-color) p-2 rounded-lg px-4',
            deleteUserEmailConfirmation === deleteUserEmail
              ? 'opacity-100 cursor-pointer'
              : 'opacity-50 cursor-default',
          ]"
          :disabled="deleteUserEmailConfirmation !== deleteUserEmail"
          @click="deleteUser"
        >
          delete account
        </button>
      </div>
    </ModalWindow>

    <!-- Ban User Modal -->
    <ModalWindow
      :open="banUserModalVisible"
      @close="
        () => {
          banUserModalVisible = false;
        }
      "
    >
      <div class="flex flex-col items-center justify-center gap-2">
        <div class="text-(--text-color) text-lg text-center">
          Are you sure you want to ban {{ banUserEmail }}?
        </div>
        <div class="flex gap-2">
          <button
            class="flex items-center gap-2 mt-2 bg-(--error-color) text-(--bg-color) p-2 rounded-lg px-4"
            @click="banUser"
          >
            ban
          </button>
          <button
            class="flex items-center gap-2 mt-2 bg-(--main-color) text-(--bg-color) p-2 rounded-lg px-4"
            @click="banUserModalVisible = false"
          >
            cancel
          </button>
        </div>
      </div>
    </ModalWindow>

    <!-- Edit User Modal -->
    <ModalWindow :open="editUserModalVisible" @close="closeEditUser">
      <div class="flex flex-col gap-4 items-center">
        <div class="text-(--main-color) text-lg self-start">edit user</div>

        <div class="flex flex-col gap-2 w-62.5">
          <input
            v-model="editUserName"
            type="text"
            placeholder="name"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="editUserSaving"
            @keyup.enter="saveUserEdits"
          />
          <input
            ref="editUserEmailInput"
            v-model="editUserEmail"
            type="email"
            placeholder="email"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="editUserSaving"
            @keyup.enter="saveUserEdits"
          />
          <select
            v-model="editUserRole"
            class="w-full p-2 border border-(--sub-color) rounded-lg"
            :disabled="editUserSaving"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </div>

        <div class="w-full border-t border-(--sub-color) pt-4">
          <div class="text-(--text-color) text-sm mb-2">password reset</div>
          <div class="flex flex-col gap-2 w-62.5">
            <input
              v-model="editUserNewPassword"
              type="text"
              placeholder="new password"
              class="w-full p-2 border border-(--sub-color) rounded-lg"
              :disabled="editUserPasswordSaving"
              @keyup.enter="setUserPassword"
            />
            <div class="flex gap-2">
              <button
                class="flex-1 bg-(--sub-alt-color) text-(--text-color) p-2 rounded-lg"
                :disabled="editUserPasswordSaving"
                @click="
                  () => {
                    editUserNewPassword = generatePassword(18);
                  }
                "
              >
                generate
              </button>
              <button
                class="flex-1 bg-(--sub-alt-color) text-(--text-color) p-2 rounded-lg"
                :disabled="!editUserNewPassword || editUserPasswordSaving"
                @click="
                  async () => {
                    const ok = await copyToClipboard(editUserNewPassword);
                    if (!ok) showAlert('Failed to copy to clipboard');
                  }
                "
              >
                copy
              </button>
            </div>
            <button
              class="bg-(--error-color) text-(--bg-color) p-2 rounded-lg"
              :disabled="!editUserNewPassword || editUserPasswordSaving"
              @click="setUserPassword"
            >
              set password
            </button>
            <div class="text-(--sub-color) text-xs">
              No email provider is configured. This sets the user&apos;s
              password directly; share it with them securely.
            </div>
          </div>
        </div>

        <div class="flex gap-2 w-full justify-end">
          <button
            class="bg-(--sub-alt-color) text-(--text-color) p-2 rounded-lg"
            :disabled="editUserSaving"
            @click="closeEditUser"
          >
            cancel
          </button>
          <button
            class="bg-(--main-color) text-(--bg-color) p-2 rounded-lg"
            :disabled="editUserSaving"
            @click="saveUserEdits"
          >
            save
          </button>
        </div>
      </div>
    </ModalWindow>
  </div>
</template>
