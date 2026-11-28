# Create an account and find your library

You need a running Delb installation and its URL. For a local demonstration with synthetic books, follow the [contributor setup](../developing/README.md#run-the-synthetic-demo).

## Create an account

1. Open Delb. An installation with no users redirects you to **Register**.
2. Enter your name, email address, password, and matching password confirmation. The current minimum password length is six characters.
3. Select **Register**.

Delb signs you in and opens the dashboard. On a fresh installation, the first successful bootstrap claimant becomes the system owner. Subsequent self-registrations create [Reader](library-access.md#server-roles) accounts, which can browse and read but not change the library. Registration can be closed by an administrator after initial setup.

If registration is closed, ask the installation administrator to create your account. Delb does not send invitation email.

## Find your library

Select **Books** in the navigation to browse the library. Every account shares the same library. An administrator can hide some books from your account with [tag visibility rules](library-access.md#tag-visibility-rules), so you might not see every book on the server.

Ask an administrator for the Editor role if you need to add or edit books.

## Use the dashboard

Select **Delb** in the header from any page to open the dashboard. It describes the books that you can see.

- The **All books** card shows your total, covers of recently added books, and a link for each reading status. Select **Browse all books** to open every book with filters cleared.
- **Continue reading** shows your latest logged progress or saved reader percentage. Right-click or long-press a cover to change its reading status.
- **Reading status** has a tile for each status. To be read opens your ranked queue; the others open the Books view filtered to that status.
- **Your shelves** has a tile for each personal shelf and a **New shelf** tile.

Each tile's **⋯** menu changes its card art: Collage, Fan, Stack, Shelf, Pile, or Wall. The All books card's **⋯** menu switches between Wall, Pile, and Shelf. The All books Wall starts at a random cover from your recent books each time you open the dashboard. **Wall motion** in **Appearance → Dashboard** can make the Wall drift upward through more of your covers. Shelf stands the books' spines in a row. Turn on **Spine art only** to show only books that have spine art.

A Pile shows a random handful of the list's books, and you can drag them around. In **Appearance → Dashboard**, **Pile size** sets how many books each pile holds, up to 250. **Pile pour** lets you drop books one by one (**Staggered**), drop them **All at once**, or start with the books in place (**No pour**). **Pour speed** controls the staggered drop. When your system reduces motion, the books start in place in every mode.

See the [dashboard reference](../developing/reference/dashboard.md) for list order and data rules.

![Dashboard with library counts above the reading shelf tabs](../images/dashboard.png)

## Sign in again

Open `/login`, enter your email and password, and select **Login**. Delb restores your account settings after sign-in.

If a form reports an error, correct the named field and submit again. A failed registration does not establish that an account or usable session exists.

## Change appearance from the command palette

1. Press **Command+Shift+P** on a Mac or **Ctrl+Shift+P** on another computer.
2. Search for a setting, such as **reading status badges**, **contrast**, or **system dark theme**.
3. Select a result to change it. Search results include settings inside groups and show the group name.

The palette also opens the custom theme editor and the grid and list field-order controls. Changes use the active device profile and save like changes in **Settings → Appearance**.

## Change the app font

Open **Settings → Appearance → Font** and select a font, such as **Allo** or **Katagami Text**. You can also search for either font by name in the command palette. The interface updates immediately and your choice saves automatically.

When editing a book description, select **HTML** to see the source in Paper Mono.

## Adjust interface contrast

1. Open **Settings → Appearance**.
2. Move **Contrast** below 100% to soften text and borders, or above 100% to strengthen them.
3. Select **Reset contrast to 100%** to restore the original theme.

Changes save automatically. When separate mobile settings are enabled, the slider changes the active device profile. See the [contrast reference](../developing/reference/settings.md#interface-contrast) for the text and border behavior.

Continue with [adding books](add-books.md). For the implementation behind registration and owner setup, read [account initialization](../developing/core-workflows.md#account-initialization).
