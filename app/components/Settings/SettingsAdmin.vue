<script setup lang="ts">
import type { ConcreteComponent } from "vue";

// Compute the current page based on the route parameter
const route = useRoute();
const currentPageName = computed(() =>
  route.params.page !== ""
    ? Array.isArray(route.params.page)
      ? route.params.page[1]
      : route.params.page
    : "profile",
);

interface Tab {
  name: string;
  component: string | ConcreteComponent;
  icon: string;
  path: string;
}

const tabs: Record<string, Tab> = {
  users: {
    name: "users",
    component: resolveComponent("SettingsAdminUsers"),
    icon: "lucide:users",
    path: "/settings/admin/users",
  },
};
</script>

<template>
  <div
    class="flex flex-col items-center h-full overflow-hidden w-screen max-w-screen pt-0!"
  >
    <div
      class="flex justify-center gap-4 px-4 py-2 border-b border-(--sub-color) w-screen"
    >
      <SettingsTabBarItem
        v-for="tab in Object.values(tabs)"
        :key="tab.name"
        :is-active-tab="currentPageName === tab.name"
        :icon="tab.icon"
        :path="tab.path"
        :label="tab.name"
      />
    </div>
    <div class="flex flex-col items-center w-full h-full overflow-y-auto">
      <component
        :is="
          currentPageName
            ? tabs[currentPageName]?.component
            : tabs.model?.component
        "
        class="justify-center w-full max-w-[900px] p-4"
      />
    </div>
  </div>
</template>
