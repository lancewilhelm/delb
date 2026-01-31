# Auth UI error handling

The guest-only auth pages use inline, user-friendly error messages instead of `alert()` popups.

## Where it lives

- Login page: `app/pages/login.vue`
- Register page: `app/pages/register.vue`
- Error message mapping helpers: `app/utils/authErrors.ts`
- Non-shifting error UI (reserved space + fade): `app/components/AuthFormError.vue`

## Notes

- Login errors intentionally avoid leaking details (shows a generic invalid-credentials message).
- Register errors try to map common backend failures (duplicate email, registration closed, rate limit) to friendly messages.
- `AuthFormError` reserves vertical space so the form does not jump when an error appears/disappears.

## Admin user management

The admin settings UI can manage users (create, edit, ban, delete). Editing supports:

- Update user `name`, `email`, and `role`
- Set a new password directly (used as the current “password reset” approach)

Because no email provider is configured, there is currently no self-serve “forgot password” email flow. For now, an admin sets a new password and shares it out-of-band.

Implementation:

- UI: `app/components/Settings/SettingsAdminUsers.vue`
