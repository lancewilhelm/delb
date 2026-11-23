# Delb

![Go](https://img.shields.io/badge/Go-%2300ADD8?style=for-the-badge&logo=go&logoColor=white)
![Vue](https://img.shields.io/badge/Vue%203-%23191A22?style=for-the-badge&logo=vuedotjs)
![Vite](https://img.shields.io/badge/Vite-%23646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind%20v4-%231a202c?style=for-the-badge&logo=tailwind-css)
![SQLite](https://img.shields.io/badge/SQLite-%231a202c?style=for-the-badge&logo=sqlite)

A fast, self-hosted digital library manager shipped as a single portable Go static binary with an embedded Vue 3 SPA and zero runtime dependencies.

## Lightweight & Fast to Self-Host

Delb compiles to a single `CGO_ENABLED=0` static binary (with the frontend, fonts, icons, PDF.js assets, and SQLite migrations embedded) and publishes a minimal multi-arch `FROM scratch` Docker image (`linux/amd64` + `linux/arm64`) — no Node.js runtime, no separate database server, and no external CDN calls required.

Measured on a real library (76 books, 32 authors, 9 series, Apple Silicon):

| Deployment Metric | Delb (Go + Vite) | Why It Matters |
|---|---|---|
| **Docker image size** | **~38.4 MB** (`FROM scratch`) | Fast pulls, minimal attack surface, no OS/runtime packages |
| **Standalone binary** | **~25 MB** | Single executable — drop onto any Linux/macOS host and run |
| **Idle memory (RSS)** | **~22 MB** (~66 MB peak under 16-client load) | Runs effortlessly on a Raspberry Pi, NAS, or tiny VPS |
| **Cold startup time** | **~23 ms** (p50) | Instant container restarts with automatic SQLite migrations |
| **API latency (p50)** | **0.14–1.95 ms** across library, bookshelf, search, and covers | Snappy browsing even on modest hardware |
| **Throughput (16 clients)** | **1,260–31,000+ req/s** with zero errors | Handles concurrent readers, cover grids, and MCP clients smoothly |
| **Offline-first assets** | **100% self-hosted** | All 10 UI fonts, icons, and PDF.js assets ship inside the binary |

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

See `docs/developing/reference/library-layout.md` for the complete philosophy and UI implications.

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

- `docs/hosting/calibre-import.md` for the import process + caveats
- `docs/developing/reference/calibre-schema.md` for Calibre schema reference

## Features

- **Library Management** - Upload, organize, and browse your ebook collection
- **Multi-user Support** - User authentication with role-based permissions (owner, admin, user, guest)
- **Modern UI** - Clean, responsive interface with theme support
- **Book Details** - View metadata, descriptions, and cover images (admins can edit metadata, authors, and covers)
- **Direct Downloads** - Download books directly from the web interface
- **In-app Reading** - Read EPUBs and PDFs, with a saved position for each reader
- **Search & Filter** - Find books quickly with search and filtering
- **SQLite Database** - Lightweight, embedded pure-Go SQLite database with automatic startup migrations
- **MCP Integration** - Connect AI assistants to your library via Streamable HTTP MCP (`/api/mcp`)

## Cover Delivery

Delb serves covers through a membership-gated book endpoint:

- `GET /api/books/:id/cover?variant=thumb|source&v=<optional>`
- Requires an authenticated session and book visibility via collection membership
- Uses private cache revalidation (`ETag` + `Cache-Control: private, max-age=0, must-revalidate`)

`books.coverImagePath` is an internal storage pointer and is not intended to be used directly as a client-facing URL.

For external "fetch cover by URL" flows, Delb proxies through server-side guards (URL scheme validation, private-network blocking, redirect/timeout limits, payload cap, and decoded raster validation).

## Tech Stack

- **Backend**: Pure Go (`CGO_ENABLED=0`) static binary with `//go:embed` SPA & SQLite migrations
- **Frontend**: Vue 3 + Vite + Vue Router + Pinia
- **Styling**: Tailwind CSS v4 (with 180+ themes & 10 self-hosted fonts)
- **Database**: Embedded SQLite (`modernc.org/sqlite`)
- **File Storage**: Local filesystem (`library/` directory) with crash-recoverable journaled operations

## Getting Started

### Prerequisites

- Go 1.27+ (matching `go.mod`)
- Node.js 22.22.3+ and pnpm (for frontend build / dev HMR)

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd delb

# Install frontend dependencies
pnpm install --frozen-lockfile

# Start development server (Go API backend + Vite HMR frontend; runs migrations automatically)
pnpm run dev
```

Or build and run the standalone production binary:

```bash
pnpm run build
./bin/delb
```

The application will be available at `http://localhost:3000`.

### First-Time Setup

1. On first run, create the initial account through the registration page.
2. Delb promotes exactly one first user to system `owner` using a race-safe server-side claim.
3. After that, registration follows global `allowRegistration` settings and new self-registrations are normal `user` accounts.
4. Admins can create additional user accounts with appropriate roles.
5. Book creators and system admins/owners can edit a visible book at `/books/{id}/edit`, including:
   - Metadata fields (title, description, published, language, series/publisher IDs)
   - Authors (single field; can be comma-separated for multiple authors)
   - Cover image upload (stored as `cover.webp` alongside the book file)

## Project Structure

```
delb/
├── app/              # Vue 3 + Vite SPA frontend
│   ├── components/   # Vue components
│   ├── composables/  # Vue composables
│   ├── pages/        # Route pages (book detail at /books/[id])
│   ├── stores/       # Pinia stores
│   └── utils/        # Frontend utilities
├── cmd/delb/         # Standalone Go server entrypoint
├── internal/         # Pure-Go backend packages (auth, books, storage, epub, mcp, etc.)
├── shared/           # Shared domain logic and types
├── .drizzle/         # SQLite migrations embedded into the Go binary
├── library/          # Book storage directory (gitignored)
├── data/             # SQLite database location (gitignored)
└── docs/             # Project documentation
```

## Documentation

Start at the [documentation home](docs/README.md), then follow the path for your task:

- [Use Delb](docs/README.md#use-delb) for the core library guides.
- [Host Delb](docs/hosting/README.md) for deployment and operations.
- [Develop Delb](docs/developing/README.md) for architecture, contracts, and local setup.

## Development

```bash
# Run dev server (Go API backend + Vite HMR frontend)
pnpm run dev

# Build production SPA and standalone static Go binary (bin/delb)
pnpm run build

# Run frontend unit tests and Go tests
pnpm run test
pnpm run go:test

# Run full API integration test suite against bin/delb
pnpm run test:integration
```

## Storage

Books are stored in the `library/` directory at the project root. New Delb-created
entries use the canonical structure:

```
library/
└── {author}/
    └── {title} ({book-id-prefix})/
        ├── {book-file}.epub|pdf|mobi|azw3
        └── cover.webp
```

The database stores relative paths and metadata for each book. Delb manages the
on-disk library layout and will move/rename folders when author/title metadata
changes so the filesystem stays human-readable.

See [storage recovery](docs/hosting/storage-recovery.md) for interrupted operations, filesystem requirements, upload limits and upgrade backups.

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

[MIT License](LICENSE)
