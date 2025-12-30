import { defu } from "defu";

type MiddlewareOptions =
  | false
  | {
      /**
       * Only apply auth middleware to guest or user
       */
      only?: "guest" | "user";
      /**
       * Redirect authenticated user to this route
       */
      redirectUserTo?: string;
      /**
       * Redirect guest to this route
       */
      redirectGuestTo?: string;
    };

declare module "#app" {
  interface PageMeta {
    auth?: MiddlewareOptions;
  }
}

declare module "vue-router" {
  interface RouteMeta {
    auth?: MiddlewareOptions;
  }
}

export default defineNuxtRouteMiddleware(async (to) => {
  // If auth is disabled, skip middleware
  if (to.meta?.auth === false) {
    return;
  }
  const { loggedIn, options } = useAuth();
  const { only, redirectUserTo, redirectGuestTo } = defu(
    to.meta?.auth,
    options,
  );

  // Optional: first-time setup redirect
  if (!loggedIn.value) {
    const userCount = await $fetch<number>("/api/auth/user-count");
    if (userCount === 0 && to.path !== "/register") {
      return navigateTo("/register");
    }
  }

  // Handle root path redirect
  // if (to.path === "/") {
  //   if (loggedIn.value) return navigateTo(redirectUserTo);
  //   return navigateTo(redirectGuestTo);
  // }

  // Guest-only pages
  if (only === "guest" && loggedIn.value) {
    if (to.path === redirectUserTo) return;
    return navigateTo(redirectUserTo);
  }

  // User-only pages
  if (!loggedIn.value && only === "user") {
    if (to.path === redirectGuestTo) return;
    return navigateTo(redirectGuestTo);
  }
});
