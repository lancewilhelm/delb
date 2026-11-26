package db_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/db"
)

func TestParseDatabaseURL(t *testing.T) {
	cases := []struct {
		raw      string
		wantPath string
		wantMem  bool
		wantErr  bool
	}{
		{"", "data/delb.db", false, false},
		{"file:./data/delb.db", "data/delb.db", false, false},
		{"file:/tmp/delb.db", "/tmp/delb.db", false, false},
		{"file:///tmp/delb.db", "/tmp/delb.db", false, false},
		{"file:./data/delb.db?mode=rwc", "data/delb.db", false, false},
		{":memory:", ":memory:", true, false},
		{"file::memory:", ":memory:", true, false},
		{"./local.db", "local.db", false, false},
		{"libsql://remote.turso.io", "", false, true},
	}
	for _, tc := range cases {
		gotPath, gotMem, err := db.ParseDatabaseURL(tc.raw)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseDatabaseURL(%q): expected error, got nil", tc.raw)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseDatabaseURL(%q): unexpected error: %v", tc.raw, err)
			continue
		}
		if gotMem != tc.wantMem || gotPath != tc.wantPath {
			t.Errorf("ParseDatabaseURL(%q) = (%q, %v), want (%q, %v)", tc.raw, gotPath, gotMem, tc.wantPath, tc.wantMem)
		}
	}
}

func TestMigrateFreshAndIdempotent(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "delb.db")

	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer opened.DB.Close()

	// Verify WAL mode and foreign_keys pragma.
	var journalMode string
	if err := opened.DB.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if journalMode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", journalMode)
	}
	var fk int
	if err := opened.DB.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if fk != 1 {
		t.Fatalf("foreign_keys = %d, want 1", fk)
	}

	res, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS)
	if err != nil {
		t.Fatalf("Migrate fresh: %v", err)
	}
	if res.Applied != 21 {
		t.Fatalf("Applied = %d, want 21", res.Applied)
	}
	if res.BackupPath != "" {
		t.Fatalf("expected no backup on fresh DB, got %q", res.BackupPath)
	}

	// Verify __drizzle_migrations has 21 rows with Drizzle-compatible hash and timestamp.
	var count int
	if err := opened.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM "__drizzle_migrations"`).Scan(&count); err != nil {
		t.Fatalf("count __drizzle_migrations: %v", err)
	}
	if count != 21 {
		t.Fatalf("__drizzle_migrations count = %d, want 21", count)
	}

	// Verify hash of first migration matches sha256(0000_medical_naoko.sql).
	raw0, err := delb.MigrationsFS.ReadFile(".drizzle/migrations/0000_medical_naoko.sql")
	if err != nil {
		t.Fatalf("read 0000 sql: %v", err)
	}
	sum0 := sha256.Sum256(raw0)
	wantHash0 := hex.EncodeToString(sum0[:])
	var gotHash0 string
	var gotWhen0 int64
	if err := opened.DB.QueryRowContext(ctx, `SELECT hash, created_at FROM "__drizzle_migrations" ORDER BY created_at ASC LIMIT 1`).Scan(&gotHash0, &gotWhen0); err != nil {
		t.Fatalf("select first migration row: %v", err)
	}
	if gotHash0 != wantHash0 || gotWhen0 != 1769400740951 {
		t.Fatalf("first migration = (%q, %d), want (%q, 1769400740951)", gotHash0, gotWhen0, wantHash0)
	}

	// Verify collections-model was initialized to exclusive by 0007.
	var modelState string
	if err := opened.DB.QueryRowContext(ctx, `SELECT value FROM system_state WHERE key = 'collections-model'`).Scan(&modelState); err != nil {
		t.Fatalf("read collections-model: %v", err)
	}
	if modelState != "exclusive" {
		t.Fatalf("collections-model = %q, want exclusive", modelState)
	}

	// Second run must be a complete no-op with no backup created.
	res2, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS)
	if err != nil {
		t.Fatalf("Migrate idempotent: %v", err)
	}
	if res2.Applied != 0 || res2.BackupPath != "" {
		t.Fatalf("second Migrate = %+v, want zero applied and no backup", res2)
	}
}

func TestMigrateExistingDrizzleDBCreatesPreMigrationBackup(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "existing.db")

	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer opened.DB.Close()

	// Step 1: Apply initial migration.
	fs1 := fstest.MapFS{
		"meta/_journal.json": &fstest.MapFile{Data: []byte(`{
			"version": "7",
			"dialect": "sqlite",
			"entries": [
				{"idx": 0, "version": "6", "when": 1000, "tag": "0000_init", "breakpoints": true}
			]
		}`)},
		"0000_init.sql": &fstest.MapFile{Data: []byte(`CREATE TABLE items (id text PRIMARY KEY, name text NOT NULL);`)},
	}
	res1, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, fs1)
	if err != nil {
		t.Fatalf("Migrate v1: %v", err)
	}
	if res1.Applied != 1 {
		t.Fatalf("v1 applied = %d, want 1", res1.Applied)
	}
	if _, err := opened.DB.ExecContext(ctx, `INSERT INTO items (id, name) VALUES ('1', 'before')`); err != nil {
		t.Fatalf("seed row: %v", err)
	}

	// Step 2: Add a second pending migration and re-run.
	fs2 := fstest.MapFS{
		"meta/_journal.json": &fstest.MapFile{Data: []byte(`{
			"version": "7",
			"dialect": "sqlite",
			"entries": [
				{"idx": 0, "version": "6", "when": 1000, "tag": "0000_init", "breakpoints": true},
				{"idx": 1, "version": "6", "when": 2000, "tag": "0001_add_col", "breakpoints": true}
			]
		}`)},
		"0000_init.sql":    fs1["0000_init.sql"],
		"0001_add_col.sql": &fstest.MapFile{Data: []byte(`ALTER TABLE items ADD COLUMN note text DEFAULT '';`)},
	}
	res2, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, fs2)
	if err != nil {
		t.Fatalf("Migrate v2: %v", err)
	}
	if res2.Applied != 1 {
		t.Fatalf("v2 applied = %d, want 1", res2.Applied)
	}
	if res2.BackupPath == "" {
		t.Fatalf("expected pre-migration backup path, got empty")
	}
	info, err := os.Stat(res2.BackupPath)
	if err != nil || info.Size() == 0 {
		t.Fatalf("backup file missing or empty: err=%v", err)
	}

	// Verify backup database contains the pre-migration row and does NOT have the new column.
	bakOpened, err := db.Open(ctx, "file:"+res2.BackupPath)
	if err != nil {
		t.Fatalf("open backup: %v", err)
	}
	defer bakOpened.DB.Close()
	var name string
	if err := bakOpened.DB.QueryRowContext(ctx, `SELECT name FROM items WHERE id = '1'`).Scan(&name); err != nil || name != "before" {
		t.Fatalf("backup row = (%q, %v), want ('before', nil)", name, err)
	}
	var migCount int
	if err := bakOpened.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM "__drizzle_migrations"`).Scan(&migCount); err != nil || migCount != 1 {
		t.Fatalf("backup migration count = (%d, %v), want 1", migCount, err)
	}
}

func TestMigrateSkipsExternalSchemaWithoutDrizzleTable(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "synthetic.db")

	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer opened.DB.Close()

	// Simulate review/setup-demo.mjs creating tables directly without __drizzle_migrations.
	if _, err := opened.DB.ExecContext(ctx, `CREATE TABLE users (id text PRIMARY KEY)`); err != nil {
		t.Fatalf("create users: %v", err)
	}

	res, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS)
	if err != nil {
		t.Fatalf("Migrate external schema: %v", err)
	}
	if !res.SkippedExternalSchema || res.Applied != 0 {
		t.Fatalf("got %+v, want SkippedExternalSchema=true, Applied=0", res)
	}
}
