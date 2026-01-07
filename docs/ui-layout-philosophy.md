# Delb UI layout philosophy (collections, views, filters)

This document defines the **final, recommended UI layout paradigm** for Delb. It is designed to be internally consistent with Delb’s data model:

- **Collections** (scope boundary + sharing boundary)
- **Views** (representation modes: books vs authors vs series vs publishers)
- **Filters** (refinements: shelves/tags/ratings/etc)

The goal is to keep the mental model clean, prevent concepts from “showing up in two places”, and scale well from single-user to multi-user/shared collections.

---

## The collections paradigm (Personal-first)

Delb uses a **Personal-first** model that mirrors how modern photo apps work (e.g. “library + albums”):

- A **book always belongs to a user’s library** (their Personal collection).
- Additional collections act like **albums**:
  - a book can be included in multiple collections
  - collections can be used for sharing and collaboration
  - removing a book from a collection does *not* delete the book from the owner’s Personal library

This design prevents “orphaned” books that exist in the database but cannot be reached in the UI. It also makes it easy to share books without transferring ownership.

---

## Personal collection (default library)

Every user has exactly one **Personal** collection:

- It is created automatically (users do not need to create a collection before uploading/importing).
- It is visible in the collection picker like any other collection.
- It is the **default upload/import target** for that user.
- It is **non-deletable**.
- It is **not shareable**.
- Users may rename it, but it remains the user’s default Personal collection.

### Ownership rule (important)

Books are **owned by the uploader**.

- A shared collection can contain books from multiple users.
- Sharing a collection grants access to the *collection*, not ownership of the underlying books.
- Deleting a shared collection should never delete books from users’ Personal collections.

Future direction:
- Only the uploader/owner of a book should be able to permanently delete it.

---

## Upload & import behavior

### Uploads
When uploading books:

- Delb will **always** add uploaded books to your Personal collection.
- You may optionally add the same upload to additional collections.

In the UI this should be reflected by showing the Personal collection as **checked and not removable** (so you cannot uncheck it).

### Calibre import
When importing from Calibre:

- Imported books are **always** added to the importer’s Personal collection.
- You may optionally add imported books to additional collections.

This keeps import semantics consistent with upload semantics and ensures all books remain reachable in the UI.

---

## Core concepts & vocabulary

### Library
“The library” is the overall catalog a user interacts with in Delb. It contains many books and metadata, across one or more collections.

In Delb, a user's Personal collection serves as their default “library home” for uploads/imports. Other collections act like albums: they can include books from one or more users without changing ownership of the underlying book.

### Collection = scope boundary
A **collection** defines *which items exist in scope*, and who can see/edit them (sharing/collaboration).

Examples:
- `Personal` (default per-user collection; non-deletable, not shareable)
- `Family`
- `Book Club`
- `Work`

Collections (other than Personal) are **shareable** and can have **members** with roles.

### View = representation mode
A **view** defines *what kind of thing you’re looking at* in the main content area.

Views (v1 UI):
- `Books`
- `Authors` (placeholder)
- `Series` (placeholder)
- `Publishers` (placeholder)

### Filters = refinement
Filters narrow the result set *within the current scope + view*. Filters are always optional and stackable.

Examples:
- shelves (Reading / To Read / Read)
- tags (Fantasy, Sci-Fi, etc.)
- ratings (★★★★☆)
- later: language, format, year, publisher facets, etc.

---

## ✅ Final recommended layout

### 1) Header = Scope + Mode (global)

The header is global and should be the only place that controls:
- what exists in scope (collection)
- how you are looking at it (view)

Nothing else should compete with it.

#### Left / center: View selector (dropdown)
`Books ▾ | Authors | Series | Publishers`

- This changes the representation in the main content.
- It does **not** change which items exist in scope.

#### Right: Collection switcher (dropdown)
`Personal ▾`

- Contains:
  - `All` (special scope across all collections you can access)
  - Your Personal collection (default, non-deletable, not shareable)
  - Any shared collections you are a member of
  - Create/manage actions (create now, manage later)
- This defines *which books exist in scope*.

##### Hard rule
> **Exactly one collection context at a time**  
(Where `All` is a special single context meaning “all collections I can access”.)

---

### 2) Sidebar = Filters (stackable, optional)

The sidebar is **not navigation to entities**.
It is **pure refinement** of the current scope + view.

It should always answer:  
> “How do I narrow the current result set?”

The sidebar can be:
- resizable
- collapsible
- optional (if user wants more space)

#### Sidebar structure (top → bottom)

##### Shelves (state)
Single-select (radio buttons or pills):
- Reading
- To Read
- Read

Allowed special behavior:
- counts on each shelf
- quick transitions (later)
- defaults (later)

##### Tags (classification)
Multi-select:
- Fantasy
- LitRPG
- Sci‑Fi
- …

##### Ratings
Multi-select (or min rating / exact rating, depending on UX choice later):
- ★★★★★
- ★★★★☆
- …

##### (Later) Other facets
- Language
- Format
- Publisher
- Year
- etc.

> Sidebar content can change based on current view  
(e.g. a future `Authors` view may present different facets than `Books`).

---

### 3) Main content = Result set

The main content always represents:

> **“Items in this collection, shown as this view, filtered by these facets.”**

Examples:
- `Personal + Books + Reading + Fantasy`
- `Book Club + Authors + ★★★★☆`
- `All + Series + To Read`

This keeps the system unambiguous and avoids duplicated controls.

---

### 4) Collections in the sidebar? (optional, advanced)

Collections should not be the primary facet in the sidebar (because scope belongs in the header).
However, you may optionally include **collection shortcuts** for convenience, as long as they are clearly secondary and mirror the header selector.

Example:

```
▸ Collections (shortcuts)
  Personal
  Book Club
  Work
```

Rules if present:
- collapsed by default
- mirrors header selection (never diverges)
- never the primary way to switch scopes

If you omit sidebar collection shortcuts entirely, that is also correct.

---

## Why this layout works

This layout cleanly maps UI design to the data model:

- Collections = **scope**
- Views = **representation**
- Shelves = **user state**
- Tags = **metadata**
- Filters compose cleanly
- No concept appears in two roles
- Scales from personal usage to shared/collaborative collections

This pattern matches proven UX architectures used by:
- Calibre (when structured cleanly)
- music library apps
- IDEs
- data exploration tools

---

## The “sanity” rule

If you’re ever unsure where something belongs, ask:

> **Does this change what exists, or how I’m looking at it?**

- What exists → **Header (collection)**
- How I’m looking → **Header (view selector)**
- Narrowing → **Sidebar (filters)**

---

## Implementation notes (v1 placeholders)

For v1 UI implementation:
- `Books` view is real.
- `Authors`, `Series`, `Publishers` are placeholders that can render “Coming soon”.
- Sidebar sections can be present as placeholders even if filtering is not implemented yet.
- Collection switcher and view selector should be functional controls in the header.
