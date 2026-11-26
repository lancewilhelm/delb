# Share the library and control access

Delb has one shared library. Every account on the server browses the same catalog of books. Each account keeps its own reading status, ratings, reviews, notes, reading positions, TBR queue, and Shelves, and no other account can see them.

Two settings decide what an account can do:

- Its **server role** decides whether it can change the library.
- Its **tag visibility rules** decide which books it can see.

## Server roles

| Role       | Can do                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**  | Everything an Admin can do. The first account on the server is the Owner. Its role cannot be changed, and it cannot be deleted.    |
| **Admin**  | Manage accounts, roles, tag visibility rules, and server settings. Add, edit, and delete books. Tag visibility rules never apply.  |
| **Editor** | Add books, edit book metadata and tags, upload and replace files, arrange the library bookshelf, and delete books.                 |
| **Reader** | Browse, read, and download the books they can see, and keep their own reading data. A Reader cannot add, edit, or delete any book. |

New accounts are Readers, both when someone signs up and when an Admin creates the account. A Reader who opens a Goodreads import can still bring in statuses, ratings, reviews, and Shelves for books that are already in the library, but cannot create the missing books.

### Change an account's role

1. Open **Settings → Admin → Users**.
2. Select the edit button beside the account.
3. Choose **admin**, **editor**, or **reader**.
4. Select **save**.

Only the Owner can edit another Admin. Nobody can edit the Owner.

## Tag visibility rules

Tag visibility rules let an Admin hide part of the library from one account without splitting the library. They use the shared tags that Editors and Admins add to books. For example, tag books `not-for-kids` and block that tag for a child's account, or tag books `family` and allow only that tag for a guest.

- An **allow** rule limits the account to books that have at least one allowed tag. When an account has no allow rules, it can see the whole library.
- A **hide** rule (a block rule) hides every book with that tag, even when the book also has an allowed tag.

A hidden book is hidden everywhere for that account: the Books page, search, Authors, Series, Publishers, Genres, Tags, dashboard counts, Shelves, the TBR queue, downloads, and connected agents. If someone opens a hidden book's link directly, Delb reports that the book was not found.

### Set an account's rules

1. Open **Settings → Admin → Users**.
2. Select the edit button beside an Editor or Reader account.
3. Under **tag visibility rules**, find each tag with the filter box and set it to **allow**, **hide**, or **no rule**.
4. Select **save tag rules**.

The summary above the list explains what the account will see. Rules take effect on the account's next request.

Rules do not apply to Owner and Admin accounts. An Editor with tag visibility rules can still edit the books they can see, but cannot rearrange the shared library bookshelf, because that layout includes books they cannot see.

### Keep rules in place

- A tag that a rule uses cannot be deleted. Remove it from the rules first.
- Merging a tag into another tag moves its rules to the destination tag. If an account had an allow rule on one tag and a hide rule on the other, the hide rule wins.
- Removing a tag from a book changes who can see that book. For example, removing `family` from a book hides it from an account that only allows `family`.

## Upgrade from pre-1.0 collections

Pre-1.0 preview versions split the library into collections with their own members and roles. If you are upgrading a pre-1.0 server, see [Upgrade to a single library](../hosting/single-library-upgrade.md) for what changes and how to review access after upgrading.

See the [library access reference](../developing/reference/library-access.md) and the [reading guide](reading.md).
