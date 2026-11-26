package collections_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type colTestEnv struct {
	t          *testing.T
	opened     *db.OpenResult
	libraryDir string
	server     *httptest.Server
}

func newColTestEnv(t *testing.T) *colTestEnv {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libraryDir := filepath.Join(tmp, "library")
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "collections.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:        opened.DB,
		Secret:    "collections-test-secret-0123456789abcdef0123456789",
		Logger:    discard,
		RateLimit: auth.RateLimitConfig{Disabled: true},
	})
	colSvc := collections.NewService(collections.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libraryDir,
		Logger:      discard,
	})
	srv := httptest.NewServer(httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{colSvc},
	}))
	t.Cleanup(srv.Close)

	return &colTestEnv{t: t, opened: opened, libraryDir: libraryDir, server: srv}
}

type testUser struct {
	ID     string
	Email  string
	Cookie string
}

func (e *colTestEnv) signup(name, email string) testUser {
	e.t.Helper()
	b, _ := json.Marshal(map[string]any{
		"name":     name,
		"email":    email,
		"password": "super-secret-password",
	})
	req, _ := http.NewRequest(http.MethodPost, e.server.URL+"/api/auth/sign-up/email", bytes.NewReader(b))
	req.Header.Set("Origin", e.server.URL)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("signup %s: %v", email, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		e.t.Fatalf("signup %s = %d: %s", email, resp.StatusCode, string(raw))
	}
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	var pairs []string
	for _, c := range resp.Cookies() {
		pairs = append(pairs, c.Name+"="+c.Value)
	}
	return testUser{
		ID:     body["user"].(map[string]any)["id"].(string),
		Email:  email,
		Cookie: strings.Join(pairs, "; "),
	}
}

func (e *colTestEnv) do(method, path string, u *testUser, body any) (int, map[string]any) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.server.URL+path, r)
	if err != nil {
		e.t.Fatalf("new req: %v", err)
	}
	req.Header.Set("Origin", e.server.URL)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if u != nil {
		req.Header.Set("Cookie", u.Cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out
}

func TestCollectionsCRUDMembersTransferDefaultAndBulkMove(t *testing.T) {
	env := newColTestEnv(t)
	ctx := context.Background()

	owner := env.signup("Owner", "owner@example.invalid")
	editor := env.signup("Editor", "editor@example.invalid")
	viewer := env.signup("Viewer", "viewer@example.invalid")

	// Initial default collection visible to all new users.
	code, listBody := env.do(http.MethodGet, "/api/collections", &owner, nil)
	if code != http.StatusOK {
		t.Fatalf("GET /api/collections = %d %v", code, listBody)
	}
	cols := listBody["data"].(map[string]any)["collections"].([]any)
	if len(cols) != 1 || cols[0].(map[string]any)["isDefault"] != true {
		t.Fatalf("unexpected initial collections: %v", cols)
	}
	defaultID := cols[0].(map[string]any)["id"].(string)

	// Create collection (and idempotent duplicate returns created=false)
	code, createBody := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Sci-Fi"})
	if code != http.StatusOK || createBody["data"].(map[string]any)["created"] != true {
		t.Fatalf("POST /api/collections = (%d, %v)", code, createBody)
	}
	sciFiID := createBody["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	code, dupBody := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Sci-Fi"})
	if code != http.StatusOK || dupBody["data"].(map[string]any)["created"] != false {
		t.Fatalf("duplicate POST /api/collections = (%d, %v)", code, dupBody)
	}

	// Rename collection (owner ok, non-member 403)
	code, _ = env.do(http.MethodPut, "/api/collections/"+sciFiID, &viewer, map[string]any{"name": "Nope"})
	if code != http.StatusForbidden {
		t.Fatalf("outsider rename = %d, want 403", code)
	}
	code, _ = env.do(http.MethodPut, "/api/collections/"+sciFiID, &owner, map[string]any{"name": "Space Opera"})
	if code != http.StatusOK {
		t.Fatalf("owner rename = %d, want 200", code)
	}

	// Members upsert / list / guards / remove / leave
	code, _ = env.do(http.MethodPut, "/api/collections/"+sciFiID+"/members", &owner, map[string]any{
		"email": editor.Email,
		"role":  "editor",
	})
	if code != http.StatusOK {
		t.Fatalf("add editor = %d", code)
	}
	code, _ = env.do(http.MethodPut, "/api/collections/"+sciFiID+"/members", &editor, map[string]any{
		"email": owner.Email,
		"role":  "viewer",
	})
	if code != http.StatusBadRequest {
		t.Fatalf("demote owner via members = %d, want 400", code)
	}
	code, _ = env.do(http.MethodPut, "/api/collections/"+sciFiID+"/members", &editor, map[string]any{
		"email": editor.Email,
		"role":  "viewer",
	})
	if code != http.StatusBadRequest {
		t.Fatalf("change own role = %d, want 400", code)
	}
	code, membersBody := env.do(http.MethodGet, "/api/collections/"+sciFiID+"/members", &editor, nil)
	if code != http.StatusOK || len(membersBody["data"].(map[string]any)["members"].([]any)) != 2 {
		t.Fatalf("list members = (%d, %v)", code, membersBody)
	}

	// Viewer leaves default collection (empty body), cannot leave if owner
	code, _ = env.do(http.MethodPost, "/api/collections/"+defaultID+"/leave", &viewer, nil)
	if code != http.StatusOK {
		t.Fatalf("viewer leave default = %d, want 200", code)
	}
	code, _ = env.do(http.MethodPost, "/api/collections/"+defaultID+"/leave", &owner, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("owner leave default = %d, want 400", code)
	}

	// Transfer ownership -> previous owner becomes editor, target becomes owner
	code, trBody := env.do(http.MethodPost, "/api/collections/"+sciFiID+"/transfer-ownership", &owner, map[string]any{
		"email": editor.Email,
	})
	if code != http.StatusOK || trBody["data"].(map[string]any)["ownerUserId"] != editor.ID {
		t.Fatalf("transfer ownership = (%d, %v)", code, trBody)
	}

	// Remove member guard (cannot remove self or owner)
	code, _ = env.do(http.MethodDelete, "/api/collections/"+sciFiID+"/members/"+editor.ID, &editor, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("remove owner member = %d, want 400", code)
	}
	code, _ = env.do(http.MethodDelete, "/api/collections/"+sciFiID+"/members/"+owner.ID, &owner, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("remove self member = %d, want 400", code)
	}

	// Admin collections listing & default switching
	code, adminCols := env.do(http.MethodGet, "/api/settings/admin/collections", &owner, nil)
	if code != http.StatusOK || len(adminCols["data"].(map[string]any)["collections"].([]any)) != 2 {
		t.Fatalf("admin list collections = (%d, %v)", code, adminCols)
	}
	code, _ = env.do(http.MethodPut, "/api/settings/admin/collections/default", &editor, map[string]any{"collectionId": sciFiID})
	if code != http.StatusForbidden {
		t.Fatalf("non-admin set default = %d, want 403", code)
	}
	code, _ = env.do(http.MethodPut, "/api/settings/admin/collections/default", &owner, map[string]any{"collectionId": sciFiID})
	if code != http.StatusOK {
		t.Fatalf("admin set default = %d, want 200", code)
	}
	// Switch default back so we can delete sciFiID later if desired.
	code, _ = env.do(http.MethodPut, "/api/settings/admin/collections/default", &owner, map[string]any{"collectionId": defaultID})
	if code != http.StatusOK {
		t.Fatalf("restore default = %d, want 200", code)
	}

	// Bulk move books & verify collection_bookshelves revision updates and TBR trigger compatibility.
	if _, err := env.opened.DB.ExecContext(ctx, `
		INSERT INTO books (id, title, sort_title, collection_id, created_at, updated_at)
		VALUES ('b1', 'Dune', 'Dune', ?, 0, 0), ('b2', 'Foundation', 'Foundation', ?, 0, 0)
	`, defaultID, defaultID); err != nil {
		t.Fatalf("insert books: %v", err)
	}
	if _, err := env.opened.DB.ExecContext(ctx, `
		INSERT INTO user_book_status (user_id, book_id, status, tbr_rank, updated_at)
		VALUES (?, 'b1', 'to_be_read', 1, 0), (?, 'b2', 'to_be_read', 2, 0)
	`, editor.ID, editor.ID); err != nil {
		t.Fatalf("insert tbr: %v", err)
	}

	// Unconfirmed -> 400
	code, _ = env.do(http.MethodPost, "/api/collections/"+defaultID+"/books/bulk", &owner, map[string]any{
		"bookIds":            []string{"b1"},
		"targetCollectionId": sciFiID,
		"confirmed":          false,
	})
	if code != http.StatusBadRequest {
		t.Fatalf("unconfirmed bulk move = %d, want 400", code)
	}

	// Confirmed allInCollection minus excludedBookIds moves only b1
	code, moveBody := env.do(http.MethodPost, "/api/collections/"+defaultID+"/books/bulk", &owner, map[string]any{
		"allInCollection":    true,
		"excludedBookIds":    []string{"b2"},
		"targetCollectionId": sciFiID,
		"confirmed":          true,
	})
	if code != http.StatusOK || int(moveBody["data"].(map[string]any)["moved"].(float64)) != 1 {
		t.Fatalf("bulk move = (%d, %v)", code, moveBody)
	}

	var b1Col string
	_ = env.opened.DB.QueryRowContext(ctx, `SELECT collection_id FROM books WHERE id = 'b1'`).Scan(&b1Col)
	if b1Col != sciFiID {
		t.Fatalf("b1 collection = %q, want %q", b1Col, sciFiID)
	}

	// Both source and destination should have recorded bookshelf revision = 1.
	for _, cid := range []string{defaultID, sciFiID} {
		var rev int
		if err := env.opened.DB.QueryRowContext(ctx, `SELECT revision FROM bookshelf_layouts WHERE scope_kind = 'collection' AND scope_id = ?`, cid).Scan(&rev); err != nil {
			t.Fatalf("read bookshelf revision for %s: %v", cid, err)
		}
		if rev != 1 {
			t.Fatalf("bookshelf revision for %s = %d, want 1", cid, rev)
		}
	}
}

func TestPopulatedCollectionDeletionAndSafety(t *testing.T) {
	env := newColTestEnv(t)
	ctx := context.Background()

	owner := env.signup("Owner", "owner@example.invalid")
	member := env.signup("Member", "member@example.invalid")

	code, c1 := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Delete Me"})
	if code != http.StatusOK {
		t.Fatalf("create Delete Me: %d", code)
	}
	delID := c1["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	code, c2 := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Keep Me"})
	if code != http.StatusOK {
		t.Fatalf("create Keep Me: %d", code)
	}
	keepID := c2["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	// Add member as editor (should still get 403 on delete)
	_, _ = env.do(http.MethodPut, "/api/collections/"+delID+"/members", &owner, map[string]any{
		"email": member.Email,
		"role":  "editor",
	})

	// Create books, files, cover thumbnail, and a shared file referenced by Keep Me.
	if err := os.MkdirAll(filepath.Join(env.libraryDir, "deleted"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for _, rel := range []string{"deleted/book.epub", "deleted/cover.webp", "deleted/cover.thumb.webp", "shared.pdf"} {
		if err := os.WriteFile(filepath.Join(env.libraryDir, rel), []byte(rel), 0o644); err != nil {
			t.Fatalf("write %s: %v", rel, err)
		}
	}
	if _, err := env.opened.DB.ExecContext(ctx, `
		INSERT INTO books (id, title, collection_id, cover_image_path, created_at, updated_at) VALUES
			('a', 'First', ?, 'library/deleted/cover.webp', 0, 0),
			('b', 'Second', ?, NULL, 0, 0),
			('c', 'Outside', ?, NULL, 0, 0);
		INSERT INTO book_files (id, book_id, format, relative_path, created_at) VALUES
			('fa', 'a', 'epub', 'library/deleted/book.epub', 0),
			('fb', 'b', 'pdf', 'library/shared.pdf', 0),
			('fc', 'c', 'pdf', 'library/shared.pdf', 0);
	`, delID, delID, keepID); err != nil {
		t.Fatalf("seed books: %v", err)
	}

	// Editor cannot delete (403); wrong confirmation name -> 409; missing confirmation -> 400
	if code, _ := env.do(http.MethodDelete, "/api/collections/"+delID, &member, map[string]any{
		"confirmationName": "Delete Me",
		"deleteBooks":      true,
	}); code != http.StatusForbidden {
		t.Fatalf("editor delete = %d, want 403", code)
	}
	if code, _ := env.do(http.MethodDelete, "/api/collections/"+delID, &owner, map[string]any{
		"confirmationName": "Wrong",
		"deleteBooks":      true,
	}); code != http.StatusConflict {
		t.Fatalf("wrong confirmation = %d, want 409", code)
	}
	if code, _ := env.do(http.MethodDelete, "/api/collections/"+delID, &owner, nil); code != http.StatusBadRequest {
		t.Fatalf("missing body = %d, want 400", code)
	}

	// Valid populated delete removes books + unshared files + thumbnails, preserves shared.pdf and storage_operations is clean
	code, delBody := env.do(http.MethodDelete, "/api/collections/"+delID, &owner, map[string]any{
		"confirmationName": "Delete Me",
		"deleteBooks":      true,
	})
	if code != http.StatusOK || int(delBody["data"].(map[string]any)["deletedBooks"].(float64)) != 2 {
		t.Fatalf("populated delete = (%d, %v)", code, delBody)
	}
	for _, removed := range []string{"deleted/book.epub", "deleted/cover.webp", "deleted/cover.thumb.webp"} {
		if _, err := os.Stat(filepath.Join(env.libraryDir, removed)); !os.IsNotExist(err) {
			t.Fatalf("expected %s to be removed, stat err = %v", removed, err)
		}
	}
	sharedBytes, err := os.ReadFile(filepath.Join(env.libraryDir, "shared.pdf"))
	if err != nil || string(sharedBytes) != "shared.pdf" {
		t.Fatalf("shared.pdf must be preserved, got %q (%v)", string(sharedBytes), err)
	}
	var opCount int
	_ = env.opened.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM storage_operations`).Scan(&opCount)
	if opCount != 0 {
		t.Fatalf("expected 0 remaining storage_operations, got %d", opCount)
	}
}

func TestCollectionMigrationPreviewApplyAndResume(t *testing.T) {
	env := newColTestEnv(t)
	ctx := context.Background()

	owner := env.signup("Owner", "owner@example.invalid")
	reader := env.signup("Reader", "reader@example.invalid")

	// Create two collections and stage a legacy split + orphan + Dropbox multi-target + pending state.
	code, cA := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Legacy A"})
	if code != http.StatusOK {
		t.Fatalf("create Legacy A: %d", code)
	}
	colA := cA["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	code, cB := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Legacy B"})
	if code != http.StatusOK {
		t.Fatalf("create Legacy B: %d", code)
	}
	colB := cB["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	_, _ = env.do(http.MethodPut, "/api/collections/"+colA+"/members", &owner, map[string]any{"email": reader.Email, "role": "viewer"})
	_, _ = env.do(http.MethodPut, "/api/collections/"+colB+"/members", &owner, map[string]any{"email": reader.Email, "role": "editor"})

	if err := os.MkdirAll(filepath.Join(env.libraryDir, "src"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	_ = os.WriteFile(filepath.Join(env.libraryDir, "src/book.epub"), []byte("ebook-bytes"), 0o644)
	_ = os.WriteFile(filepath.Join(env.libraryDir, "src/cover.webp"), []byte("cover-bytes"), 0o644)
	_ = os.WriteFile(filepath.Join(env.libraryDir, "src/cover.thumb.webp"), []byte("thumb-bytes"), 0o644)

	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`UPDATE collections SET is_personal = 1 WHERE id = ?`, []any{colA}},
		{`INSERT INTO books (id, title, calibre_book_id, collection_id, cover_image_path, created_by_user_id, created_at, updated_at) VALUES ('split-book', 'Split Title', 7, ?, 'library/src/cover.webp', ?, 0, 0), ('orphan-book', 'Orphan Title', NULL, ?, NULL, ?, 0, 0)`, []any{colA, owner.ID, colA, owner.ID}},
		{`INSERT INTO book_files (id, book_id, format, relative_path, created_at) VALUES ('bf1', 'split-book', 'epub', 'library/src/book.epub', 0)`, nil},
		{`INSERT INTO user_book_status (user_id, book_id, status, tbr_rank, updated_at) VALUES (?, 'split-book', 'to_be_read', 1, 0)`, []any{reader.ID}},
		{`INSERT INTO book_notes (id, user_id, book_id, text, created_at, updated_at) VALUES ('note1', ?, 'split-book', 'Reader note', 0, 0)`, []any{reader.ID}},
		{`INSERT INTO legacy_collection_books (collection_id, book_id, added_by_user_id, added_at) VALUES (?, 'split-book', ?, 0), (?, 'split-book', ?, 0)`, []any{colA, owner.ID, colB, owner.ID}},
		{`INSERT INTO global_settings (user_id, settings, updated_at) VALUES ('00000000-0000-0000-0000-000000000000', ?, 0)`, []any{`{"dropbox":{"additionalCollectionIds":["` + colA + `","` + colB + `"]}}`}},
		{`UPDATE system_state SET value = 'pending' WHERE key = 'collections-model'`, nil},
	} {
		if _, err := env.opened.DB.ExecContext(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("stage legacy migration (%s): %v", stmt.sql, err)
		}
	}

	// Non-admin preview -> 403
	if code, _ := env.do(http.MethodGet, "/api/settings/admin/collections-migration", &reader, nil); code != http.StatusForbidden {
		t.Fatalf("non-admin preview = %d, want 403", code)
	}

	// Admin preview reports 1 split, 1 private, 1 recovered, dropbox needsChoice=true
	code, prevResp := env.do(http.MethodGet, "/api/settings/admin/collections-migration", &owner, nil)
	if code != http.StatusOK {
		t.Fatalf("admin preview = (%d, %v)", code, prevResp)
	}
	prev := prevResp["data"].(map[string]any)
	if prev["state"] != "pending" ||
		int(prev["privateCollections"].(float64)) != 1 ||
		int(prev["recoveredBooks"].(float64)) != 1 ||
		len(prev["splits"].([]any)) != 1 ||
		prev["dropboxTargets"].(map[string]any)["needsChoice"] != true {
		t.Fatalf("unexpected preview: %v", prev)
	}
	fp := prev["fingerprint"].(string)

	// Missing backupConfirmed -> 400
	if code, _ := env.do(http.MethodPost, "/api/settings/admin/collections-migration", &owner, map[string]any{
		"fingerprint":     fp,
		"choices":         []map[string]string{{"bookId": "split-book", "collectionId": colB}},
		"backupConfirmed": false,
		"dropboxTargetId": "",
	}); code != http.StatusBadRequest {
		t.Fatalf("backupConfirmed=false = %d, want 400", code)
	}

	// Missing dropboxTargetId when needsChoice=true -> 400
	if code, _ := env.do(http.MethodPost, "/api/settings/admin/collections-migration", &owner, map[string]any{
		"fingerprint":     fp,
		"choices":         []map[string]string{{"bookId": "split-book", "collectionId": colB}},
		"backupConfirmed": true,
	}); code != http.StatusBadRequest {
		t.Fatalf("missing dropboxTargetId = %d, want 400", code)
	}

	// Apply migration -> 200, state becomes exclusive, split creates copy with files/sidecars/notes/TBR
	code, applyResp := env.do(http.MethodPost, "/api/settings/admin/collections-migration", &owner, map[string]any{
		"fingerprint":     fp,
		"choices":         []map[string]string{{"bookId": "split-book", "collectionId": colB}},
		"backupConfirmed": true,
		"dropboxTargetId": "",
	})
	if code != http.StatusOK || applyResp["data"].(map[string]any)["complete"] != true {
		t.Fatalf("apply migration = (%d, %v)", code, applyResp)
	}

	code, afterPrev := env.do(http.MethodGet, "/api/settings/admin/collections-migration", &owner, nil)
	if code != http.StatusOK || afterPrev["data"].(map[string]any)["state"] != "exclusive" {
		t.Fatalf("after migration preview = (%d, %v)", code, afterPrev)
	}

	var splitCount int
	_ = env.opened.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM books WHERE title = 'Split Title'`).Scan(&splitCount)
	if splitCount != 2 {
		t.Fatalf("expected 2 Split Title books after migration, got %d", splitCount)
	}

	var copyID string
	if err := env.opened.DB.QueryRowContext(ctx, `SELECT id FROM books WHERE title = 'Split Title' AND id != 'split-book'`).Scan(&copyID); err != nil {
		t.Fatalf("find copied book: %v", err)
	}
	thumbBytes, err := os.ReadFile(filepath.Join(env.libraryDir, "collection-copies", copyID, "cover.thumb.webp"))
	if err != nil || string(thumbBytes) != "thumb-bytes" {
		t.Fatalf("expected copied thumbnail, got %q (%v)", string(thumbBytes), err)
	}

	var noteCount int
	_ = env.opened.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM book_notes WHERE user_id = ?`, reader.ID).Scan(&noteCount)
	if noteCount != 2 {
		t.Fatalf("expected 2 reader notes across split books, got %d", noteCount)
	}

	var orphanColName string
	_ = env.opened.DB.QueryRowContext(ctx, `SELECT c.name FROM books b JOIN collections c ON c.id = b.collection_id WHERE b.id = 'orphan-book'`).Scan(&orphanColName)
	if orphanColName != "Recovered books" {
		t.Fatalf("orphan collection = %q, want Recovered books", orphanColName)
	}
}

func TestCollectionMigrationMalformedFieldAndInterruptedResume(t *testing.T) {
	env := newColTestEnv(t)
	ctx := context.Background()

	owner := env.signup("Owner", "owner@example.invalid")
	_, cA := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Col A"})
	_, cB := env.do(http.MethodPost, "/api/collections", &owner, map[string]any{"name": "Col B"})
	colA := cA["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)
	colB := cB["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	_ = os.MkdirAll(filepath.Join(env.libraryDir, "src"), 0o755)
	_ = os.WriteFile(filepath.Join(env.libraryDir, "src/book.epub"), []byte("ebook-bytes"), 0o644)

	for _, stmt := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO books (id, title, collection_id, created_by_user_id, created_at, updated_at) VALUES ('b1', 'Book', ?, ?, 0, 0)`, []any{colA, owner.ID}},
		{`INSERT INTO book_files (id, book_id, format, relative_path, created_at) VALUES ('f1', 'b1', 'epub', X'616263', 0)`, nil},
		{`INSERT INTO legacy_collection_books (collection_id, book_id, added_by_user_id, added_at) VALUES (?, 'b1', ?, 0), (?, 'b1', ?, 0)`, []any{colA, owner.ID, colB, owner.ID}},
		{`UPDATE system_state SET value = 'pending' WHERE key = 'collections-model'`, nil},
	} {
		if _, err := env.opened.DB.ExecContext(ctx, stmt.sql, stmt.args...); err != nil {
			t.Fatalf("seed (%s): %v", stmt.sql, err)
		}
	}

	// Malformed BLOB in book_files.relative_path stops preview with 409.
	if code, _ := env.do(http.MethodGet, "/api/settings/admin/collections-migration", &owner, nil); code != http.StatusConflict {
		t.Fatalf("malformed preview = %d, want 409", code)
	}

	// Repair field, then remove source file to force an interrupted copy; plan is retained and state becomes migrating.
	_, _ = env.opened.DB.ExecContext(ctx, `UPDATE book_files SET relative_path = 'library/src/book.epub' WHERE id = 'f1'`)
	code, prevResp := env.do(http.MethodGet, "/api/settings/admin/collections-migration", &owner, nil)
	if code != http.StatusOK {
		t.Fatalf("repaired preview = %d", code)
	}
	fp := prevResp["data"].(map[string]any)["fingerprint"].(string)

	_ = os.Remove(filepath.Join(env.libraryDir, "src/book.epub"))
	code, _ = env.do(http.MethodPost, "/api/settings/admin/collections-migration", &owner, map[string]any{
		"fingerprint":     fp,
		"choices":         []map[string]string{{"bookId": "b1", "collectionId": colA}},
		"backupConfirmed": true,
	})
	if code != http.StatusInternalServerError {
		t.Fatalf("interrupted copy apply = %d, want 500", code)
	}

	code, midPrev := env.do(http.MethodGet, "/api/settings/admin/collections-migration", &owner, nil)
	if code != http.StatusOK || midPrev["data"].(map[string]any)["state"] != "migrating" {
		t.Fatalf("interrupted preview = (%d, %v), want state=migrating", code, midPrev)
	}

	// Restoring the source file and resuming with the retained choice succeeds.
	_ = os.WriteFile(filepath.Join(env.libraryDir, "src/book.epub"), []byte("ebook-bytes"), 0o644)
	// Mismatched choice must be rejected with 409.
	if code, _ := env.do(http.MethodPost, "/api/settings/admin/collections-migration", &owner, map[string]any{
		"fingerprint":     fp,
		"choices":         []map[string]string{{"bookId": "b1", "collectionId": colB}},
		"backupConfirmed": true,
	}); code != http.StatusConflict {
		t.Fatalf("mismatched resume choice = %d, want 409", code)
	}
	// Matching retained choice completes migration.
	if code, _ := env.do(http.MethodPost, "/api/settings/admin/collections-migration", &owner, map[string]any{
		"fingerprint":     fp,
		"choices":         []map[string]string{{"bookId": "b1", "collectionId": colA}},
		"backupConfirmed": true,
	}); code != http.StatusOK {
		t.Fatalf("resume migration = %d, want 200", code)
	}
}
