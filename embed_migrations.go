package delb

import "embed"

// MigrationsFS embeds Drizzle's canonical SQL migrations and journal directly
// from .drizzle/migrations so the Go server and Drizzle stay strictly in sync.
//
//go:embed .drizzle/migrations/*.sql .drizzle/migrations/meta/_journal.json
var MigrationsFS embed.FS
