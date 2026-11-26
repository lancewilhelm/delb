package dropbox_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/dropbox"
	"github.com/lancewilhelm/delb/internal/storage"
)

func setupDropboxDB(t *testing.T) (*sql.DB, string, string, string) {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	if err := os.MkdirAll(libDir, 0o755); err != nil {
		t.Fatal(err)
	}
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	now := time.Now().UTC().Unix()
	ownerID := uuid.NewString()
	outsiderID := uuid.NewString()

	for _, stmt := range []struct {
		q    string
		args []any
	}{
		{
			`INSERT INTO users (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Owner', 'owner@example.invalid', 1, ?, ?, 'owner')`,
			[]any{ownerID, now, now},
		},
		{
			`INSERT INTO users (id, name, email, email_verified, created_at, updated_at, role) VALUES (?, 'Outsider', 'outsider@example.invalid', 1, ?, ?, 'reader')`,
			[]any{outsiderID, now, now},
		},
	} {
		if _, err := opened.DB.Exec(stmt.q, stmt.args...); err != nil {
			t.Fatalf("seed failed: %v", err)
		}
	}

	return opened.DB, tmp, libDir, ownerID
}

func TestDropboxFreshIngestAndClaimRecovery(t *testing.T) {
	sqlDB, baseDir, libDir, ownerID := setupDropboxDB(t)
	ctx := context.Background()
	now := time.Now().UTC().Unix()

	var outsiderID string
	_ = sqlDB.QueryRow(`SELECT id FROM users WHERE email = 'outsider@example.invalid'`).Scan(&outsiderID)

	// Configure global settings with stablePassesRequired=2
	cfgJSON, _ := json.Marshal(map[string]any{
		"dropbox": map[string]any{
			"enabled":              true,
			"pollIntervalMs":       50,
			"stablePassesRequired": 2,
			"targetUserId":         ownerID,
		},
	})
	if _, err := sqlDB.Exec(`
		INSERT INTO global_settings (user_id, settings, updated_at) VALUES (?, ?, ?)
	`, dropbox.GlobalSettingsID, string(cfgJSON), now); err != nil {
		t.Fatal(err)
	}

	dropboxDir := filepath.Join(baseDir, "dropbox")
	if err := os.MkdirAll(dropboxDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// 1. Retained claims keep their importing user. A legacy claim that still
	// carries collectionIds is accepted; a reader cannot import books.
	claimID := uuid.NewString()
	deniedID := uuid.NewString()
	unknownID := uuid.NewString()
	claimTargetJSON, _ := json.Marshal(map[string]any{"ownerUserId": ownerID, "collectionIds": []string{"legacy-collection"}})
	deniedTargetJSON, _ := json.Marshal(map[string]any{"ownerUserId": outsiderID})
	if _, err := sqlDB.Exec(`
		INSERT INTO system_state (key, value) VALUES (?, ?), (?, ?)
	`, "dropbox-claim:"+claimID, string(claimTargetJSON), "dropbox-claim:"+deniedID, string(deniedTargetJSON)); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(filepath.Join(dropboxDir, "Retained.pdf.delb-processing-"+claimID), []byte("retained bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dropboxDir, "Denied.pdf.delb-processing-"+deniedID), []byte("denied bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dropboxDir, "Unknown.pdf.delb-processing-"+unknownID), []byte("unknown bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Fresh file requiring 2 stable passes
	if err := os.WriteFile(filepath.Join(dropboxDir, "Fresh.pdf"), []byte("fresh pdf bytes"), 0o644); err != nil {
		t.Fatal(err)
	}

	watcher := dropbox.NewWatcher(dropbox.WatcherOptions{
		DB:         sqlDB,
		LibraryDir: libDir,
		BaseDir:    baseDir,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	// Pass 1: claims process immediately; Fresh.pdf is seen pass 1/2
	if err := watcher.ScanOnce(ctx); err != nil {
		t.Fatalf("ScanOnce pass 1: %v", err)
	}
	var freshCount int
	_ = sqlDB.QueryRow(`SELECT COUNT(*) FROM books WHERE title = 'Fresh'`).Scan(&freshCount)
	if freshCount != 0 {
		t.Fatalf("Fresh.pdf should wait for 2 stable passes, got %d", freshCount)
	}

	// Verify the retained claim landed in the library with verified bytes
	var retainedBookID, addedBy string
	if err := sqlDB.QueryRow(`SELECT id, added_by_user_id FROM books WHERE title = 'Retained'`).Scan(&retainedBookID, &addedBy); err != nil {
		t.Fatalf("retained book missing: %v", err)
	}
	if addedBy != ownerID {
		t.Fatalf("retained claim added by %s, want %s", addedBy, ownerID)
	}
	var relPath string
	_ = sqlDB.QueryRow(`SELECT relative_path FROM book_files WHERE book_id = ?`, retainedBookID).Scan(&relPath)
	destAbs, _ := storage.ResolveUnderLibrary(libDir, relPath)
	gotBytes, err := os.ReadFile(destAbs)
	if err != nil || string(gotBytes) != "retained bytes" {
		t.Fatalf("retained file bytes mismatch: err=%v content=%q", err, string(gotBytes))
	}

	// Verify denied and unknown claims moved to dropbox/failed with error reasons
	failedEntries, err := os.ReadDir(filepath.Join(dropboxDir, "failed"))
	if err != nil {
		t.Fatal(err)
	}
	var reasons []string
	for _, e := range failedEntries {
		if strings.HasSuffix(e.Name(), ".error.txt") {
			b, _ := os.ReadFile(filepath.Join(dropboxDir, "failed", e.Name()))
			reasons = append(reasons, string(b))
		}
	}
	if len(reasons) != 2 {
		t.Fatalf("expected 2 failed error logs, got %d: %v", len(reasons), reasons)
	}
	joined := strings.Join(reasons, "\n")
	if !strings.Contains(joined, "retained importing user") || !strings.Contains(joined, "Editor or administrator access") {
		t.Fatalf("unexpected failed reasons: %s", joined)
	}

	// Pass 2: Fresh.pdf now reaches 2 stable passes and is ingested for the target user
	if err := watcher.ScanOnce(ctx); err != nil {
		t.Fatalf("ScanOnce pass 2: %v", err)
	}
	var freshAddedBy string
	if err := sqlDB.QueryRow(`SELECT added_by_user_id FROM books WHERE title = 'Fresh'`).Scan(&freshAddedBy); err != nil {
		t.Fatalf("fresh book missing after pass 2: %v", err)
	}
	if freshAddedBy != ownerID {
		t.Fatalf("fresh book added by %s, want %s", freshAddedBy, ownerID)
	}
}

func TestDropboxWatcherCleanShutdown(t *testing.T) {
	sqlDB, baseDir, libDir, _ := setupDropboxDB(t)
	ctx, cancel := context.WithCancel(context.Background())

	gate := storage.StartRecovery(ctx, sqlDB, libDir, slog.New(slog.NewTextHandler(io.Discard, nil)))
	watcher := dropbox.NewWatcher(dropbox.WatcherOptions{
		DB:         sqlDB,
		LibraryDir: libDir,
		BaseDir:    baseDir,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	watcher.Start(ctx, gate)

	time.Sleep(50 * time.Millisecond)
	cancel()

	done := make(chan struct{})
	go func() {
		watcher.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("dropbox watcher did not stop cleanly on context cancellation")
	}
}
