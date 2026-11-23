# Settings, appearance, and synchronization

Delb keeps account and global settings in the database and persists supported client state in localStorage. An inline SPA boot script applies persisted theme and font preferences before first paint. Client persistence improves continuity between visits; server rows remain the account-level source of truth.

## Settings ownership

| State                      | Owner and persistence                                                     |
| -------------------------- | ------------------------------------------------------------------------- |
| User settings              | Account JSON in `user_settings`; client store persists locally            |
| Global settings            | Installation JSON in `global_settings`; writes require system admin/owner |
| Provider secrets           | Server-side `global_secrets`; clients receive capability flags            |
| UI state and Books filters | Pinia stores with their own persistence choices                           |

The [user settings store](../../../app/stores/userSettings.ts) includes a desktop profile and optional mobile overrides. `activeSettings` selects the effective profile. [Device detection](../../../app/composables/useIsMobileDevice.ts) determines whether the mobile profile applies.

## Command palette

The [command palette](../../../app/composables/useCommandPalette.ts) uses the same user settings store and active device profile as Appearance settings. Search includes nested commands and displays their parent group. Theme selection uses `useThemeAppearance`; custom theme colors and book field order use the same components as Appearance settings.

## Client boot and sign-in

1. The inline [SPA boot script](../../../app/utils/spaBootScript.ts) reads `delb.userSettings` from `localStorage` and injects the active theme stylesheet (or custom theme CSS) and font family in `<head>` synchronously before first paint.
2. The [client auth plugin](../../../app/main.ts) fetches the active session via `GET /api/auth/get-session` before route middleware executes.
3. The [sync plugin](../../../app/plugins/init-sync.ts) pulls account and global settings via `GET /api/settings` when signed in, including after login and registration.

This keeps initial paint fast without server-side rendering while still reconciling persisted local preferences with database-backed account settings on load.

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

The [SPA boot script](../../../app/utils/spaBootScript.ts) injects the initial fixed, system, or custom theme resource synchronously before first paint. The [client plugin](../../../app/plugins/init-theme.ts) watches the OS preference, resolved theme, preview, and custom palette.

[useThemeAppearance](../../../app/composables/useThemeAppearance.ts) selects a fixed theme, assigns a light/dark slot, or returns to system mode. Theme previews do not become saved selections until a selection action updates the settings.

Custom colors live in `customTheme`. A theme slot or fixed choice can select `custom`; the palette then supplies CSS roles through [custom theme utilities](../../../app/utils/customTheme.ts). `theme: 'custom'` is the legacy shape, not the current settings contract.

## Interface contrast

**Settings → Appearance → Themes → Contrast** adjusts interface text and structural borders from 50–200%, in 5-point steps. The default and reset value is 100%, which preserves the original theme. Backgrounds, accent fills, book covers, and EPUB content retain their colors.

The control follows T3 Code's piecewise function. Below 100%, text blends toward the theme background in OKLab, while borders fade toward transparency. Above 100%, text blends toward black on light backgrounds or white on dark backgrounds. Borders blend toward the original foreground at one-quarter strength: 150% adds a 12.5% border boost, and 200% adds 25%.

Labels over accent and error fills use the fill's background and contrast target. Status messages retain their authored colors at 100% and follow the same text curve. Focus and selection accents keep their theme colors.

`appearanceContrast` belongs to each user settings profile, including independent mobile settings. Changes apply immediately and use the existing debounced account sync. Missing or invalid values use 100%; finite values are rounded and clamped to the supported range.

The [contrast utility](../../../app/utils/appearanceContrast.ts) owns the coefficients and chooses the target from the palette background. The [universal plugin](../../../app/plugins/init-contrast.ts) applies saved coefficients during SSR and client updates. Target rules follow fixed/system themes, custom palettes, and temporary previews without modifying the saved colors. [Shared CSS](../../../app/assets/css/main.css) derives separate text and border roles; browsers without OKLab color mixing retain the original theme.

## Write acknowledgements and concurrent changes

`PUT /api/settings/user` receives the settings document and its `updatedAt` revision. [The handler](../../../internal/settings/handlers.go) accepts a newer revision, or acknowledges an identical repeat of the stored revision/content. It returns the stored row and whether the write was accepted.

The client tracks acknowledged revisions. A rejected write rebases the pending local changes onto the returned server row and retries with a later revision. Stale pulls and delayed responses must not overwrite acknowledged or pending changes. User settings timestamps use millisecond storage; global settings use their separate server contract.

Synchronization is request-driven. The current implementation does not claim a live cross-device subscription. Other devices pull on the supported initialization/sign-in paths.

## Sign-out and permissions

The [auth composable](../../../app/composables/useAuth.ts) resets account/UI state and clears the known persisted account, collection, UI, and filter keys when signing out. Server sessions and each endpoint's permission checks remain authoritative.

Collection membership controls cover/file visibility. Settings persistence does not grant access to another user's books or expose provider tokens.

See [book view design record](../../archive/book-view-settings.md), [system architecture](../architecture.md), and [the verification record](../documentation-status.md).

## Cover reading-status badges

`coverStyle.showReadingStatus` defaults to `false`. **Reading status badges** in **Appearance → Cover Style** updates this setting through the existing settings sync and active desktop or mobile profile.

The badge appears in the top-right of grid, list, and dashboard shelf covers. It uses `--main-color` against `--bg-color`, stays outside cover grayscale effects, and is hidden during bulk selection mode. To be read uses a bookmark, Reading uses an open book, Finished uses a check, and DNF uses a circle-slash. An unset or unknown status has no badge.

## Spine gloss

`coverStyle.detailSpineGloss` defaults to `true`. **Spine gloss** in **Appearance → Cover Style** controls the shared gloss overlay on bookshelf spines and spine artwork in the book detail page. It uses the active desktop or mobile profile and is independent of the cover gloss setting, `coverStyle.glossySpine`. `coverStyle.grayscale` applies to both covers and spines.

## Book detail spine display

`coverStyle.showDetailSpine` defaults to `true`. **Show spine on book details** in **Appearance → Cover Style** controls whether custom spine artwork is shown beside the cover on book detail pages. It uses the active desktop or mobile profile and does not affect bookshelf views or the book editor. When disabled, book detail pages render the standalone cover and skip requesting the spine image.

## Spine generation prompt

The administrator can edit the shared generation prompt in **Settings → Admin → Spine generation**. The saved template is stored in `system_state` and applies to subsequent generation requests. It is a single prompt sent to the image endpoint, not a separate system-role message. The template must include `{{title}}`, `{{authors}}`, `{{reference}}`, and `{{instructions}}`. The server substitutes the book metadata, reference-image instructions, and the editor's additional instructions when building each request.

The [prompt endpoint](../../../internal/spines/prompt.go) requires an administrator and checks the last saved value to reject conflicting edits. The default template and substitution rules live in [spine-generation-prompt.ts](../../../shared/spine-generation-prompt.ts). Restoring the default in the editor takes effect when the administrator saves it.
