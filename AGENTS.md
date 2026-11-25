# Agent guide

This file is for coding agents that work on the Delb repository. Agents that connect to a running Delb library through MCP should read [Connect an agent](docs/using/connect-an-agent.md) instead.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow that every change follows. The [contributor guide](docs/developing/README.md), [architecture](docs/developing/architecture.md), and [data model](docs/developing/data-model.md) describe the system in depth. This file lists the commands and the rules that are easy to miss.

## Project layout

- `cmd/delb/`: the server entry point. It applies pending migrations at startup and serves the API and the embedded web app.
- `internal/`: Go packages by area. `httpapi/` holds the router and middleware. `books/`, `collections/`, `users/`, and `settings/` hold the main APIs. `storage/` owns managed files, operation journals, and recovery. `mcp/` is the MCP server for connected agents.
- `app/`: the Vue 3 single-page app. Vite builds it into `dist/`, and `embed_web.go` embeds it in the binary.
- `shared/`: TypeScript modules that the app and its tests share.
- `.drizzle/migrations/`: SQL migrations. `embed_migrations.go` embeds them in the binary.
- `review/`: integration suites, browser checks, and the synthetic demo.
- `docs/`: user, hosting, and developer documentation. `GLOSSARY.md` defines product terms.

## Commands

| Task                                    | Command                                                   |
| --------------------------------------- | --------------------------------------------------------- |
| Install dependencies                    | `pnpm install --frozen-lockfile`                          |
| Run the Go API and Vite with hot reload | `pnpm dev` (open `http://localhost:3000`)                 |
| Frontend unit tests                     | `pnpm test`                                               |
| Go tests                                | `go test -count=1 ./...` and `go vet ./...`               |
| Types, lint, and formatting             | `pnpm typecheck`, `pnpm lint`, `pnpm format`              |
| Build the web app and `bin/delb`        | `pnpm build`                                              |
| API integration suite                   | `pnpm test:integration` (needs `bin/delb` from the build) |
| Documentation links and anchors         | `pnpm docs:check`                                         |

CI runs all of these on every pull request. See [the test workflow](.github/workflows/test.yml) for the exact order. Run `pnpm format:fix` and `gofmt` before committing.

## Working rules

- Branch from `main` with a prefix such as `feat/`, `fix/`, `docs/`, or `ci/`. Open a pull request; do not push to `main`.
- Write commit subjects in Conventional Commits form (`feat:`, `fix:`, `docs:`, `chore:`). `standard-version` builds the changelog from `feat` and `fix` commits.
- Fill in every section of the [pull request template](.github/pull_request_template.md). The manual verification section must describe what you actually did. If you could not run something, say so and say why.
- Keep changes focused. Report unrelated problems that you find instead of fixing them in the same change.

## Data safety

- Never read, copy, or modify a real library. That includes `.env` files and the contents of `data/`, `library/`, `dropbox/`, and `calibre/` in a working checkout.
- For manual checks, use the [synthetic demo](docs/developing/README.md#run-the-synthetic-demo) in a separate worktree. Use invented names and `example.invalid` email addresses.
- Tests must not make outbound network requests. Mock metadata providers instead of calling Google Books or Hardcover.
- Screenshots, fixtures, logs, and pull request text must not contain real book collections, account names, email addresses, or API keys.

## Authorization and storage

- Every API handler checks its own session and permissions. Hiding a control in the UI does not authorize or forbid anything.
- Keep the three ownership questions separate. Collection membership decides which books a reader can see. Collection roles decide who can change book metadata and files. Reading data (status, dates, ratings, progress, reviews, and notes) belongs only to the reader. Read the [collections reference](docs/developing/reference/collections.md) before changing any of these rules.
- Write book files and covers only through `internal/storage`, which journals each operation, takes per-book locks, and recovers interrupted work at startup. Do not write into `library/` directly.

## Schema changes

Migrations are SQL files that are written by hand and follow Drizzle's format. A new migration needs all of these:

1. A new `.drizzle/migrations/NNNN_name.sql` file. Separate statements with `--> statement-breakpoint`.
2. A matching `meta/NNNN_snapshot.json` and a new entry in `meta/_journal.json`.
3. Updated migration counts in `internal/db/migrate_test.go`.
4. For a new table, an entry in the table lists in `internal/collections/migration.go`.

Never edit a migration that has already been merged. Add a new one instead. The server applies pending migrations at startup, and `bin/delb --migrate-only` applies them and exits.

## Documentation

- When user-visible behavior changes, update the user guide in `docs/using/` and the matching reference page in `docs/developing/reference/` in the same change.
- Use the product terms from `GLOSSARY.md`. Add a term there when you introduce one.
- Files in `docs/archive/`, `review/*.md`, and the evidence tables in `docs/developing/documentation-status.md` are dated records. Do not rewrite them to describe current behavior.
- Run `pnpm docs:check` after any Markdown change.
