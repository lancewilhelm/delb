package db

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"strings"
	"time"
)

const (
	drizzleMigrationsTable = "__drizzle_migrations"
	statementBreakpoint    = "--> statement-breakpoint"
)

type drizzleJournal struct {
	Version string                `json:"version"`
	Dialect string                `json:"dialect"`
	Entries []drizzleJournalEntry `json:"entries"`
}

type drizzleJournalEntry struct {
	Idx         int    `json:"idx"`
	Version     string `json:"version"`
	When        int64  `json:"when"`
	Tag         string `json:"tag"`
	Breakpoints bool   `json:"breakpoints"`
}

type migrationFile struct {
	Tag        string
	When       int64
	Hash       string
	Statements []string
}

// ErrPredatesBaseline reports a database that started before the pre-1.0
// migration squash and never reached the schema that the baseline describes.
var ErrPredatesBaseline = errors.New("this database predates Delb's v1.0 migration baseline: upgrade it with the last release before v1.0 (which applies migration 0022_single_library), then start this version")

// MigrateResult describes what Migrate did.
type MigrateResult struct {
	Applied               int
	BackupPath            string
	SkippedExternalSchema bool
}

// Migrate applies pending Drizzle migrations from migrationsFS (rooted either
// at ".drizzle/migrations" or directly at the migrations folder) while staying
// 100% compatible with Drizzle's __drizzle_migrations table format.
//
// Whenever pending migrations are about to run against an existing file-backed
// database that already contains tables, an atomic SQLite VACUUM INTO backup is
// created first.
func Migrate(ctx context.Context, sqlDB *sql.DB, dbFilePath string, isMemory bool, migrationsFS fs.FS) (MigrateResult, error) {
	migrations, err := loadMigrations(migrationsFS)
	if err != nil {
		return MigrateResult{}, err
	}

	hasMigrationsTable, err := tableExists(ctx, sqlDB, drizzleMigrationsTable)
	if err != nil {
		return MigrateResult{}, err
	}
	hasUsersTable, err := tableExists(ctx, sqlDB, "users")
	if err != nil {
		return MigrateResult{}, err
	}

	var hasLast bool
	var lastCreatedAt int64
	if hasMigrationsTable {
		row := sqlDB.QueryRowContext(ctx, `SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1`)
		var raw sql.NullInt64
		if scanErr := row.Scan(&raw); scanErr != nil && scanErr != sql.ErrNoRows {
			return MigrateResult{}, fmt.Errorf("read last migration timestamp: %w", scanErr)
		} else if scanErr == nil && raw.Valid {
			hasLast = true
			lastCreatedAt = raw.Int64
		}
	}

	// Handle databases initialized externally by executing raw SQL without
	// creating __drizzle_migrations (e.g., review/setup-demo.mjs synthetic DBs).
	if !hasLast && hasUsersTable {
		return MigrateResult{SkippedExternalSchema: true}, nil
	}

	var pending []migrationFile
	for _, m := range migrations {
		if !hasLast || lastCreatedAt < m.When {
			pending = append(pending, m)
		}
	}
	if len(pending) == 0 {
		return MigrateResult{}, nil
	}

	// The pre-1.0 migrations were squashed into one baseline. A database with
	// migration history that still needs the baseline was created before the
	// squash and stopped short of its final schema, so applying the baseline's
	// CREATE statements would fail. Ask the operator to upgrade through the
	// last release that has the full migration chain first.
	if hasLast && len(migrations) > 0 && pending[0].Tag == migrations[0].Tag {
		return MigrateResult{}, ErrPredatesBaseline
	}

	var result MigrateResult
	// Take an automatic pre-migration backup whenever an existing database with
	// tables is about to be upgraded.
	if !isMemory && dbFilePath != "" && (hasLast || hasUsersTable) {
		backupPath, backupErr := createPreMigrationBackup(ctx, sqlDB, dbFilePath)
		if backupErr != nil {
			return MigrateResult{}, fmt.Errorf("create pre-migration backup: %w", backupErr)
		}
		result.BackupPath = backupPath
	}

	// Ensure Drizzle's exact tracking table exists.
	const createTableSQL = `
		CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`
	if _, err := sqlDB.ExecContext(ctx, createTableSQL); err != nil {
		return result, fmt.Errorf("create __drizzle_migrations table: %w", err)
	}

	tx, err := sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return result, fmt.Errorf("begin migration transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	for _, m := range pending {
		for idx, stmt := range m.Statements {
			trimmed := strings.TrimSpace(stmt)
			if trimmed == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, trimmed); err != nil {
				return result, fmt.Errorf("execute migration %s statement %d: %w", m.Tag, idx+1, err)
			}
		}
		if _, err := tx.ExecContext(
			ctx,
			`INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)`,
			m.Hash,
			m.When,
		); err != nil {
			return result, fmt.Errorf("record migration %s: %w", m.Tag, err)
		}
		result.Applied++
	}

	if err := tx.Commit(); err != nil {
		return MigrateResult{}, fmt.Errorf("commit migrations: %w", err)
	}

	return result, nil
}

func loadMigrations(migrationsFS fs.FS) ([]migrationFile, error) {
	baseDir := ""
	journalBytes, err := fs.ReadFile(migrationsFS, ".drizzle/migrations/meta/_journal.json")
	if err == nil {
		baseDir = ".drizzle/migrations"
	} else {
		journalBytes, err = fs.ReadFile(migrationsFS, "meta/_journal.json")
		if err != nil {
			return nil, fmt.Errorf("read drizzle _journal.json: %w", err)
		}
	}

	var journal drizzleJournal
	if err := json.Unmarshal(journalBytes, &journal); err != nil {
		return nil, fmt.Errorf("parse drizzle _journal.json: %w", err)
	}

	files := make([]migrationFile, 0, len(journal.Entries))
	for _, entry := range journal.Entries {
		sqlPath := entry.Tag + ".sql"
		if baseDir != "" {
			sqlPath = path.Join(baseDir, sqlPath)
		}
		rawBytes, err := fs.ReadFile(migrationsFS, sqlPath)
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", sqlPath, err)
		}
		rawSQL := string(rawBytes)
		sum := sha256.Sum256([]byte(rawSQL))
		files = append(files, migrationFile{
			Tag:        entry.Tag,
			When:       entry.When,
			Hash:       hex.EncodeToString(sum[:]),
			Statements: strings.Split(rawSQL, statementBreakpoint),
		})
	}
	return files, nil
}

func tableExists(ctx context.Context, sqlDB *sql.DB, name string) (bool, error) {
	var found string
	err := sqlDB.QueryRowContext(
		ctx,
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
		name,
	).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check table %q: %w", name, err)
	}
	return found == name, nil
}

func createPreMigrationBackup(ctx context.Context, sqlDB *sql.DB, dbFilePath string) (string, error) {
	ts := time.Now().UTC().Format("20060102T150405.000Z")
	backupPath := fmt.Sprintf("%s.pre-migration-%s.bak", dbFilePath, ts)
	// SQLite VACUUM INTO produces a clean, self-contained atomic snapshot even in WAL mode.
	escaped := strings.ReplaceAll(backupPath, "'", "''")
	if _, err := sqlDB.ExecContext(ctx, fmt.Sprintf("VACUUM INTO '%s'", escaped)); err != nil {
		return "", err
	}
	return backupPath, nil
}
