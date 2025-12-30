<script setup lang="ts">
import type { ConcreteComponent } from "vue";
// Redirect to the profile page if the page parameter is empty
definePageMeta({
  auth: {
    only: "user",
    redirectGuestTo: "/login",
  },
  middleware: [
    function (to) {
      if (!to.params.page) {
        return navigateTo("/settings/general");
      } else if (
        Array.isArray(to.params.page) &&
        to.params.page.length === 1 &&
        to.params.page[0] === "admin"
      ) {
        return navigateTo("/settings/admin/users");
      }
    },
  ],
});

// Compute the current page based on the route parameter
const route = useRoute();
const currentPageName = computed(() =>
  route.params.page !== ""
    ? Array.isArray(route.params.page)
      ? route.params.page[0]
      : route.params.page
    : "profile",
);

interface Tab {
  name: string;
  component: string | ConcreteComponent;
  icon: string;
  path: string;
  admin: boolean;
}

const tabs: Record<string, Tab> = {
  general: {
    name: "general",
    component: resolveComponent("SettingsGeneral"),
    icon: "lucide:settings",
    path: "/settings/general",
    admin: false,
  },
  appearance: {
    name: "appearance",
    component: resolveComponent("SettingsAppearance"),
    icon: "lucide:palette",
    path: "/settings/appearance",
    admin: false,
  },
  cloud: {
    name: "cloud",
    component: resolveComponent("SettingsCloud"),
    icon: "lucide:cloud",
    path: "/settings/cloud",
    admin: false,
  },
  admin: {
    name: "admin",
    component: resolveComponent("SettingsAdmin"),
    icon: "lucide:shield-check",
    path: "/settings/admin",
    admin: true,
  },
};

const { isAdmin } = useAuth();
</script>

<template>
  <div class="flex flex-col items-center w-full h-full">
    <SettingsHeader class="w-full h-[40px] shrink-0" />
    <div
      class="flex flex-wrap justify-center gap-4 px-4 py-2 border-t border-b border-(--sub-color) w-full settings-tab-bar"
    >
      <SettingsTabBarItem
        v-for="tab in Object.values(tabs).filter((t) => !t.admin || isAdmin)"
        :key="tab.name"
        :is-active-tab="currentPageName === tab.name"
        :icon="tab.icon"
        :path="tab.path"
        :label="tab.name"
      />
    </div>
    <div
      class="flex flex-col items-center w-full h-full overflow-y-auto settings-tab-content"
    >
      <component
        :is="
          currentPageName
            ? tabs[currentPageName]?.component
            : tabs.general?.component
        "
        class="justify-center w-full h-full max-w-[900px] p-4 pb-0"
      />
    </div>
  </div>
</template>
