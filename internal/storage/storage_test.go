package storage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func memDecision(committed map[string]bool) OperationDecision {
	return OperationDecision{
		IsCommitted: func(_ context.Context, id string) (bool, error) {
			return committed[id], nil
		},
		Remove: func(_ context.Context, id string) error {
			delete(committed, id)
			return nil
		},
	}
}

func TestPathsAndDownloadDisposition(t *testing.T) {
	if got := ToSafePathSegment("  ..foo..  ", "fallback", 120); got != "foo" {
		t.Fatalf("trimmed dots = %q, want foo", got)
	}
	if got := ToSafePathSegment("A/B:C*D?E", "fallback", 120); got != "A B C D E" {
		t.Fatalf("unsafe chars = %q, want A B C D E", got)
	}
	if got := ToSafePathSegment("   ", "fallback", 120); got != "fallback" {
		t.Fatalf("empty fallback = %q", got)
	}
	if got := MakeBookFolderName("The Dune", "12345678-aaaa-bbbb-cccc-ddddeeeeffff"); got != "The Dune (12345678)" {
		t.Fatalf("MakeBookFolderName = %q", got)
	}
	rel := BuildBookStorageRelativePath([]string{"Frank Herbert"}, "Dune", "12345678-aaaa-bbbb-cccc-ddddeeeeffff", "Dune (12345678).epub")
	if rel != "library/Frank Herbert/Dune (12345678)/Dune (12345678).epub" {
		t.Fatalf("BuildBookStorageRelativePath = %q", rel)
	}

	disp := BookDownloadDisposition("Café 100% — \"Test\"\r\n", "epub")
	if !strings.HasPrefix(disp, `attachment; filename="`) || !strings.Contains(disp, `filename*=UTF-8''`) {
		t.Fatalf("unexpected disposition: %q", disp)
	}
	if strings.ContainsAny(disp, "\r\n") {
		t.Fatalf("disposition contains CR/LF: %q", disp)
	}
	if !strings.Contains(disp, "%25") {
		t.Fatalf("expected encoded percent in filename*: %q", disp)
	}
}

func TestBookStorageLockContention(t *testing.T) {
	ctx := context.Background()
	lib := t.TempDir()

	held := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)

	go func() {
		done <- WithBookStorageLock(ctx, lib, "book-lock-1", func() error {
			close(held)
			<-release
			return nil
		})
	}()

	<-held
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	err := WithBookStorageLock(cancelCtx, lib, "book-lock-1", func() error { return nil })
	if err == nil {
		t.Fatalf("expected error while lock is held")
	}

	close(release)
	if err := <-done; err != nil {
		t.Fatalf("holder failed: %v", err)
	}

	called := false
	if err := WithBookStorageLock(ctx, lib, "book-lock-1", func() error {
		called = true
		return nil
	}); err != nil || !called {
		t.Fatalf("re-acquire failed: err=%v called=%v", err, called)
	}
}

func TestJournaledCreateAndRecovery(t *testing.T) {
	ctx := context.Background()
	lib := t.TempDir()
	bookID := "book-create-1"
	dir := filepath.Join(lib, "Author", "Book (book-cre)")
	file := filepath.Join(dir, "Book (book-cre).epub")

	committed := map[string]bool{}
	dec := memDecision(committed)

	// 1. Uncommitted Finish quarantines created directory into .delb-failed-create-*.
	h, err := BeginStoredCreate(lib, bookID, dir, file, dec)
	if err != nil {
		t.Fatalf("BeginStoredCreate: %v", err)
	}
	if err := os.WriteFile(file, []byte("epub-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := h.Finish(ctx); err != nil {
		t.Fatalf("Finish uncommitted: %v", err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("expected file moved out of live path on rollback, stat err=%v", err)
	}

	// 2. Simulated crash leaves journal + file; recovery cleans journal when committed.
	dir2 := filepath.Join(lib, "Author", "Book2 (book-cr2)")
	file2 := filepath.Join(dir2, "Book2 (book-cr2).epub")
	h2, err := BeginStoredCreate(lib, bookID, dir2, file2, dec)
	if err != nil {
		t.Fatalf("BeginStoredCreate 2: %v", err)
	}
	if err := os.WriteFile(file2, []byte("committed-bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	committed[h2.ID] = true

	withLock := func(id string, work func() error) error {
		return WithBookStorageLock(ctx, lib, id, work)
	}
	if err := RecoverStoredCreates(ctx, lib, dec, withLock); err != nil {
		t.Fatalf("RecoverStoredCreates: %v", err)
	}
	if _, err := os.Stat(file2); err != nil {
		t.Fatalf("expected committed file to remain, stat err=%v", err)
	}
}

func TestJournaledMoveAndDelete(t *testing.T) {
	ctx := context.Background()
	lib := t.TempDir()
	bookID := "book-move-1"

	src := filepath.Join(lib, "Old Author", "Old (book-mov)", "Old (book-mov).epub")
	dst := filepath.Join(lib, "New Author", "New (book-mov)", "New (book-mov).epub")
	if err := os.MkdirAll(filepath.Dir(src), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(src, []byte("content-123"), 0o644); err != nil {
		t.Fatal(err)
	}

	committed := map[string]bool{}
	dec := memDecision(committed)

	// Failed commit leaves the move journal; RecoverStoredMoves rolls back destination cleanly.
	errBoom := errors.New("db commit failed")
	err := MoveStoredFiles(ctx, lib, bookID, []MoveEntry{{Source: src, Destination: dst}}, dec, func(opID string) error {
		return errBoom
	})
	if !errors.Is(err, errBoom) {
		t.Fatalf("expected errBoom, got %v", err)
	}
	if warnings, rerr := RecoverStoredMoves(ctx, lib, dec, func(id string, work func() error) error {
		return WithBookStorageLock(ctx, lib, id, work)
	}); rerr != nil || len(warnings) != 0 {
		t.Fatalf("RecoverStoredMoves: err=%v warnings=%v", rerr, warnings)
	}
	if _, err := os.Stat(src); err != nil {
		t.Fatalf("source should still exist after rolled-back move: %v", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("target should not exist after rolled-back move: %v", err)
	}

	// Successful commit completes move.
	if err := MoveStoredFiles(ctx, lib, bookID, []MoveEntry{{Source: src, Destination: dst}}, dec, func(opID string) error {
		committed[opID] = true
		return nil
	}); err != nil {
		t.Fatalf("MoveStoredFiles commit: %v", err)
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("target should exist after move: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Fatalf("source should be removed after move: %v", err)
	}

	// DeleteStoredFiles with rollback keeps file, then commit deletes it.
	if err := DeleteStoredFiles(ctx, lib, bookID, []string{dst}, dec, func(opID string) error {
		return errBoom
	}); !errors.Is(err, errBoom) {
		t.Fatalf("expected errBoom on delete rollback, got %v", err)
	}
	if _, err := os.Stat(dst); err != nil {
		t.Fatalf("file should still exist after failed delete: %v", err)
	}
	if err := DeleteStoredFiles(ctx, lib, bookID, []string{dst}, dec, func(opID string) error {
		committed[opID] = true
		return nil
	}); err != nil {
		t.Fatalf("DeleteStoredFiles commit: %v", err)
	}
	if _, err := os.Stat(dst); !os.IsNotExist(err) {
		t.Fatalf("file should be deleted: %v", err)
	}
}

func TestJournaledCoverCommitAndRecovery(t *testing.T) {
	ctx := context.Background()
	lib := t.TempDir()
	bookID := "book-cover-1"
	dir := filepath.Join(lib, "Author", "Book (book-cov)")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	coverWebp := filepath.Join(dir, "cover.webp")
	coverSrc := filepath.Join(dir, "cover.source.png")
	if err := os.WriteFile(coverWebp, []byte("old-webp"), 0o644); err != nil {
		t.Fatal(err)
	}

	committed := map[string]bool{}
	dec := memDecision(committed)
	prevPath := "Author/Book (book-cov)/cover.webp"

	// Rollback restores original cover.
	errFail := errors.New("commit failed")
	_, err := CommitCoverUpdate(ctx, CommitCoverUpdateOptions{
		OperationParent:        dir,
		AllowedRoot:            lib,
		PreviousCoverImagePath: &prevPath,
		ExpectedCoverImagePath: prevPath,
		BookID:                 bookID,
		Files: []CoverUpdateFile{
			{TargetPath: coverWebp, Data: []byte("new-webp")},
			{TargetPath: coverSrc, Data: []byte("new-src")},
		},
		Decision: &dec,
		CommitDatabase: func(opID string) error {
			return errFail
		},
	})
	if !errors.Is(err, errFail) {
		t.Fatalf("expected errFail, got %v", err)
	}
	b, _ := os.ReadFile(coverWebp)
	if string(b) != "old-webp" {
		t.Fatalf("expected old-webp restored, got %q", string(b))
	}
	if _, err := os.Stat(coverSrc); !os.IsNotExist(err) {
		t.Fatalf("expected new coverSrc rolled back")
	}

	// Commit applies new files.
	if _, err := CommitCoverUpdate(ctx, CommitCoverUpdateOptions{
		OperationParent:        dir,
		AllowedRoot:            lib,
		PreviousCoverImagePath: &prevPath,
		ExpectedCoverImagePath: prevPath,
		BookID:                 bookID,
		Files: []CoverUpdateFile{
			{TargetPath: coverWebp, Data: []byte("new-webp")},
			{TargetPath: coverSrc, Data: []byte("new-src")},
		},
		Decision: &dec,
		CommitDatabase: func(opID string) error {
			committed[opID] = true
			return nil
		},
	}); err != nil {
		t.Fatalf("CommitCoverUpdate: %v", err)
	}
	b, _ = os.ReadFile(coverWebp)
	if string(b) != "new-webp" {
		t.Fatalf("expected new-webp, got %q", string(b))
	}

	// Pending cover recovery with no journals is a no-op.
	if _, err := RecoverPendingCoverUpdates(ctx, dir, lib, &prevPath, bookID, &dec); err != nil {
		t.Fatalf("RecoverPendingCoverUpdates: %v", err)
	}
}

func TestRecoveryGateMiddleware(t *testing.T) {
	gate := StartRecovery(context.Background(), nil, "", slog.New(slog.NewTextHandler(io.Discard, nil)))
	h := gate.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	}))
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/api/books", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
}
