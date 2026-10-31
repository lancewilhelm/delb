export interface ThemePreference {
  mode: 'fixed' | 'system';
  fixed: string;
  light: string;
  dark: string;
}

export function defaultThemePreference(): ThemePreference {
  return {
    mode: 'system',
    fixed: 'guage_light',
    light: 'guage_light',
    dark: 'guage_dark',
  };
}

export function normalizeThemePreference(
  value: unknown,
  legacy?: unknown,
): ThemePreference {
  const defaults = defaultThemePreference();
  if (typeof legacy === 'string' && /^[a-zA-Z0-9_-]+$/.test(legacy))
    return { ...defaults, mode: 'fixed', fixed: legacy };
  if (!value || typeof value !== 'object') return defaults;
  const source = value as Record<string, unknown>;
  const theme = (name: unknown, fallback: string) =>
    typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name) ? name : fallback;
  return {
    mode: source.mode === 'fixed' ? 'fixed' : 'system',
    fixed: theme(source.fixed, defaults.fixed),
    light: theme(source.light, defaults.light),
    dark: theme(source.dark, defaults.dark),
  };
}

export function resolveTheme(
  preference: ThemePreference,
  dark: boolean,
): string {
  return preference.mode === 'fixed'
    ? preference.fixed
    : dark
      ? preference.dark
      : preference.light;
}
