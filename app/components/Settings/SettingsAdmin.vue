<script setup lang="ts">
import { computed, type Component } from 'vue';
import { useRoute } from 'vue-router';
import SettingsAdminDropbox from '~/components/Settings/SettingsAdminDropbox.vue';
import SettingsAdminLibrary from '~/components/Settings/SettingsAdminLibrary.vue';
import SettingsAdminLogs from '~/components/Settings/SettingsAdminLogs.vue';
import SettingsAdminMetadata from '~/components/Settings/SettingsAdminMetadata.vue';
import SettingsAdminSpines from '~/components/Settings/SettingsAdminSpines.vue';
import SettingsAdminUsers from '~/components/Settings/SettingsAdminUsers.vue';
import SettingsTabBarItem from '~/components/Settings/SettingsTabBarItem.vue';

// Compute the current page based on the route parameter
const route = useRoute();
const currentPageName = computed(() => {
  const page = route.params.page;
  if (Array.isArray(page)) {
    return page[1] || 'library';
  }
  return page ? page.split('/')[1] || 'library' : 'library';
});

interface Tab {
  name: string;
  component: Component;
  icon: string;
  path: string;
}

const tabs: Record<string, Tab> = {
  library: {
    name: 'Library',
    component: SettingsAdminLibrary,
    icon: 'lucide:library',
    path: '/settings/admin/library',
  },
  dropbox: {
    name: 'Dropbox',
    component: SettingsAdminDropbox,
    icon: 'lucide:inbox',
    path: '/settings/admin/dropbox',
  },
  metadata: {
    name: 'Metadata',
    component: SettingsAdminMetadata,
    icon: 'lucide:book-open',
    path: '/settings/admin/metadata',
  },
  spines: {
    name: 'Spine generation',
    component: SettingsAdminSpines,
    icon: 'lucide:sparkles',
    path: '/settings/admin/spines',
  },
  users: {
    name: 'Users',
    component: SettingsAdminUsers,
    icon: 'lucide:users',
    path: '/settings/admin/users',
  },
  logs: {
    name: 'Logs',
    component: SettingsAdminLogs,
    icon: 'lucide:scroll-text',
    path: '/settings/admin/logs',
  },
};
</script>

<template>
  <div
    class="flex flex-col items-center h-full overflow-hidden w-screen max-w-screen pt-0!"
  >
    <div
      class="flex justify-start sm:justify-center overflow-x-auto shrink-0 gap-4 px-4 py-2 border-b border-(--contrast-border-color) w-screen bg-(--sub-alt-color)"
    >
      <SettingsTabBarItem
        v-for="[tabKey, tab] in Object.entries(tabs)"
        :key="tab.name"
        :is-active-tab="currentPageName === tabKey"
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
            : tabs.users?.component
        "
        class="justify-center w-full max-w-225 pt-4"
      />
    </div>
  </div>
</template>
