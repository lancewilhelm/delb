export const MIN_GLASS_OPACITY = 40;
export const MAX_GLASS_OPACITY = 100;
export const DEFAULT_GLASS_OPACITY = 80;

export function normalizeGlassOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_GLASS_OPACITY;
  }
  return Math.min(
    MAX_GLASS_OPACITY,
    Math.max(MIN_GLASS_OPACITY, Math.round(value)),
  );
}
