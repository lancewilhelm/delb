<script setup lang="ts">
const changePasswordModalVisible = ref(false);
const changePasswordSuccess = ref(false);
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const { changePassword } = useAuth();
async function handleUpdatePassword() {
    if (newPassword.value !== confirmPassword.value) {
        alert("New password and confirmation do not match");
        return;
    }

    const { error } = await changePassword({
        currentPassword: currentPassword.value,
        newPassword: newPassword.value,
    });

    if (error) {
        alert("Error updating password: " + error.message);
        console.error("Error updating password:", error);
        return;
    }

    // Reset the form
    changePasswordModalVisible.value = false;
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";

    changePasswordSuccess.value = true;
    setTimeout(() => {
        changePasswordSuccess.value = false;
    }, 3000);
}

const config = useRuntimeConfig();
</script>
<template>
    <div class="w-full">
        <SettingsGroup title="credentials" icon="lucide:lock">
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
                    <Icon
                        name="lucide:check"
                        class="w-4 h-4 text-(--main-color)"
                    />
                    password updated
                </div>
            </div>
        </SettingsGroup>
        <SettingsGroup
            title="about"
            icon="lucide:info"
            class="flex flex-col gap-2"
        >
            <DelbLogo fill="var(--main-color)" />
            <div class="text-(--sub-color) italic">
                version: {{ config.public.appVersion || "manual" }}
            </div>
            <div class="logo text-2xl">Delb</div>
            <NuxtLink
                to="https://github.com/lancewilhelm/delb"
                class="flex items-center gap-1"
            >
                <Icon
                    name="simple-icons:github"
                    class="w-4 h-4 text-(--main-color)"
                />
                <span class="text-(--main-color)"
                    ><span class="logo">Delb</span> on GitHub</span
                >
            </NuxtLink>
        </SettingsGroup>

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
