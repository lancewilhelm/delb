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
        <div class="flex items-center gap-4 p-4 app-header-left">
            <Icon
                v-tooltip="'Open Library'"
                name="lucide:book"
                class="text-(--main-color) cursor-pointer scale-125 header-icon"
                @click="navigateTo('/')"
            />
        </div>
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
