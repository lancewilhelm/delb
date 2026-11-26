# Auth UI error handling

The guest-only auth pages use inline error messages instead of `alert()` popups.

## Where it lives

- Login page: [`app/pages/login.vue`](../../../app/pages/login.vue)
- Register page: [`app/pages/register.vue`](../../../app/pages/register.vue)
- Error message mapping helpers: [`app/utils/authErrors.ts`](../../../app/utils/authErrors.ts)
- Non-shifting error UI (reserved space and fade): [`app/components/AuthFormError.vue`](../../../app/components/AuthFormError.vue)
- Backend auth endpoints: [`internal/auth/handlers.go`](../../../internal/auth/handlers.go)

## Notes

- Login errors avoid leaking account details by returning a generic invalid-credentials message.
- Register errors map common backend failures (duplicate email, registration closed, rate limit) to readable messages.
- `AuthFormError` reserves vertical space so the form does not jump when an error appears or clears.

## Admin user management

The admin settings UI under **Settings → Admin → Users** manages accounts (create, edit, ban, delete, and tag visibility rules). Editing an account supports:

- Updating user `name`, `email`, and `role`.
- Setting a new password directly.

Because Delb does not configure an email provider, there is no self-serve password-reset email flow. An administrator sets a new password and shares it out of band.

Implementation:

- UI: [`app/components/Settings/SettingsAdminUsers.vue`](../../../app/components/Settings/SettingsAdminUsers.vue)
- API: [`internal/auth/handlers.go`](../../../internal/auth/handlers.go) and [`internal/users/tag_rules.go`](../../../internal/users/tag_rules.go)
