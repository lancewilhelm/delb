<script setup lang="ts">
const showNukeConfirm = ref(false);
async function nukeData() {
    await $fetch("/api/nuke");
    showNukeConfirm.value = false;
    window.location.reload();
}
</script>

<template>
    <div class="w-full">
        <SettingsGroup
            title="Cloud"
            icon="lucide:cloud"
            description="cloud database tools"
        >
            <p class="text-sm text-(--text-color) mt-2">
                Settings now sync automatically: user/global settings are pulled
                on app load (when logged in), and pushed when changed.
            </p>
        </SettingsGroup>
        <SettingsGroup
            title="Nuke"
            icon="lucide:bomb"
            description="delete all data from local and cloud storage. settings will not be affected."
        >
            <button
                class="bg-(--error-color)! text-(--bg-color)! font-bold py-2 px-4 rounded cursor-pointer"
                @click="showNukeConfirm = true"
            >
                Nuke Data
            </button>
            <p class="text-sm text-(--text-color) mt-2">
                This action is irreversible and will delete all your data.
            </p>
        </SettingsGroup>
        <!-- Modals -->
        <ModalWindow :open="showNukeConfirm" @close="showNukeConfirm = false">
            <div class="flex flex-col gap-4">
                <div class="font-bold">
                    Are you sure you want to delete all your data? This action
                    is irreversible.
                </div>
                <div class="flex w-full gap-4 justify-center">
                    <button
                        class="bg-(--error-color) text-white font-bold py-2 px-4 rounded cursor-pointer"
                        @click="nukeData"
                    >
                        Yes
                    </button>
                    <button
                        class="bg-(--sub-color) text-white font-bold py-2 px-4 rounded cursor-pointer"
                        @click="showNukeConfirm = false"
                    >
                        No
                    </button>
                </div>
            </div>
        </ModalWindow>
    </div>
</template>
