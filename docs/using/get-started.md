# Create an account and find your library

You need a running Delb installation and its URL. For a local demonstration with synthetic books, follow the [contributor setup](../developing/README.md#run-the-synthetic-demo).

## Create an account

1. Open Delb. An installation with no users redirects you to **Register**.
2. Enter your name, email address, password, and matching password confirmation. The current minimum password length is six characters.
3. Select **Register**.

Delb signs you in and opens the dashboard. On a fresh installation, the first successful bootstrap claimant becomes the system owner. Subsequent self-registrations create normal users. Registration can be closed by an administrator after initial setup.

If registration is closed, ask the installation administrator to create your account. Collection sharing uses an existing account's email address; adding a collection member does not send an invitation email.

## Find your library

1. Open the collection picker beside **Delb** in the header.
2. Select **Personal** to see your default collection, or **All** to include every collection you can access.
3. Select **Books** in the navigation to browse books in that scope.

Your Personal collection starts empty. Delb includes it when you add books through the Add book interface. You can rename it, but you cannot share or delete it.

**All** includes books in shared collections where you are a member. It does not expose every book stored on the installation.

## Sign in again

Open `/login`, enter your email and password, and select **Login**. Delb restores your account settings after sign-in.

If a form reports an error, correct the named field and submit again. A failed registration does not establish that an account or usable session exists.

## Adjust menu and dialog transparency

1. Open **Settings → Appearance**.
2. Move **Glass opacity** toward 40% for more transparency or 100% for solid menus and dialogs.
3. Open the collection picker or global search to see the effect. Text stays opaque.

Changes save automatically. Select **Reset glass opacity to 80%** to restore the default. If separate mobile settings are enabled, the slider changes the active device profile.

See the [appearance settings reference](../developing/reference/settings.md#menu-and-dialog-opacity) for supported values and persistence behavior.

Continue with [adding books](add-books.md). For the implementation behind registration and Personal collections, read [account initialization](../developing/core-workflows.md#account-initialization).
