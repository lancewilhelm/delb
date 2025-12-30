<script setup lang="ts">
const pages = {
  home: {
    name: "home",
    action: () => {
      navigateTo("/");
    },
    url: "/home", // Use a consistent URL for the home page, not the real path
    icon: "lucide:home",
  },
  settings: {
    name: "settings",
    action: () => {
      navigateTo("/settings");
    },
    url: "/settings",
    icon: "lucide:settings",
  },
};

const popupVisible = ref(false);
const popupRef = ref<HTMLElement | null>(null);

// Compute the current page based on the route parameter
const route = useRoute();
const currentPage = computed(() => {
  if (route.path === "/") {
    return pages.home;
  }

  const page = Object.values(pages).find((page) =>
    route.path.startsWith(page.url),
  );
  return page || pages.home;
});

// Close on escape or outside click
const handleClickOutside = (event: MouseEvent) => {
  if (popupRef.value && !popupRef.value.contains(event.target as Node)) {
    popupVisible.value = false;
  }
};

const handleEscapeKey = (event: KeyboardEvent) => {
  if (event.key === "Escape") {
    popupVisible.value = false;
  }
};

onMounted(() => {
  document.addEventListener("mousedown", handleClickOutside);
  document.addEventListener("keydown", handleEscapeKey);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", handleClickOutside);
  document.removeEventListener("keydown", handleEscapeKey);
});
</script>

<template>
  <div class="relative">
    <div
      class="flex items-center gap-2 cursor-pointer focus-outline rounded"
      tabindex="0"
      @mousedown.stop.prevent="popupVisible = !popupVisible"
      @keydown.enter="
        () => {
          popupVisible = !popupVisible;
        }
      "
      @keydown.esc.stop.prevent="
        () => {
          popupVisible = false;
        }
      "
      @keydown.space="
        () => {
          popupVisible = !popupVisible;
        }
      "
    >
      <Icon
        v-if="currentPage"
        :name="currentPage.icon"
        class="text-(--main-color) scale-125"
      />
      <div class="flex items-center gap-1">
        <div v-if="currentPage" class="text-sm text-(--main-color)">
          {{ currentPage.name }}
        </div>
        <Icon
          v-if="Object.keys(pages).length"
          name="lucide:chevron-up"
          :class="[
            'cursor-pointer hover:opacity-80 transition-transform ',
            currentPage ? 'text-(--main-color)' : 'text-(--error-color)',
            popupVisible ? 'rotate-0' : 'rotate-180',
          ]"
        />
      </div>
    </div>

    <!-- popup -->
    <div
      v-if="popupVisible && Object.keys(pages).length"
      ref="popupRef"
      class="absolute top-full mb-2 mt-2 left-0 bg-(--bg-color) border border-(--sub-color) rounded-lg shadow-lg w-60 max-h-60 z-20 overflow-y-auto"
    >
      <div
        v-for="page in pages"
        :key="page.name"
        :class="[
          'grid grid-cols-[20px_1fr] items-center gap-2 px-3 py-2 cursor-pointer',
          currentPage?.name === page.name
            ? 'bg-(--sub-color)/20'
            : 'hover:bg-(--sub-color)/10',
        ]"
        @click="page.action()"
      >
        <Icon :name="page.icon" class="text-(--main-color) scale-125" />
        <div class="flex flex-col overflow-hidden">
          <HoverScrollText>{{ page.name }}</HoverScrollText>
        </div>
      </div>
    </div>
  </div>
</template>
