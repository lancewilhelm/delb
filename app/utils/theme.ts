import { customThemeCss, type CustomTheme } from './customTheme';

let ready: Promise<void> = Promise.resolve();

export function whenThemeReady() {
  return ready;
}

let cancelPending: (() => void) | undefined;

/** Apply a preset stylesheet or the saved custom palette. */
export function loadTheme(
  themeName?: string,
  palette?: CustomTheme,
): Promise<void> {
  ready = applyTheme(themeName, palette);
  return ready;
}

function applyTheme(themeName?: string, palette?: CustomTheme): Promise<void> {
  cancelPending?.();
  cancelPending = undefined;
  const systemStyles = [
    ...document.querySelectorAll<HTMLElement>(
      '#systemThemeLight, #systemThemeDark',
    ),
  ];
  let existing = document.querySelector<HTMLElement>('#currentTheme');
  const matching = systemStyles.find((node) =>
    themeName === 'custom'
      ? node.tagName === 'STYLE' &&
        node.matches('[media]') &&
        window.matchMedia(node.getAttribute('media') || '').matches
      : node.getAttribute('href') === `/css/themes/${themeName}.css`,
  );
  if (!existing && matching) {
    matching.removeAttribute('media');
    matching.id = 'currentTheme';
    existing = matching;
    systemStyles
      .filter((node) => node !== matching)
      .forEach((node) => node.remove());
  }
  const clearSystemStyles = () =>
    systemStyles.forEach((node) => {
      if (node !== existing) node.remove();
    });

  if (!themeName) {
    existing?.remove();
    clearSystemStyles();
    return Promise.resolve();
  }
  if (themeName === 'custom') {
    const style =
      existing?.tagName === 'STYLE'
        ? existing
        : document.createElement('style');
    style.id = 'currentTheme';
    style.textContent = customThemeCss(palette);
    if (style !== existing) {
      existing?.remove();
      document.head.appendChild(style);
    }
    clearSystemStyles();
    return Promise.resolve();
  }

  const href = `/css/themes/${themeName}.css`;
  if (existing?.getAttribute('href')?.endsWith(href)) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const next = document.createElement('link');
    next.id = 'nextTheme';
    next.rel = 'stylesheet';
    next.href = href;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      next.onload = null;
      next.onerror = null;
      next.remove();
      resolve();
    };
    cancelPending = cancel;
    next.onload = () => {
      if (cancelled) return;
      existing?.remove();
      clearSystemStyles();
      next.id = 'currentTheme';
      if (cancelPending === cancel) cancelPending = undefined;
      resolve();
    };
    next.onerror = (error) => {
      if (cancelled) return;
      next.remove();
      if (cancelPending === cancel) cancelPending = undefined;
      reject(error);
    };
    document.head.appendChild(next);
  });
}
