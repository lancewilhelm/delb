<script setup lang="ts">
const changePasswordModalVisible = ref(false);
const changePasswordSuccess = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const { changePassword, changeEmail, fetchSession, user, client } = useAuth();
async function handleUpdatePassword() {
  if (newPassword.value !== confirmPassword.value) {
    alert('New password and confirmation do not match');
    return;
  }

  const { error } = await changePassword({
    currentPassword: currentPassword.value,
    newPassword: newPassword.value,
  });

  if (error) {
    alert('Error updating password: ' + error.message);
    console.error('Error updating password:', error);
    return;
  }

  // Reset the form
  changePasswordModalVisible.value = false;
  currentPassword.value = '';
  newPassword.value = '';
  confirmPassword.value = '';

  changePasswordSuccess.value = true;
  setTimeout(() => {
    changePasswordSuccess.value = false;
  }, 3000);
}

const config = useRuntimeConfig();

const profileName = ref('');
const profileEmail = ref('');
const profileUpdateSuccess = ref(false);
const profileUpdating = ref(false);

watch(
  () => user.value,
  (currentUser) => {
    profileName.value = currentUser?.name ?? '';
    profileEmail.value = currentUser?.email ?? '';
  },
  { immediate: true },
);

const profileDirty = computed(() => {
  const currentName = user.value?.name ?? '';
  const currentEmail = user.value?.email ?? '';
  return (
    profileName.value.trim() !== currentName ||
    profileEmail.value.trim() !== currentEmail
  );
});

async function handleUpdateProfile() {
  if (!user.value || profileUpdating.value) return;

  const trimmedName = profileName.value.trim();
  const trimmedEmail = profileEmail.value.trim();

  if (!trimmedName) {
    alert('Please enter your name');
    return;
  }

  if (!trimmedEmail) {
    alert('Please enter your email');
    return;
  }

  profileUpdating.value = true;

  try {
    if (trimmedName !== (user.value.name ?? '')) {
      const { error } = await client.updateUser({ name: trimmedName });
      if (error) {
        throw error;
      }
    }

    if (trimmedEmail !== (user.value.email ?? '')) {
      const { error } = await changeEmail({ newEmail: trimmedEmail });
      if (error) {
        throw error;
      }
    }

    await fetchSession();
    profileUpdateSuccess.value = true;
    setTimeout(() => {
      profileUpdateSuccess.value = false;
    }, 3000);
  } catch (error: unknown) {
    const message =
      error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? 'Unknown error')
        : 'Unknown error';
    alert('Error updating profile: ' + message);
    console.error('Error updating profile:', error);
  } finally {
    profileUpdating.value = false;
  }
}
</script>
<template>
  <div class="w-full">
    <SettingsUIGroup title="Credentials" icon="lucide:lock">
      <div class="flex items-center gap-2">
        <button
          class="flex items-center gap-1 px-4 py-2 text-left rounded-lg bg-(--sub-alt-color)"
          @click="changePasswordModalVisible = true"
        >
          update password
        </button>
        <div
          v-if="changePasswordSuccess"
          class="flex items-center gap-2 italic text-(--main-color)"
        >
          <Icon name="lucide:check" class="w-4 h-4 text-(--main-color)" />
          password updated
        </div>
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup title="Profile" icon="lucide:user" class="flex flex-col">
      <div class="flex flex-col gap-2 max-w-[320px]">
        <input
          v-model="profileName"
          type="text"
          autocomplete="name"
          placeholder="name"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
        />
        <input
          v-model="profileEmail"
          type="email"
          autocomplete="email"
          placeholder="email"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
        />
        <div class="flex items-center gap-2">
          <button
            class="flex items-center gap-2 bg-(--main-color) text-(--bg-color) p-2 rounded-lg px-4 cursor-pointer"
            :class="[
              profileDirty ? 'opacity-100' : 'opacity-60 cursor-not-allowed',
            ]"
            :disabled="!profileDirty || profileUpdating"
            @click="handleUpdateProfile"
          >
            save changes
          </button>
          <div
            v-if="profileUpdateSuccess"
            class="flex items-center gap-2 italic text-(--main-color)"
          >
            <Icon name="lucide:check" class="w-4 h-4 text-(--main-color)" />
            profile updated
          </div>
        </div>
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup
      title="About"
      icon="lucide:info"
      class="flex flex-col gap-2"
    >
      <DelbLogo fill="var(--main-color)" />
      <div class="logo text-2xl">Delb</div>
      <div class="italic text-(--sub-color) font-light text-sm">
        Donde está la biblioteca
      </div>
      <div class="text-(--sub-color) italic">
        version: {{ config.public.appVersion || 'manual' }}
      </div>
      <NuxtLink
        to="https://github.com/lancewilhelm/delb"
        class="flex items-center gap-1"
      >
        <Icon name="simple-icons:github" class="w-4 h-4 text-(--main-color)" />
        <span class="text-(--main-color)"
          ><span class="logo">Delb</span> on GitHub</span
        >
      </NuxtLink>
    </SettingsUIGroup>

    <!-- Change Password Modal -->
    <ModalWindow
      :open="changePasswordModalVisible"
      @close="
        () => {
          changePasswordModalVisible = false;
          currentPassword = '';
          newPassword = '';
          confirmPassword = '';
        }
      "
    >
      <div class="flex flex-col items-center justify-center gap-2">
        <input
          v-model="currentPassword"
          type="password"
          placeholder="current password"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          @keyup.enter="handleUpdatePassword"
        />
        <input
          v-model="newPassword"
          type="password"
          placeholder="new password"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          @keyup.enter="handleUpdatePassword"
        />
        <input
          v-model="confirmPassword"
          type="password"
          placeholder="confirm new password"
          class="w-full p-2 border border-(--sub-color) rounded-lg"
          @keyup.enter="handleUpdatePassword"
        />
        <button
          class="flex items-center gap-2 mt-2 bg-(--main-color) text-(--bg-color) p-2 rounded-lg px-4 cursor-pointer"
          @click="handleUpdatePassword"
        >
          update password
        </button>
      </div>
    </ModalWindow>
  </div>
</template>
