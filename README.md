# Delb

![Nuxt](https://img.shields.io/badge/Nuxt%204-%23000000?style=for-the-badge&logo=nuxt)
![Vue](https://img.shields.io/badge/Vue%203-%23191A22?style=for-the-badge&logo=vuedotjs)
![Tailwind](https://img.shields.io/badge/Tailwind%20v4-%231a202c?style=for-the-badge&logo=tailwind-css)
![SQLite](https://img.shields.io/badge/SQLite-%231a202c?style=for-the-badge&logo=sqlite)
![Drizzle](https://img.shields.io/badge/Drizzle%20ORM-%231a202c?style=for-the-badge&logo=drizzle)

A modern, self-hosted digital library manager built with Nuxt. Manage your ebook collection with a clean web interface.

## Calibre import (import-in-place)

Delb can **import an existing Calibre library in place**.

- Calibre library root is mounted at: `library/`
- Calibre database is read from: `library/metadata.db`
- Delb writes its own database to: `data/delb.db`
- Delb **does not copy/move** book files during this import; it stores pointers to existing files under `library/...`.

### Caveats (important)

- **Filesystem ownership:** With import-in-place, treat `library/` as **Calibre-owned** storage.
  - If Delb moves/renames files under `library/`, Calibre may no longer be able to find formats and covers referenced by `metadata.db`.
- **Editing metadata in Delb:** Editing titles/authors/tags in Delb updates `data/delb.db` only. It does **not** update Calibre’s `metadata.db`.
  - That means Calibre will still show its original metadata unless you manually sync it in Calibre.
- **Recommendation:** If you plan to keep using Calibre alongside Delb, keep a backup of your Calibre library before running any tools that might reorganize files.

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
- [Calibre Import](docs/calibre-import.md) - Import-in-place process + caveats
- [Calibre Database Schema](docs/calibre-database-schema.md) - Reference schema

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

Books are stored in the `library/` directory at the project root with the structure:
```
library/
└── {author}/
    └── {title}/
        ├── {book-file}.epub|pdf|mobi|azw3
        └── cover.webp
```

The database stores relative paths and metadata for each book.

## License

[Your License Here]
