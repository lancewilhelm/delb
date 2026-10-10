export const themeColorRoles = [
  { key: 'bgColor', label: 'Background', variable: '--bg-color' },
  { key: 'textColor', label: 'Text', variable: '--text-color' },
  { key: 'mainColor', label: 'Main', variable: '--main-color' },
  { key: 'subColor', label: 'Secondary', variable: '--sub-color' },
  {
    key: 'subAltColor',
    label: 'Alternate Background',
    variable: '--sub-alt-color',
  },
  { key: 'errorColor', label: 'Error', variable: '--error-color' },
] as const;

export type ThemeColorKey = (typeof themeColorRoles)[number]['key'];
export type CustomTheme = Record<ThemeColorKey, string>;

export const defaultCustomTheme: CustomTheme = {
  bgColor: '#dddddd',
  textColor: '#1b1b1b',
  mainColor: '#1b1b1b',
  subColor: '#555555',
  subAltColor: '#cccccc',
  errorColor: '#883333',
};

export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const hex = value.trim();
  if (/^#[\da-f]{6}$/i.test(hex)) return hex.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(hex)) {
    return (
      '#' +
      hex
        .slice(1)
        .split('')
        .map((c) => c + c)
        .join('')
        .toLowerCase()
    );
  }
}

export function normalizeCustomTheme(value: unknown): CustomTheme {
  const source =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    themeColorRoles.map(({ key }) => [
      key,
      normalizeHex(source[key]) ?? defaultCustomTheme[key],
    ]),
  ) as CustomTheme;
}

export function customThemeCss(value: unknown): string {
  const palette = normalizeCustomTheme(value);
  const declarations = themeColorRoles.map(
    ({ key, variable }) => `${variable}:${palette[key]};`,
  );
  declarations.push(
    `--caret-color:${palette.mainColor};`,
    `--error-extra-color:${palette.errorColor};`,
    `--colorful-error-color:${palette.errorColor};`,
    `--colorful-error-extra-color:${palette.errorColor};`,
  );
  return `:root{${declarations.join('')}}`;
}

export function hexToHsv(hex: string) {
  const normalized = normalizeHex(hex) ?? '#000000';
  const [r, g, b] = [1, 3, 5].map(
    (start) => parseInt(normalized.slice(start, start + 2), 16) / 255,
  ) as [number, number, number];
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? (min === max ? 0 : delta / max) : 0, v: max };
}

export function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s,
    x = c * (1 - Math.abs(((h / 60) % 2) - 1)),
    m = v - c;
  const sectors = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ];
  const rgb = sectors[Math.floor((((h % 360) + 360) % 360) / 60)]!;
  return (
    '#' +
    rgb
      .map((value) =>
        Math.round((value + m) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
