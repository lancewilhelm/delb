<script setup lang="ts">
import { useIsMobileDevice } from '~/composables/useIsMobileDevice';
import { useUiStore } from '~/stores/ui';
import { useUserSettingsStore } from '~/stores/userSettings';
import { navigateTo } from '~/utils/navigation';
import { RouterLink, useRoute } from 'vue-router';
import CollectionPickerDropdown from '~/components/CollectionPickerDropdown.vue';
import BookAddModal from '~/components/Books/BookAddModal.vue';

const uiStore = useUiStore();

const emit = defineEmits<{
  (e: 'book-uploaded'): void;
}>();

function openAddBook() {
  uiStore.setAddBookModalVisible(true);
}

const route = useRoute();

const isMobileDevice = useIsMobileDevice();
const userSettingsStore = useUserSettingsStore();
const mobileSearchButton = userSettingsStore.mobileSettingRef<boolean>(
  'mobileSpecific.searchButton',
);
</script>

<template>
  <div
    class="z-140 flex justify-between items-center h-[calc(2.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] app-header bg-(--sub-alt-color) border-b border-(--contrast-border-color)"
  >
    <!-- Left: app/home -->
    <div class="flex items-center gap-3 sm:gap-4 px-2 app-header-left">
      <RouterLink
        class="text-(--contrast-main-color) cursor-pointer header-icon font-medium text-2xl logo"
        to="/"
      >
        Delb
      </RouterLink>
      <CollectionPickerDropdown
        v-if="
          route.path !== '/to-be-read' &&
          route.path !== '/shelves' &&
          !route.path.startsWith('/shelves/')
        "
      />
      <button type="button" aria-label="Add book" @click="openAddBook">
        <Icon
          name="lucide:book-plus"
          class="text-(--contrast-main-color) cursor-pointer text-xl header-icon"
        />
      </button>
    </div>

    <!-- Center: Collection switcher (scope) -->
    <!-- <div class="flex items-center gap-2"></div> -->

    <!-- Right: actions -->
    <div class="flex gap-3 items-center p-4 justify-self-end app-header-right">
      <Icon
        v-if="!isMobileDevice || !mobileSearchButton"
        v-tooltip="'Open global search'"
        name="lucide:search"
        class="text-(--contrast-main-color) cursor-pointer text-xl header-icon"
        @click="uiStore.setGlobalSearchVisible(!uiStore.globalSearchVisible)"
      />
      <Icon
        v-tooltip="'Open command palette'"
        name="lucide:command"
        class="text-(--contrast-main-color) cursor-pointer text-xl header-icon"
        @click="
          uiStore.setCommandPaletteVisible(!uiStore.commandPaletteVisible)
        "
      />
      <Icon
        v-tooltip="'Open Settings'"
        name="lucide:settings"
        class="text-(--contrast-main-color) cursor-pointer text-xl header-icon"
        @click="navigateTo('/settings')"
      />
    </div>
    <BookAddModal @book-uploaded="emit('book-uploaded')" />

    <!-- Mobile: Search button at bottom right of scren -->
    <div
      v-if="isMobileDevice && mobileSearchButton"
      class="absolute bottom-[calc(1.75rem+env(safe-area-inset-bottom))] right-7 p-4 bg-(--sub-alt-color)/80 border border-(--contrast-border-color) z-1000 rounded-full flex items-center justify-center"
      @click="uiStore.setGlobalSearchVisible(!uiStore.globalSearchVisible)"
    >
      <Icon
        v-tooltip="'Open global search'"
        name="lucide:search"
        class="text-(--contrast-main-color) cursor-pointer text-2xl"
      />
    </div>
  </div>
</template>

<style scoped>
.logo {
  font-family: Poppins, sans-serif;
}
</style>
