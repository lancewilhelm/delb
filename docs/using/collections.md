# Organize and share collections

Each book entry belongs to one collection. Sharing a collection exposes its books while each reader keeps private reading status, ratings, positions, notes, and history.

## Use the shared default

New users join the default collection as editors. It initially has the name **Default**, which can change. Open the collection picker to choose a collection or **All**, which combines only collections you can access.

Administrators can choose **Make default** in a collection's settings from the collection picker, or in **Settings → Admin → Collections**. Delb selects the shared default when members open the app and uses it as the fallback for new books. Switching affects future registrations without moving existing books or changing memberships. Browsing another collection keeps that selection until you reopen the app.

## Create a collection

1. Open the collection picker.
2. Select **Create collection**.
3. Enter a name and create it.

You become its owner. Every collection retains exactly one owner. You can belong to zero collections; create one or ask an owner for access when your library is empty.

## Move books

1. Open a book's collection control, or select books in **Books** and choose **Actions → Move to collection**.
2. Choose one destination you can edit.
3. Acknowledge the access change.
4. Select **Move books**.

Owner or editor access is required in both source and destination. The move preserves book identity, files, and reading history. Readers who only belong to the source lose access. A specific collection supports all-with-exclusions selection. In **All**, select individual books.

Independent entries for the same title can exist in different collections. Their book metadata, files, and subsequent reading state are independent.

## Share a collection

1. Open **Collection settings** beside a collection you own or edit.
2. Enter an existing reader's email address.
3. Choose **Viewer** or **Editor** and select **Save access**.

Access saves immediately. Viewers read books and manage their own reading data. Owners and editors also manage books, rename the collection, and manage non-owner members. Book creator is provenance rather than an extra permission.

## Leave, transfer, or delete

Open **Collection settings**, choose the action, and complete its confirmation.

- **Leave collection** removes a non-owner's membership, including default membership. Sign-in does not restore it.
- **Transfer ownership** makes the recipient the owner and the previous owner an editor.
- **Delete collection** permanently removes the collection, every book in it, their managed files and covers, and all members' reading data. Review the first warning, select **Continue to final warning**, then type the collection name and select **Delete collection and books**. You can cancel at either warning. Replace the current default before deleting it. To keep books, move them to another collection first.

Accounts owning collections cannot be deleted until those collections are transferred or deleted. Administrators can manage memberships and recover ownership without joining. Ordinary browsing remains membership-based.

See the [permissions reference](../developing/reference/collections.md), [migration guide](../hosting/collection-migration.md), and [reading guide](reading.md).
