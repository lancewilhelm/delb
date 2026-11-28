export const fontFamilies = [
  ['Allo', 'sans-serif'],
  ['Fira Code', 'monospace'],
  ['Geist', 'sans-serif'],
  ['IBM Plex Mono', 'monospace'],
  ['Inter', 'sans-serif'],
  ['Katagami Text', 'sans-serif'],
  ['Montserrat', 'sans-serif'],
  ['Noto Serif', 'serif'],
  ['Nunito', 'sans-serif'],
  ['Poppins', 'sans-serif'],
  ['PT Serif', 'serif'],
  ['Roboto Mono', 'monospace'],
] as const;

export type FontFamily = (typeof fontFamilies)[number][0];
export const fontFamilyOptions = fontFamilies.map(([family]) => family);
