# Delb UI layout philosophy (collections, views, filters)

This document defines the **final, recommended UI layout paradigm** for Delb. It is designed to be internally consistent with Delb’s data model:

- **Collections** (shareable containers / scope)
- **Views** (representation modes: books vs authors vs series vs publishers)
- **Filters** (refinements: shelves/tags/ratings/etc)

The goal is to keep the mental model clean, prevent concepts from “showing up in two places”, and scale well from single-user to multi-user/shared collections.

---

## Core concepts & vocabulary

### Library
“The library” is the overall catalog a user interacts with in Delb. It contains many books and metadata, across one or more collections.

### Collection = scope boundary
A **collection** defines *which items exist in scope*, and who can see/edit them (sharing/collaboration).

Examples:
- `Personal`
- `Family`
- `Book Club`
- `Work`

Collections are **shareable** and can have **members** with roles.

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
  - All user-visible collections (personal + shared)
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
