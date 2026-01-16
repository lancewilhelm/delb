<script setup lang="ts">
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
    class="flex justify-between items-center h-10 z-10 app-header bg-(--sub-alt-color) border-b border-t border-(--sub-color)"
  >
    <!-- Left: app/home -->
    <div class="flex items-center gap-3 sm:gap-4 px-2 app-header-left">
      <div
        class="text-(--main-color) cursor-pointer header-icon font-bold text-2xl logo"
        @click="
          () => {
            if (route.path === '/') {
              uiStore.setLibraryView('books');
            }
            navigateTo('/');
          }
        "
      >
        Delb
      </div>
      <CollectionPickerDropdown />
      <Icon
        v-tooltip="'Add book'"
        name="lucide:book-plus"
        class="text-(--main-color) cursor-pointer text-xl header-icon"
        @click="openAddBook"
      />
    </div>

    <!-- Center: Collection switcher (scope) -->
    <!-- <div class="flex items-center gap-2"></div> -->

    <!-- Right: actions -->
    <div class="flex gap-3 items-center p-4 justify-self-end app-header-right">
      <Icon
        v-if="!isMobileDevice || !mobileSearchButton"
        v-tooltip="'Open global search'"
        name="lucide:search"
        class="text-(--main-color) cursor-pointer text-xl header-icon"
        @click="uiStore.setGlobalSearchVisible(!uiStore.globalSearchVisible)"
      />
      <Icon
        v-tooltip="'Open command palette'"
        name="lucide:command"
        class="text-(--main-color) cursor-pointer text-xl header-icon"
        @click="
          uiStore.setCommandPaletteVisible(!uiStore.commandPaletteVisible)
        "
      />
      <Icon
        v-tooltip="'Open Settings'"
        name="lucide:settings"
        class="text-(--main-color) cursor-pointer text-xl header-icon"
        @click="navigateTo('/settings')"
      />
    </div>
    <BookAddModal @book-uploaded="emit('book-uploaded')" />

    <!-- Mobile: Search button at bottom right of scren -->
    <div
      v-if="isMobileDevice && mobileSearchButton"
      class="absolute bottom-7 right-7 p-4 bg-(--sub-alt-color)/80 border border-(--sub-color) z-1000 rounded-full flex items-center justify-center"
      @click="uiStore.setGlobalSearchVisible(!uiStore.globalSearchVisible)"
    >
      <Icon
        v-tooltip="'Open global search'"
        name="lucide:search"
        class="text-(--main-color) cursor-pointer text-2xl"
      />
    </div>
  </div>
</template>

<style scoped>
.logo {
  font-family: Poppins, sans-serif;
}
</style>
