import type { RouteLocationRaw, Router } from 'vue-router';

let activeRouter: Router | null = null;

export function setAppRouter(router: Router) {
  activeRouter = router;
}

export interface NavigateToOptions {
  replace?: boolean;
  external?: boolean;
  open?: {
    target?: string;
    windowFeatures?: Record<string, unknown>;
  };
}

export async function navigateTo(
  to: RouteLocationRaw | null | undefined,
  options?: NavigateToOptions,
) {
  if (!to) return;

  if (typeof to === 'string') {
    const isExternal = options?.external || /^https?:\/\//i.test(to);
    if (isExternal) {
      if (typeof window !== 'undefined') {
        if (options?.open?.target) {
          window.open(to, options.open.target, 'noopener,noreferrer');
        } else if (options?.replace) {
          window.location.replace(to);
        } else {
          window.location.assign(to);
        }
      }
      return;
    }
  }

  if (!activeRouter) {
    if (typeof to === 'string' && typeof window !== 'undefined') {
      if (options?.replace) window.location.replace(to);
      else window.location.assign(to);
    }
    return;
  }

  return options?.replace ? activeRouter.replace(to) : activeRouter.push(to);
}
