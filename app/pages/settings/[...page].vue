<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from '~/components/AppHeader.vue';
import SettingsAdmin from '~/components/Settings/SettingsAdmin.vue';
import SettingsAppearance from '~/components/Settings/SettingsAppearance.vue';
import SettingsConnections from '~/components/Settings/SettingsConnections.vue';
import SettingsGeneral from '~/components/Settings/SettingsGeneral.vue';
import SettingsTabBarItem from '~/components/Settings/SettingsTabBarItem.vue';
import { useAuth } from '~/composables/useAuth';

// Compute the current page based on the route parameter
const route = useRoute();
const currentPageName = computed(() => {
  const page = route.params.page;
  if (Array.isArray(page)) {
    return page[0] || 'general';
  }
  return page ? page.split('/')[0] || 'general' : 'general';
});

interface Tab {
  name: string;
  component: Component;
  icon: string;
  path: string;
  admin: boolean;
}

const tabs: Record<string, Tab> = {
  general: {
    name: 'General',
    component: SettingsGeneral,
    icon: 'lucide:settings',
    path: '/settings/general',
    admin: false,
  },
  connections: {
    name: 'Connections',
    component: SettingsConnections,
    icon: 'lucide:plug',
    path: '/settings/connections',
    admin: false,
  },
  appearance: {
    name: 'Appearance',
    component: SettingsAppearance,
    icon: 'lucide:palette',
    path: '/settings/appearance',
    admin: false,
  },
  admin: {
    name: 'Admin',
    component: SettingsAdmin,
    icon: 'lucide:shield-check',
    path: '/settings/admin',
    admin: true,
  },
};

const { isAdmin } = useAuth();
</script>

<template>
  <div class="flex flex-col items-center w-full h-full">
    <AppHeader class="w-full shrink-0" />

    <div
      class="flex flex-wrap justify-center gap-4 px-4 py-2 border-b border-(--contrast-border-color) w-full bg-(--sub-alt-color) settings-tab-bar"
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
        class="justify-center w-full h-full max-w-225 p-4 pb-0"
      />
    </div>
  </div>
</template>
