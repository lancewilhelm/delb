<script setup lang="ts">
import type { UserWithRole } from "better-auth/plugins";

const users = ref<UserWithRole[]>([]);
const sortedUsers = ref<UserWithRole[]>([]);

// Fetch users data
const fetchUsers = async () => {
  const { admin } = useAuth();
  const { data, error } = await admin.listUsers({ query: { limit: 100 } });

  if (error) {
    logger.error("Error fetching users:", error);
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

// Create user handlers
const createUserModalVisible = ref(false);
const newUserEmail = ref("");
const newUserPassword = ref("");
const newUserRole = ref<"admin" | "user">("user");
const createUserEmailInput = ref<HTMLInputElement | null>(null);
async function createUser() {
  if (!newUserEmail.value || !newUserPassword.value) {
    alert("Please fill in all fields");
    return;
  }

  const { admin } = useAuth();
  const { error } = await admin.createUser({
    email: newUserEmail.value,
    password: newUserPassword.value,
    role: newUserRole.value,
    name: "",
  });

  if (error) {
    alert(`Error creating user: ${error.message}`);
    return;
  }

  // Reset the form
  newUserEmail.value = "";
  newUserPassword.value = "";
  newUserRole.value = "user";
  createUserModalVisible.value = false;

  // Refetch users to update the list
  await fetchUsers();
}

// Delete user handlers
const deleteUserModalVisible = ref(false);
const deleteUserEmail = ref("");
const deleteUserEmailConfirmation = ref("");
const deleteUserEmailConfirmationRef = ref<HTMLInputElement | null>(null);
const deleteUserId = ref("");
async function deleteUser() {
  if (deleteUserEmailConfirmation.value !== deleteUserEmail.value) {
    alert("Email confirmation does not match");
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
  deleteUserEmailConfirmation.value = "";
  deleteUserEmail.value = "";
  deleteUserId.value = "";

  // Refetch users to update the list
  await fetchUsers();
}

// Ban user handlers
const banUserModalVisible = ref(false);
const banUserEmail = ref("");
const banUserId = ref("");
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
  banUserEmail.value = "";
  banUserId.value = "";

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
  if (user.role === "admin" && currentUser.value.role !== "owner") return false; // Can't edit admin if not owner
  if (user.role === "owner") return false; // Can't edit owner
  return true;
}
const globalSettingsStore = useGlobalSettingsStore();
</script>

<template>
  <div class="w-full">
    <SettingsGroup title="users" icon="lucide:users">
      <div class="w-full mt-4 overflow-x-auto">
        <table class="min-w-full">
          <thead class="bg-(--sub-color) text-(--main-color)">
            <tr>
              <th scope="col" class="px-6 py-1 text-left font-medium">email</th>
              <th scope="col" class="px-6 py-1 text-left font-medium">role</th>
              <th scope="col" class="px-6 py-1 text-left font-medium">
                date created
              </th>
              <th scope="col" class="px-6 py-1 text-left font-medium w-[150px]">
                actions
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-(--sub-color) text-(--text-color)">
            <template v-if="sortedUsers.length > 0">
              <tr v-for="u in sortedUsers" :key="u.id" class="h-[40px]">
                <td class="px-6 py-1 whitespace-nowrap text-sm">
                  {{ u.email }}
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
                      @click="() => console.log('Edit user', u.id)"
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
              <td colspan="3" class="px-6 py-4 text-center text-sm">
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
    </SettingsGroup>
    <SettingsGroup title="allow registration" icon="lucide:lock">
      <SettingsToggleItem
        description="allow users to register themselves at /register"
        :value="globalSettingsStore.settings.allowRegistration"
        @toggle="
          globalSettingsStore.updateSettings({
            allowRegistration: !globalSettingsStore.settings.allowRegistration,
          })
        "
      />
    </SettingsGroup>

    <!-- Create User Modal -->
    <ModalWindow
      :open="createUserModalVisible"
      @close="createUserModalVisible = false"
    >
      <div class="flex flex-col gap-4 items-center">
        <div class="text-(--main-color) text-lg self-start">
          create new user
        </div>
        <div class="flex flex-col gap-2 w-[250px]">
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
  </div>
</template>
