# Collections sharing & RBAC (v1)

This document describes Delb’s **minimal** collection sharing model and role-based access control (RBAC) for collections.

It builds on the “Personal-first” model described in `docs/ui-layout-philosophy.md`.

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

---

## UI location

All of the following actions happen inside the **Edit Collection** modal:

- rename collection
- manage members
- leave collection (non-owner)
- transfer ownership (owner-only)
- delete collection (owner-only, non-personal)