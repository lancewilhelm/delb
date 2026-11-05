---
status: proposed
---

# Give each book one collection and use a shared default

Delb's proposed collection model replaces automatic per-user Personal collections with one shared default. Each book entry belongs to exactly one collection. This gives new readers a shared starting library and replaces overlapping book memberships with exclusive collection membership.

The policy decisions below were confirmed during the design interview on 2026-11-05. No policy questions remain open. The consolidated design awaits final confirmation before implementation, and this document describes future behavior.

## Default and membership

- Initialize the shared collection with the name **Default**, owned by the system owner. Its name can change without changing its default designation.
- Administrators choose one instance-wide default from the existing collections.
- Add new users to the default as editors, with the existing editor powers to add books, rename the collection, and manage other members.
- Default membership follows ordinary collection rules. A non-owner can leave or be removed. Enrollment happens at account creation, and later sign-ins do not restore removed memberships.
- A user can belong to zero collections. Every collection must always have exactly one owner.
- Switching the default affects future enrollment and book creation. Existing memberships and books stay in their collections.
- Keep **All** as the combined view of the collections the reader can access.
- Retain collection settings and administration, including membership roles and ownership controls.
- Administrators can list collections, manage memberships, and reassign ownership through administrative controls without joining those collections. Ordinary browsing and **All** remain membership-based.

## Books and collection lifecycle

- Each book entry belongs to exactly one collection. Separate entries for the same title can exist in different collections.
- Collection owners and editors can edit metadata, replace files, and delete any book in their collection, including books added by another user. Book creator is provenance rather than a separate source of book-management authority.
- Moving a book requires owner or editor access to both its source and destination. Preserve the book's identity, files, and reading history. Explain the source collection's loss of access before confirmation.
- A collection must be empty before deletion. Its books must first be moved or explicitly deleted. The current default also requires a replacement default before deletion.
- Block account deletion while the account owns any collections. Transfer each collection, or empty and delete it, before deleting the owner account.

## Adding books and background imports

- Use the default when a book-creation request supplies no explicit collection target, subject to the caller's edit permission. Default designation grants no implicit membership.
- The Add book UI preselects the collection being browsed when the user can edit it. Otherwise, it selects the default when editable. If neither applies, require choosing or creating a collection. A user with zero collections sees an empty library with those actions. Uploading never silently rejoins a collection.
- When an interactive import matches an entry in another collection, offer an independent new entry or cancellation. Do not silently move or share the existing entry. Moving remains a separate confirmed action with source and destination authorization. Duplicate suggestions remain limited to books the importing user can access.
- Dropbox and Calibre use one explicitly configured target collection. When none is supplied, resolve an authorized default when the batch starts. Retain that destination throughout the batch, even if the system default changes.
- If a batch target disappears or its required access is revoked, stop affected imports with an actionable error. Do not silently redirect them to another collection.

## Migration

- Upgrade existing installations while preserving books, reading history, and access. Do not automatically expose private books through the shared default.
- Convert existing Personal collections into ordinary private collections and create a new shared **Default**. Split a book linked to several collections into an independent entry for each collection.
- Enroll existing users into the new default once as editors. Subsequent departures and removals remain respected.
- When splitting a book, preserve all reader-specific data, including status, ratings, notes, reading position, history, TBR rationale, and reading preferences. Copy that data to the resulting entries the reader can access. Later changes are independent per entry. Preserve history for readers who have already lost access without restoring their memberships.
- When a queued book splits into several entries the reader can access, keep those entries queued and adjacent at the original position. Preserve their private rationale and the relative order of other books. Each entry can subsequently be reordered independently.
- Move existing books without a collection into a private **Recovered books** collection owned by the system owner. Report them for administrative review instead of adding them to the shared default.
- Retain a Calibre source record's relationship with one designated entry. Other collection-specific copies are independent, and Calibre rescans must not overwrite them.
- Require a backup and an administrative preview before applying the migration. Show proposed splits, recovered books, enrollment changes, and which entries retain original IDs and Calibre relationships. Resolve ambiguous choices before applying. Migration must resume safely after interruption.

## Shared catalog terms and health checks

Authors, tags, series, and publishers remain shared catalog vocabulary. Ordinary book edits affect that entry. Deliberate global administration, such as merging a tag, continues to affect all collections and clearly states that scope.

Administrative health checks include cross-collection duplicate detection. Findings identify the matching books and their collections and invite review, because independent entries are valid. Do not automatically merge or delete entries. Identify incomplete scans.

## Implementation requirements

Ownership must remain consistent through collection creation, transfer, member removal, leaving, and account deletion, including concurrent requests and partial failures. At-most-one-owner enforcement alone does not satisfy the required-owner rule.

Account deletion currently has both a Better Auth path and a custom endpoint. The new ownership rule must cover every supported deletion path.

Every stored book must have exactly one collection. Creation, import, moves, collection deletion, and ownership changes must preserve that rule through retries, concurrent requests, and partial failures.

Collection-specific copies must not share mutable file paths that allow editing, moving, or deleting one entry's files to break another entry. Preserve managed-file recovery guarantees during migration.

Replace the health check that expects a Personal collection for each user. The new checks validate the default designation, required collection ownership, and exclusive book membership. A user with zero collection memberships is valid.

## Current implementation

The [collection access reference](../developing/reference/collections.md) describes many-to-many book membership, protected Personal collections, and separate creator permissions. The [data model](../developing/data-model.md) describes the associated catalog and reader-specific records.

Collection deletion currently removes memberships and book links while retaining book records and files. Exclusive membership requires an explicit replacement for that behavior.

The existing [administrative health checks](../hosting/health-checks.md) already report duplicate identifiers and bounded fuzzy matches. Cross-collection review can build on those checks, but a clean bounded scan does not establish that no duplicates exist.
