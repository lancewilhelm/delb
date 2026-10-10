# Settings Persistence & SSR Preload

This document explains how user/global settings are persisted, how they are loaded during SSR, and how the theme is applied without a flash of unstyled content (FOUC).

## Goals

- Keep settings in **localStorage** for client-side persistence.
- Maintain **SSR theme correctness** to avoid FOUC.
- Treat the server as the **source of truth** for user/global settings.

---

## Storage Strategy

### Client-side persistence

Settings are persisted locally via Pinia persisted state with storage set to **localStorage** in `nuxt.config.ts`:

- `piniaPluginPersistedstate.storage = 'localStorage'`
- Stores using `persist: true` will now persist to localStorage.

This applies to:

- `userSettings`
- `globalSettings`
- `ui`

### Server-side source of truth

Settings are stored in the DB and fetched through:

- `GET /api/settings` → returns `userSettings`, `globalSettings`, and capabilities
- `PUT /api/settings/user` → persists user settings
- `PUT /api/settings/global` → persists global settings (admin-only)

---

## SSR Preload (No FOUC)

To avoid theme flashes, settings are pulled **server-side** before rendering.

### Flow

1. **SSR plugin** runs on the server and calls `GET /api/settings`.
2. The response is applied to:
   - `userSettingsStore.applyRemoteSettings(...)`
   - `globalSettingsStore.applyRemoteSettings(...)`
   - `globalSettingsStore.capabilities`
3. The theme plugin reads from `userSettingsStore.activeSettings.theme` and injects the proper theme stylesheet into `<head>`.

This ensures that the theme is already in place **before HTML is delivered**.

### SSR plugin file

- `app/plugins/00-settings-ssr.server.ts`

---

## Theme Initialization

### Server

- `app/plugins/init-theme.server.ts`
- Uses `userSettingsStore.activeSettings.theme` to set:
  ```html
  <link id="currentTheme" rel="stylesheet" href="/css/themes/<theme>.css" />
  ```

### Client

- `app/plugins/init-theme.client.ts`
- Watches `userSettingsStore.activeSettings.theme` and loads the theme with `loadTheme(...)`.

---

## Client Sync

- `app/plugins/sync.client.ts` pulls settings:
  - once when the app has a session (initial load), and
  - again on the transition to logged-in (e.g. after `/login` or `/register`).
- This ensures settings (including theme) apply without requiring a full reload.

Additionally, the `/login` and `/register` flows explicitly pull settings after `fetchSession()` to avoid showing the default theme during the post-login navigation.

---

## Why localStorage + SSR preload works

- **localStorage** is not available during SSR
- Therefore SSR must **fetch settings from the DB**
- Once SSR hydrates the store, the theme can be applied without a flash

---

## Sign-out Behavior

On logout:

- Stores are reset (`$reset`)
- Persisted localStorage keys are cleared:
  - `delb.userSettings`
  - `delb.globalSettings`
  - `delb.ui`

---

## Summary

| Concern               | Strategy                                |
| --------------------- | --------------------------------------- |
| Persistence           | localStorage (Pinia persisted state)    |
| SSR theme correctness | SSR preload via `/api/settings`         |
| Avoid FOUC            | Apply theme on SSR using hydrated store |
| Source of truth       | DB via `/api/settings`                  |

## Cover Access Security (Related)

Cover delivery is intentionally not configurable from user/global settings.

- Canonical endpoint: `GET /api/books/:id/cover?variant=thumb|source`
- Access model: authenticated session + collection membership visibility
- Caching: private revalidation (`ETag`, `Cache-Control: private, max-age=0, must-revalidate`)

For metadata "cover from URL" flows, Delb also enforces server-side URL/network/payload safeguards before returning bytes to the browser.

## Initial Owner Assignment

Delb ensures only one first user is promoted to system `owner` under concurrent registrations.

- First-user owner promotion is handled server-side with an atomic claim.
- Registration does not use a bootstrap token flow.
- Outside first-user promotion, registration behavior follows global settings (`allowRegistration`).

---

## Notes

- Mobile settings are stored as full copies when enabled.
- This simplifies mobile handling and keeps edits straightforward.
- Overrides/diffs are no longer used for mobile settings.

## Custom Theme

Appearance → Themes → Custom Theme provides one saved palette per settings
profile. The six editable colors are background, text, main, secondary, alternate
background, and error. On first opening, the editor captures the active preset's
computed colors. The Custom chip activates that palette; editing it while a preset
is selected leaves the preset active. The picker supports touch/pointer dragging,
keyboard arrows, hue/saturation/brightness sliders, and opaque hex input.

`BaseUserSettings.customTheme` stores the six colors as normalized six-digit hex
values, and `theme: 'custom'` selects it. Missing or invalid stored colors fall back
to Delb's default light palette. Separate mobile settings keep their own palette.
Changes update local settings immediately and use the existing 400 ms debounced
server sync; no additional endpoint or database migration is required.

For Custom, SSR emits a validated `#currentTheme` style instead of a stylesheet
link. The client watches both selection and palette changes to update that style
live. Preset selection replaces it after the stylesheet loads. Theme loading
cancels earlier pending requests so they cannot overwrite a later selection.
Command-palette preset previews restore the saved Custom palette when dismissed.
Caret and legacy error variants derive from Main and Error respectively.
