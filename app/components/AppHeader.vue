<script setup lang="ts">
const uiStore = useUiStore();

const emit = defineEmits<{
    (e: "upload"): void;
}>();
</script>

<template>
    <div
        class="flex justify-between items-center h-10 z-10 app-header bg-(--sub-alt-color) border-b border-t border-(--sub-color)"
    >
        <!-- Left: app/home -->
        <div class="flex items-center gap-4 px-2 app-header-left">
            <div
                class="text-(--main-color) cursor-pointer header-icon font-bold text-2xl logo"
                @click="navigateTo('/')"
            >
                Delb
            </div>
        </div>

        <!-- Center: Collection switcher (scope) -->
        <div class="flex items-center gap-2">
            <CollectionPickerDropdown />
        </div>

        <!-- Right: actions -->
        <div
            class="flex gap-4 items-center p-4 justify-self-end app-header-right"
        >
            <Icon
                v-tooltip="'Upload book'"
                name="lucide:upload"
                class="text-(--main-color) cursor-pointer scale-125 header-icon"
                @click="emit('upload')"
            />
            <Icon
                v-tooltip="'Open command palette'"
                name="lucide:command"
                class="text-(--main-color) cursor-pointer scale-125 header-icon"
                @click="
                    uiStore.setCommandPaletteVisible(
                        !uiStore.commandPaletteVisible,
                    )
                "
            />
            <Icon
                v-tooltip="'Open Settings'"
                name="lucide:settings"
                class="text-(--main-color) cursor-pointer scale-125 header-icon"
                @click="navigateTo('/settings')"
            />
        </div>
    </div>
</template>

<style scoped>
.logo {
    font-family: Poppins, sans-serif;
}
</style>
