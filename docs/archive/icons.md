# Icons (favicon + PWA)

> Historical asset note. The `pnpm icons:generate` command named below is absent from the current package scripts. Inspect [current assets](../../public) and [Nuxt head configuration](../../nuxt.config.ts) before changing icons.

This repo uses a **dynamic favicon** at runtime, but PWA and platform installers (iOS/Android/Windows) rely on **static icon files** referenced from the web manifest and `<head>`.

## Source of truth

- Base SVG: `public/favicon.svg`
- Generated outputs:
  - Favicons: `public/favicon.ico`, `public/favicon-16x16.png`, `public/favicon-32x32.png`
  - iOS: `public/apple-touch-icon.png`
  - Windows tile: `public/mstile-150x150.png` + `public/browserconfig.xml`
  - PWA icons: `public/icons/*` (referenced by `public/manifest.webmanifest`)

## Generate/update icons

- `pnpm icons:generate`

After generating, check that the relevant `<head>` links are present in `nuxt.config.ts`.
