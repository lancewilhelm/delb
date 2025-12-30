<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

defineProps<{
  value: string;
  options: string[] | readonly string[];
  title?: string;
  description?: string;
}>();

const emit = defineEmits(["select"]);

const popupVisible = ref(false);
const popupRef = ref<HTMLElement | null>(null);

// Close on escape or outside click
function handleClickOutside(event: MouseEvent) {
  if (popupRef.value && !popupRef.value.contains(event.target as Node)) {
    popupVisible.value = false;
  }
}
function handleEscapeKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    popupVisible.value = false;
  }
}

onMounted(() => {
  document.addEventListener("mousedown", handleClickOutside);
  document.addEventListener("keydown", handleEscapeKey);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", handleClickOutside);
  document.removeEventListener("keydown", handleEscapeKey);
});

function selectOption(option: string) {
  emit("select", option);
  popupVisible.value = false;
}
</script>

<template>
  <div
    class="w-full grid grid-cols-[1fr_min-content] grid-rows-2 items-center gap-2 relative setting-select-item"
  >
    <div
      v-if="title"
      :class="[
        'row-start-1 col-start-1 settings-select-item-title',
        !description && 'row-span-2',
      ]"
    >
      {{ title }}
    </div>
    <div
      v-if="description"
      class="row-start-2 col-start-1 italic settings-select-item-description"
    >
      {{ description }}
    </div>

    <!-- Custom Select Trigger -->
    <div
      class="row-span-2 flex items-center gap-2 cursor-pointer bg-(--sub-alt-color) rounded-lg px-3 py-2 select-none min-w-[150px] settings-select-item-select"
      tabindex="0"
      @mousedown.prevent.stop="popupVisible = !popupVisible"
      @keydown.enter.prevent.stop="popupVisible = !popupVisible"
      @keydown.space.prevent.stop="popupVisible = !popupVisible"
      @keydown.esc.prevent.stop="popupVisible = false"
    >
      <div class="flex-1 truncate settings-select-item-value">
        {{ value || "Select option" }}
      </div>
      <Icon
        name="lucide:chevron-down"
        :class="[popupVisible ? 'rotate-180' : 'rotate-0 duration-200']"
      />
    </div>

    <!-- Popup List -->
    <div
      v-if="popupVisible"
      ref="popupRef"
      class="absolute top-full mb-2 right-0 bg-(--bg-color) border border-(--main-color) rounded-lg shadow-lg max-h-100 min-w-[150px] z-10 overflow-y-auto settings-select-item-popup"
    >
      <div
        v-for="option in options"
        :key="option"
        class="px-4 py-2 cursor-pointer truncate hover:bg-(--sub-color) settings-select-item-option"
        :class="option === value ? 'text-(--main-color)' : ''"
        @click="selectOption(option)"
      >
        {{ option }}
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Optional custom scrollbar styling */
::-webkit-scrollbar {
  width: 6px;
}
::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 3px;
}
</style>
