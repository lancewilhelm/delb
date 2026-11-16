export type SpineEdits = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  stretch: boolean;
};
export const defaultSpineEdits = (): SpineEdits => ({
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
  stretch: false,
});
export function parseSpineEdits(value: unknown): SpineEdits | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    !('left' in value) ||
    !('right' in value) ||
    !('top' in value) ||
    !('bottom' in value) ||
    !('stretch' in value)
  )
    return null;
  const { left, right, top, bottom, stretch } = value;
  const percent = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 90;
  if (
    !percent(left) ||
    !percent(right) ||
    !percent(top) ||
    !percent(bottom) ||
    left + right > 95 ||
    top + bottom > 95 ||
    typeof stretch !== 'boolean'
  )
    return null;
  return { left, right, top, bottom, stretch };
}
