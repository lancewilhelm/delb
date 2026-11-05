import { defaultCustomTheme, normalizeHex } from './customTheme';

export const MIN_APPEARANCE_CONTRAST = 50;
export const MAX_APPEARANCE_CONTRAST = 200;
export const DEFAULT_APPEARANCE_CONTRAST = 100;

export function normalizeAppearanceContrast(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_APPEARANCE_CONTRAST;
  }
  return Math.min(
    MAX_APPEARANCE_CONTRAST,
    Math.max(MIN_APPEARANCE_CONTRAST, Math.round(value)),
  );
}

export function appearanceContrastVariables(value: number) {
  const contrast = normalizeAppearanceContrast(value);
  return {
    '--appearance-contrast-base': `${Math.min(contrast, 100)}%`,
    '--appearance-contrast-boost': `${Math.max(contrast - 100, 0)}%`,
    '--appearance-contrast-border-boost': `${Math.max(contrast - 100, 0) / 4}%`,
  };
}

export function appearanceContrastTarget(
  background: string,
): 'black' | 'white' {
  const hex = normalizeHex(background) ?? defaultCustomTheme.bgColor;
  const luminance = [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const start = index * 2 + 1;
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    const linear =
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    return sum + linear * weight;
  }, 0);
  return luminance > 0.179 ? 'black' : 'white';
}
