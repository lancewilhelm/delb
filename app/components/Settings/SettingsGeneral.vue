<script setup lang="ts">
import { useAuth } from '~/composables/useAuth';
import { computed, ref, watch } from 'vue';
import DelbLogo from '~/components/DelbLogo.vue';
import ModalWindow from '~/components/ModalWindow.vue';
import SettingsUIGroup from '~/components/Settings/UI/SettingsUIGroup.vue';
import SettingsUIToggle from '~/components/Settings/UI/SettingsUIToggle.vue';
import { useUserSettingsStore } from '~/stores/userSettings';
import { appVersion } from '~/utils/appVersion';

const userSettingsStore = useUserSettingsStore();
const shareCardPrompt = userSettingsStore.settingRef<boolean>(
  'shareCard.promptOnFinish',
  { immediate: true },
);

const changePasswordModalVisible = ref(false);
const changePasswordSuccess = ref(false);
const currentPassword = ref('');
const newPassword = ref('');
const confirmPassword = ref('');
const { changePassword, changeEmail, updateUser, fetchSession, user, signOut } =
  useAuth();
const signingOut = ref(false);

async function handleSignOut() {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await signOut();
  } finally {
    signingOut.value = false;
  }
}
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
      const { error } = await updateUser({ name: trimmedName });
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
      <div class="flex flex-wrap items-center gap-2">
        <button
          class="flex items-center gap-1 px-4 py-2 text-left rounded-lg bg-(--sub-alt-color)"
          @click="changePasswordModalVisible = true"
        >
          update password
        </button>
        <button
          class="flex items-center gap-1.5 px-4 py-2 text-left rounded-lg bg-(--sub-alt-color) disabled:opacity-60"
          :disabled="signingOut"
          @click="handleSignOut"
        >
          <Icon name="lucide:log-out" class="w-4 h-4" />
          sign out
        </button>
        <div
          v-if="changePasswordSuccess"
          class="flex items-center gap-2 italic text-(--contrast-main-color)"
        >
          <Icon
            name="lucide:check"
            class="w-4 h-4 text-(--contrast-main-color)"
          />
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
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
        />
        <input
          v-model="profileEmail"
          type="email"
          autocomplete="email"
          placeholder="email"
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
        />
        <div class="flex items-center gap-2">
          <button
            class="flex items-center gap-2 bg-(--main-color) text-(--contrast-inverse-color) p-2 rounded-lg px-4 cursor-pointer"
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
            class="flex items-center gap-2 italic text-(--contrast-main-color)"
          >
            <Icon
              name="lucide:check"
              class="w-4 h-4 text-(--contrast-main-color)"
            />
            profile updated
          </div>
        </div>
      </div>
    </SettingsUIGroup>
    <SettingsUIGroup title="Share cards" icon="lucide:share-2">
      <SettingsUIToggle
        v-model="shareCardPrompt"
        title="Offer a share card when I finish a book"
        description="Shows a short notice with a Share card button after you mark a book as Finished."
      />
    </SettingsUIGroup>
    <SettingsUIGroup
      title="About"
      icon="lucide:info"
      class="flex flex-col gap-2"
    >
      <DelbLogo fill="var(--main-color)" />
      <div class="logo text-2xl">Delb</div>
      <div class="italic text-(--contrast-sub-color) font-light text-sm">
        Donde está la biblioteca
      </div>
      <div class="text-(--contrast-sub-color) italic">
        version: {{ appVersion }}
      </div>
      <a
        href="https://github.com/lancewilhelm/delb"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-1"
      >
        <Icon
          name="simple-icons:github"
          class="w-4 h-4 text-(--contrast-main-color)"
        />
        <span class="text-(--contrast-main-color)"
          ><span class="logo">Delb</span> on GitHub</span
        >
      </a>
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
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
          @keyup.enter="handleUpdatePassword"
        />
        <input
          v-model="newPassword"
          type="password"
          placeholder="new password"
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
          @keyup.enter="handleUpdatePassword"
        />
        <input
          v-model="confirmPassword"
          type="password"
          placeholder="confirm new password"
          class="w-full p-2 border border-(--contrast-border-color) rounded-lg"
          @keyup.enter="handleUpdatePassword"
        />
        <button
          class="flex items-center gap-2 mt-2 bg-(--main-color) text-(--contrast-inverse-color) p-2 rounded-lg px-4 cursor-pointer"
          @click="handleUpdatePassword"
        >
          update password
        </button>
      </div>
    </ModalWindow>
  </div>
</template>
