/**
 * Loads the CSS file for the specified theme.
 * @param themeName - The name of the theme to load.
 */
export function loadTheme(themeName?: string): Promise<void> {
  if (!themeName) {
    return new Promise((resolve) => {
      const existing = document.querySelector<HTMLLinkElement>("#currentTheme");
      if (existing) {
        existing.remove();
      }
      resolve();
    });
  }
  return new Promise((resolve, reject) => {
    document.body.classList.add("theme-transitioning");
    const existing = document.querySelector<HTMLLinkElement>("#currentTheme");
    const oldTheme = existing || null;

    // Remove any previous pending theme switch
    const prevNext = document.querySelector("#nextTheme");
    if (prevNext) prevNext.remove();

    const next = document.createElement("link");
    next.id = "nextTheme";
    next.rel = "stylesheet";
    next.type = "text/css";
    next.href = `/css/themes/${themeName}.css`;

    next.onload = () => {
      if (oldTheme) oldTheme.remove();
      next.id = "currentTheme";
      resolve();
    };

    next.onerror = (err) => {
      console.error("Failed to load theme:", themeName, err);
      next.remove();
      reject(err);
    };

    // Insert after current theme to maintain stylesheet order
    if (oldTheme && oldTheme.parentNode) {
      oldTheme.parentNode.insertBefore(next, oldTheme.nextSibling);
    } else {
      document.head.appendChild(next);
    }

    // Remove the transition class after a delay
    setTimeout(() => {
      document.body.classList.remove("theme-transitioning");
    }, 1000);
  });
}
