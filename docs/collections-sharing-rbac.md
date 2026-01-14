# Collections sharing & RBAC (v1)

> Note: This doc describes the **sharing model** and **permissions**. Bulk book editing endpoints are included below because they are tightly coupled to RBAC and scope guardrails.

This document describes Delb’s **minimal** collection sharing model and role-based access control (RBAC) for collections.

It builds on the “Personal-first” model described in `docs/ui-layout-philosophy.md`.

---

## Important open question: “re-sharing” books into your own collections

Delb’s core model is:

- **Collections are the visibility boundary.**
- Books are “visible” to a user if they exist in **at least one** collection the user is a member of.

However, the UI/UX goal is also:

- A user who can see a book (because it exists in a shared collection) should be able to add that book to **other collections they can edit** (including their own collections).

This introduces an RBAC/UX edge case that is **not fully specified yet**:

### Edge case: access revoked from the original shared collection
Scenario:
1. User **A** shares collection **C_shared** with user **B** (B can view or edit it).
2. Book **X** is in **C_shared**, so **B** can see book **X**.
3. While B still has access, B adds book **X** to another collection they can edit (e.g. **C_b_personal** or another shared collection **C_other**).
4. Later, A removes B from **C_shared**.

Question:
- Should B still be able to access book **X** via **C_b_personal** / **C_other**?

There are two defensible policies:

**Policy 1 (sticky re-share):**  
If B successfully adds X to a collection B can edit at the time of the action, then X remains visible via that other collection even after access to the original source collection is revoked.

**Policy 2 (non-sticky / provenance-bounded):**  
Visibility is strictly bounded to the original sharing boundary; if access to the collection that “introduced” the book is revoked, any derived links should be removed or become invalid.

v1 stance:
- Delb currently leans toward a “visibility via any accessible collection” rule, which implies **Policy 1**.
- If/when this becomes a problem, we may need to introduce provenance tracking (e.g. “book access grants” or “link source collection”) to support Policy 2, or introduce explicit ownership constraints.

Until this is formalized, treat this as a known RBAC edge case to revisit when:
- you add stricter ownership semantics,
- you add book-level sharing permissions,
- or you introduce “unlink from source” / “revoke derived access” features.

---

## Quick mental model

- A **collection** is a *sharing boundary* and a *visibility boundary*.
- Sharing grants access to the **collection**, not ownership of the underlying books.
- A user’s **Personal** collection is special:
  - always exists per user
  - **not shareable**
  - **non-deletable**
  - users may rename it

---

## Roles

Collections support exactly these roles:

- `owner`
- `editor`
- `viewer`

### Single-owner invariant (important)
Collections are intended to have **exactly one `owner`**.

When ownership is transferred, the recipient becomes the **sole** owner and the previous owner becomes an `editor`.

> Note: Some early/legacy data could theoretically contain multiple owners. The ownership transfer flow is implemented to correct this by ensuring the result is one owner.

---

## Permissions (v1)

| Capability | owner | editor | viewer |
|---|---:|---:|---:|
| View collection | ✅ | ✅ | ✅ |
| Rename collection | ✅ | ✅ | ❌ |
| List members | ✅ | ✅ | ❌ |
| Add members (by email) | ✅ | ✅ | ❌ |
| Remove members | ✅ | ✅ | ❌ |
| Delete collection | ✅ | ❌ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ |
| Leave collection (remove self) | ❌ | ✅ | ✅ |

### Notes
- Only the **owner** can delete a collection.
- **Owners cannot leave** a collection. They must either delete it or transfer ownership.
- Member management and deletion are performed from the **Edit Collection** modal.

---

## Member management

### Add / update member (by email)
Members are added using their **email address**. If the user already belongs to the collection, the role is updated.

High-level rules:
- Personal collections cannot be shared.
- Only `owner` and `editor` can add/update members.
- You cannot change your own role through the “add/update member” action.

---

## Leaving a collection (self-removal)

A user may remove themselves from a collection if they are **not** the owner.

- `editor` and `viewer` can leave.
- `owner` cannot leave.

Because leaving is effectively irreversible from the member’s perspective (they lose access until re-added), the UI requires a **confirmation** step before leaving.

---

## Ownership transfer

Ownership transfer is **owner-only** and is designed to enforce “one owner per collection”.

### Behavior
- Ownership is transferred by providing the **new owner’s email**.
- The new owner becomes the **sole** `owner`.
- The previous owner becomes an `editor`.

Because ownership transfer is irreversible from the original owner’s perspective (you lose delete/ownership privileges), the UI requires a **confirmation** step before transferring.

---

## Deletion

- Only the `owner` can delete a collection.
- Personal collections cannot be deleted.
- Deleting a collection removes:
  - the collection record
  - all membership records
  - all collection-book link records
- Books themselves are not deleted; only the container and its links are removed.

---

## API surface (for reference)

These endpoints exist to support the v1 model:

- `GET /api/collections/:id/members`  
  Returns members for the collection (includes email).

- `PUT /api/collections/:id/members`  
  Add/update a member by email with a role.

- `DELETE /api/collections/:id/members/:userId`  
  Remove a member (owner/editor). Prevents removing the owner and prevents removing yourself here (use leave flow).

- `POST /api/collections/:id/leave`  
  Current user leaves the collection (non-owner only).

- `POST /api/collections/:id/transfer-ownership`  
  Owner transfers ownership (by email). Enforces sole-owner result.

- `DELETE /api/collections/:id`  
  Owner deletes the collection (non-personal only).

### Bulk book actions (collection-scoped)

- `POST /api/collections/:id/books/bulk`  
  Apply bulk add/remove operations to books within the context of a **specific collection**.

#### Key guardrails and RBAC
- Caller must be an `owner` or `editor` of the **scope collection** (`:id`) to perform any bulk operation.
- For `addToCollectionIds` / `removeFromCollectionIds`, the caller must also be an `owner` or `editor` of each **target collection** being mutated.
- **Personal collections** are **non-removable** in bulk operations (attempts are ignored and reported as such).
- This endpoint is intentionally **collection-scoped**. There is no “bulk across All view” server semantic.

#### Request shape
The endpoint supports two selection models:

1) Explicit IDs (client enumerates selected books):
- `allInCollection: false`
- `bookIds: string[]`

2) Scope-wide selection (do not enumerate IDs):
- `allInCollection: true`
- `excludedBookIds: string[]` (optional)

Along with one or both operations:
- `addToCollectionIds: string[]` (optional)
- `removeFromCollectionIds: string[]` (optional)

#### Response shape (high level)
- `booksResolved`: how many book ids the server applied the operation to (after exclusions / scope resolution)
- `added`: list of `{ collectionId, bookId }` pairs that were added
- `removed`: list of `{ collectionId, bookId }` pairs that were removed
- `forbidden`: collection ids the caller attempted to mutate without sufficient role
- `ignoredPersonalRemovals`: collection ids that were requested for removal but were personal (non-removable)

---

## UI location

All of the following actions happen inside the **Edit Collection** modal:

- rename collection
- manage members
- leave collection (non-owner)
- transfer ownership (owner-only)
- delete collection (owner-only, non-personal)