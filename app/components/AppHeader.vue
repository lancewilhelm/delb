<script setup lang="ts">
const uiStore = useUiStore();

const emit = defineEmits<{
    (e: "upload"): void;
}>();

function onUploadClick() {
    emit("upload");
}
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
            <CollectionPickerDropdown />
        </div>

        <!-- Center: Collection switcher (scope) -->
        <div class="flex items-center gap-2"></div>

        <!-- Right: actions -->
        <div
            class="flex gap-4 items-center p-4 justify-self-end app-header-right"
        >
            <button
                v-tooltip="'Upload book'"
                type="button"
                class="text-(--main-color) cursor-pointer scale-125 header-icon"
                aria-label="Upload book"
                @click="onUploadClick"
            >
                <Icon name="lucide:upload" class="pointer-events-none" />
            </button>
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
