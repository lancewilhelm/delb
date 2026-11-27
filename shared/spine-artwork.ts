export type SpineEdits = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  stretch: boolean;
};

export const MINI_COVER_SPINE_RATIO = 1 / 3;
export const SPINE_RATIO_FIT_TOLERANCE = 0.04;
export const SPINE_RATIO_SLIGHT_TOLERANCE = 0.12;
export const SPINE_RATIO_VERY_WIDE_THRESHOLD = 1 / 1.5;

export type SpineRatioState = 'fit' | 'slight' | 'mismatch';
export type SpineRecommendedFit = 'crop' | 'fit' | 'stretch';

export type SpineRatioReport = {
  /** width / height */
  ratio: number;
  /** height / width (e.g. 3.0 for 1:3) */
  heightPerWidth: number;
  /** Formatted label such as "1:3.0" or "1:2.4" */
  label: string;
  /** Relative distance from 1:3 (0 means exact 1:3) */
  deviation: number;
  state: SpineRatioState;
  recommendedFit: SpineRecommendedFit;
  /** Approximate mm trimmed along the clipped axis if cropped to 10 × 30 mm */
  trimMm: number;
  /** Which dimension gets clipped when cropping to 1:3 */
  trimAxis: 'width' | 'height' | 'none';
};

export function spineRatioStatus(
  width: number,
  height: number,
): SpineRatioReport | null {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  const ratio = width / height;
  const heightPerWidth = height / width;
  const deviation =
    Math.abs(ratio - MINI_COVER_SPINE_RATIO) / MINI_COVER_SPINE_RATIO;
  const label = `1:${heightPerWidth.toFixed(1)}`;

  let trimAxis: 'width' | 'height' | 'none' = 'none';
  let trimMm = 0;
  if (ratio > MINI_COVER_SPINE_RATIO) {
    // Wider than 1:3 -> center-cropping trims width (scaled to 30mm tall)
    trimAxis = 'width';
    trimMm = Math.max(0, 30 * ratio - 10);
  } else if (ratio < MINI_COVER_SPINE_RATIO) {
    // Narrower than 1:3 -> center-cropping trims height (scaled to 10mm wide)
    trimAxis = 'height';
    trimMm = Math.max(0, 10 / ratio - 30);
  }

  if (deviation <= SPINE_RATIO_FIT_TOLERANCE) {
    return {
      ratio,
      heightPerWidth,
      label,
      deviation,
      state: 'fit',
      recommendedFit: 'stretch',
      trimMm: 0,
      trimAxis: 'none',
    };
  }
  if (deviation <= SPINE_RATIO_SLIGHT_TOLERANCE) {
    return {
      ratio,
      heightPerWidth,
      label,
      deviation,
      state: 'slight',
      recommendedFit: 'crop',
      trimMm,
      trimAxis,
    };
  }
  return {
    ratio,
    heightPerWidth,
    label,
    deviation,
    state: 'mismatch',
    recommendedFit: ratio > SPINE_RATIO_VERY_WIDE_THRESHOLD ? 'fit' : 'crop',
    trimMm,
    trimAxis,
  };
}

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
