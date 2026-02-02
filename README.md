# Delb

![Nuxt](https://img.shields.io/badge/Nuxt%204-%23000000?style=for-the-badge&logo=nuxt)
![Vue](https://img.shields.io/badge/Vue%203-%23191A22?style=for-the-badge&logo=vuedotjs)
![Tailwind](https://img.shields.io/badge/Tailwind%20v4-%231a202c?style=for-the-badge&logo=tailwind-css)
![SQLite](https://img.shields.io/badge/SQLite-%231a202c?style=for-the-badge&logo=sqlite)
![Drizzle](https://img.shields.io/badge/Drizzle%20ORM-%231a202c?style=for-the-badge&logo=drizzle)

A modern, self-hosted digital library manager built with Nuxt. Manage your ebook collection with a clean web interface.

## Collections model (Personal-first)

Delb uses a **Personal-first** collections model (similar to modern photo apps: “library + albums”):

- Every user has a default **Personal** collection (created automatically).
- **All uploads/imports go to Personal by default**. Books may also be added to other collections.
- Personal is **non-deletable** and **not shareable**.
- Other collections can be shared and act like albums: a book can appear in multiple collections without changing ownership.
- Books are **owned by the uploader** (future direction: only the uploader can permanently delete a book).

### Sharing / RBAC (collections)

Non-Personal collections can be shared with roles:

- `owner`: can rename, manage members, transfer ownership, and delete the collection
- `editor`: can rename and manage members
- `viewer`: read-only access

Only one `owner` is allowed per collection. Non-owners may leave a shared collection.

See `docs/ui-layout-philosophy.md` for the complete philosophy and UI implications.

## Calibre import (migration)

Delb can **migrate** an existing Calibre library into its own managed `library/` structure.

- Calibre library root is mounted at: `calibre/`
- Calibre database is read from: `calibre/metadata.db`
- Delb writes its own database to: `data/delb.db`
- Delb **copies** book files into `library/...` and manages them thereafter.

### Caveats (important)

- **One-way migration:** Delb edits do **not** flow back to Calibre after migration.
- **Editing metadata in Delb:** Editing titles/authors/tags in Delb updates `data/delb.db` and may move files in `library/` to keep paths human-readable.
- **Recommendation:** Keep your original Calibre library as a read-only archive if you might need to return to Calibre.

See:

- `docs/calibre-import.md` for the import process + caveats
- `docs/calibre-database-schema.md` for Calibre schema reference

## Features

- **Library Management** - Upload, organize, and browse your ebook collection
- **Multi-user Support** - User authentication with role-based permissions (owner, admin, user, guest)
- **Modern UI** - Clean, responsive interface with theme support
- **Book Details** - View metadata, descriptions, and cover images (admins can edit metadata, authors, and covers)
- **Direct Downloads** - Download books directly from the web interface
- **Search & Filter** - Find books quickly with search and filtering
- **SQLite Database** - Lightweight, file-based database with Drizzle ORM

## Tech Stack

- **Framework**: Nuxt 4 (Vue 3)
- **Styling**: Tailwind CSS v4 with UnoCSS
- **Database**: SQLite with Drizzle ORM
- **Authentication**: Better Auth with session management
- **File Storage**: Local filesystem (`library/` directory)

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (recommended package manager)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd delb

# Install dependencies
pnpm install

# Set up the database
pnpm run db:push

# Start development server
pnpm run dev
```

The application will be available at `http://localhost:3000`.

### First-Time Setup

1. On first run, create an owner account through the registration page
2. The first user registered becomes the owner with full admin privileges
3. Additional users can be invited or registered with appropriate roles
4. Admins/owners can edit a book at `/books/{id}/edit` (an **Edit** button appears on the book page for admins), including:
   - Metadata fields (title, description, published, language, series/publisher IDs)
   - Authors (single field; can be comma-separated for multiple authors)
   - Cover image upload (stored as `cover.webp` alongside the book file)

## Project Structure

```
delb/
├── app/              # Nuxt application code
│   ├── components/   # Vue components
│   ├── composables/  # Vue composables
│   ├── pages/        # Route pages (book detail at /book/[id])
│   └── utils/        # Utilities and database schema
├── library/          # Book storage directory (gitignored)
├── data/             # SQLite database location (gitignored)
├── docs/             # Project documentation
├── server/           # Nuxt server code
│   ├── api/          # API endpoints
│   └── utils/        # Server utilities
└── scratch/          # Development scratch space
```

## Documentation

- [Known Issues](docs/known-issues.md) - Known bugs and workarounds
- [Tooltip Guide](docs/tooltip.md) - Component documentation
- [Calibre Import](docs/calibre-import.md) - Migration process + caveats
- [Calibre Database Schema](docs/calibre-database-schema.md) - Reference schema
- [Health Checks](docs/health-checks.md) - Planned library/database integrity checks

## Development

```bash
# Run dev server
pnpm run dev

# Build for production
pnpm run build

# Preview production build
pnpm run preview

# Push database schema changes
pnpm run db:push

# Generate Drizzle migrations
pnpm run db:generate

# Open Drizzle Studio
pnpm run db:studio
```

## Storage

Books are stored in the `library/` directory at the project root. New Delb-created
entries use the canonical structure:

```
library/
└── {author}/
    └── {title}/
        ├── {book-file}.epub|pdf|mobi|azw3
        └── cover.webp
```

The database stores relative paths and metadata for each book. Delb manages the
on-disk library layout and will move/rename folders when author/title metadata
changes so the filesystem stays human-readable.

Delb also supports **reference-only books** (no associated file in `library/`). This allows using Delb as a “physical library” catalog in addition to a file-backed ebook library.

## Dropbox ingestion

Delb can watch a local `dropbox/` directory and automatically ingest supported book files.

- Drop a file into `dropbox/` (`.epub`, `.pdf`, `.mobi`, `.azw3` by default).
- The server moves it into `library/...` and creates the DB rows.
- Failed ingests are moved to `dropbox/failed/` with a `*.error.txt` sidecar.

Admin settings:

- Settings live under `Settings → Admin → Dropbox` and are stored in the global settings document.
- Defaults match the list above; if you don’t configure anything, it works out of the box.

## License

[Your License Here]
