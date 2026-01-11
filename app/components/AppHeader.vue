<script setup lang="ts">
import BookAddByMetadataModal from '~/components/Books/BookAddByMetadataModal.vue';

const uiStore = useUiStore();

const emit = defineEmits<{
  (e: 'book-uploaded'): void;
}>();

function openAddByMetadata() {
  uiStore.setBookAddByMetadataModalVisible(true);
}
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
            uiStore.setLibraryView('books');
            navigateTo('/');
          }
        "
      >
        Delb
      </div>
      <CollectionPickerDropdown />
      <Icon
        v-tooltip="'Upload book file'"
        name="lucide:upload"
        class="text-(--main-color) cursor-pointer text-xl header-icon"
        @click="uiStore.setBookUploadModalVisible(true)"
      />
      <Icon
        v-tooltip="'Add book'"
        name="lucide:plus"
        class="text-(--main-color) cursor-pointer text-xl header-icon"
        @click="openAddByMetadata"
      />
    </div>

    <!-- Center: Collection switcher (scope) -->
    <!-- <div class="flex items-center gap-2"></div> -->

    <!-- Right: actions -->
    <div class="flex gap-3 items-center p-4 justify-self-end app-header-right">
      <Icon
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
    <BookUploadModal @uploaded="emit('book-uploaded')" />
    <BookAddByMetadataModal @created="emit('book-uploaded')" />
  </div>
</template>

<style scoped>
.logo {
  font-family: Poppins, sans-serif;
}
</style>
