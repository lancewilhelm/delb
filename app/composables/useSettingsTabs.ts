export function useSettingsTabs() {
  const tabs = [
    {
      name: "profile",
      component: "SettingsProfile",
      icon: "lucide:circle-user",
      path: "/settings/profile",
      admin: false,
    },
    {
      name: "theme",
      component: resolveComponent("SettingsTheme"),
      icon: "lucide:palette",
      path: "/settings/theme",
      admin: false,
    },
    {
      name: "cloud",
      component: resolveComponent("SettingsCloud"),
      icon: "lucide:cloud",
      path: "/settings/cloud",
      admin: false,
    },
    {
      name: "admin",
      component: resolveComponent("SettingsAdmin"),
      icon: "lucide:shield-check",
      path: "/settings/admin",
      admin: true,
    },
  ];

  return {
    tabs,
  };
}
