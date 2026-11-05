# Settings, appearance, and synchronization

Delb keeps account and global settings in the database and persists supported client state in localStorage. Server rendering loads the account settings before applying the theme. Client persistence improves continuity between visits; server rows remain the account-level source of truth.

## Settings ownership

| State                      | Owner and persistence                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| User settings              | Account JSON in `user_settings`; client store persists locally            |
| Global settings            | Installation JSON in `global_settings`; writes require system admin/owner |
| Provider secrets           | Server-side `global_secrets`; clients receive capability flags            |
| UI state and Books filters | Pinia stores with their own persistence choices                           |

The [user settings store](../../../app/stores/userSettings.ts) includes a desktop profile and optional mobile overrides. `activeSettings` selects the effective profile. [Device detection](../../../app/composables/useIsMobileDevice.ts) determines whether the mobile profile applies.

## Server rendering and sign-in

1. The [auth plugin](../../../app/plugins/auth.server.ts) loads the session.
2. [Settings preload](../../../app/plugins/00-settings-ssr.server.ts) calls `GET /api/settings` with the request cookie and applies the returned settings and capabilities.
3. The server theme/font plugins add the selected resources to the HTML.
4. The browser hydrates the stores. The [sync plugin](../../../app/plugins/sync.client.ts) pulls settings when signed in, including after login and registration.

This gives server rendering access to database-backed settings without reading browser localStorage. Failed preload can still fall back to defaults; the mechanism does not prove every deployment is free of appearance flashes.

## Fixed and system appearance

The current account field is `themePreference`, defined in [themePreference.ts](../../../app/utils/themePreference.ts):

```json
{
  "mode": "system",
  "fixed": "guage_light",
  "light": "guage_light",
  "dark": "guage_dark"
}
```

Fixed mode uses `fixed`. System mode chooses `light` or `dark` from the operating-system preference. The defaults use system mode with the Guage light/dark pair. A legacy `theme` value migrates to a fixed preference when the store normalizes it.

The [server theme plugin](../../../app/plugins/init-theme.server.ts) emits either a fixed stylesheet or separate light/dark resources with media queries. The [client plugin](../../../app/plugins/init-theme.client.ts) watches the OS preference, resolved theme, preview, and custom palette.

[useThemeAppearance](../../../app/composables/useThemeAppearance.ts) selects a fixed theme, assigns a light/dark slot, or returns to system mode. Theme previews do not become saved selections until a selection action updates the settings.

Custom colors live in `customTheme`. A theme slot or fixed choice can select `custom`; the palette then supplies CSS roles through [custom theme utilities](../../../app/utils/customTheme.ts). `theme: 'custom'` is the legacy shape, not the current settings contract.

## Menu and dialog opacity

**Settings → Appearance → Glass opacity** controls floating menus and dialogs from 40–100% in 5-point slider steps. The default and reset value is 80%. Text and controls stay opaque. The main page, header, sidebar, and reading content retain their existing backgrounds.

`glassOpacity` belongs to each user settings profile, so enabled mobile overrides can keep a separate value. Changes apply locally immediately and use the existing debounced settings sync. Non-numeric saved values use the default; finite numbers are rounded and clamped to the supported range.

The [glass plugin](../../../app/plugins/init-glass.ts) sets reactive CSS variables during server rendering and client updates. [Shared glass styling](../../../app/assets/css/main.css) mixes the current theme background with transparency and adds backdrop blur. At 100%, blur is disabled. Browsers without the required color mixing or backdrop filtering render opaque surfaces.

## Write acknowledgements and concurrent changes

`PUT /api/settings/user` receives the settings document and its `updatedAt` revision. [The handler](../../../server/api/settings/user.put.ts) accepts a newer revision, or acknowledges an identical repeat of the stored revision/content. It returns the stored row and whether the write was accepted.

The client tracks acknowledged revisions. A rejected write rebases the pending local changes onto the returned server row and retries with a later revision. Stale pulls and delayed responses must not overwrite acknowledged or pending changes. User settings timestamps use millisecond storage; global settings use their separate server contract.

Synchronization is request-driven. The current implementation does not claim a live cross-device subscription. Other devices pull on the supported initialization/sign-in paths.

## Sign-out and permissions

The [auth composable](../../../app/composables/useAuth.ts) resets account/UI state and clears the known persisted account, collection, UI, and filter keys when signing out. Server sessions and each endpoint's permission checks remain authoritative.

Collection membership controls cover/file visibility. Settings persistence does not grant access to another user's books or expose provider tokens.

See [book view design record](../../archive/book-view-settings.md), [system architecture](../architecture.md), and [the verification record](../documentation-status.md).
