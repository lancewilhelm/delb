package admin_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/admin"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	_ "modernc.org/sqlite"
)

type testEnv struct {
	t          *testing.T
	db         *sql.DB
	srv        *httptest.Server
	tmpDir     string
	libraryDir string
	calibreDir string
}

func newAdminTestEnv(t *testing.T) *testEnv {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	calDir := filepath.Join(tmp, "calibre")
	if err := os.MkdirAll(libDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(calDir, 0o755); err != nil {
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
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:     opened.DB,
		Secret: "admin-test-secret-0123456789abcdef0123456789",
		Logger: discard,
	})
	colSvc := collections.NewService(collections.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		Logger:      discard,
	})
	booksSvc := books.NewService(books.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		Logger:      discard,
	})
	adminSvc := admin.NewService(admin.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		CalibreDir:  calDir,
		Logger:      discard,
	})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{colSvc, booksSvc, adminSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &testEnv{
		t:          t,
		db:         opened.DB,
		srv:        srv,
		tmpDir:     tmp,
		libraryDir: libDir,
		calibreDir: calDir,
	}
}

type testUser struct {
	ID     string
	Email  string
	Cookie string
}

func (e *testEnv) signUp(name, email string) testUser {
	e.t.Helper()
	payload, _ := json.Marshal(map[string]any{
		"name":     name,
		"email":    email,
		"password": "super-secret-password-1234",
	})
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/api/auth/sign-up/email", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.srv.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("signup %s: %v", email, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		e.t.Fatalf("signup %s status=%d body=%s", email, resp.StatusCode, string(b))
	}
	var out struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	var cookies []string
	for _, c := range resp.Cookies() {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	return testUser{ID: out.User.ID, Email: email, Cookie: strings.Join(cookies, "; ")}
}

func (e *testEnv) doJSON(user *testUser, method, path string, body any) (int, map[string]any) {
	e.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rdr)
	req.Header.Set("Origin", e.srv.URL)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if user != nil {
		req.Header.Set("Cookie", user.Cookie)
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

func makeSamplePNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 16, 24))
	for y := 0; y < 24; y++ {
		for x := 0; x < 16; x++ {
			img.Set(x, y, color.RGBA{R: 50, G: 120, B: 200, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestNukeEndpoint(t *testing.T) {
	env := newAdminTestEnv(t)
	owner := env.signUp("Owner", "owner@example.invalid")

	status, _ := env.doJSON(nil, http.MethodGet, "/api/nuke", nil)
	if status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /api/nuke = %d, want 401", status)
	}

	status, body := env.doJSON(&owner, http.MethodGet, "/api/nuke", nil)
	if status != http.StatusOK || body["success"] != true {
		t.Fatalf("authenticated GET /api/nuke = %d body=%v", status, body)
	}
}

func TestAdminHealthQuickAndDeep(t *testing.T) {
	env := newAdminTestEnv(t)
	owner := env.signUp("Owner", "owner@example.invalid")
	member := env.signUp("Member", "member@example.invalid")

	// Auth checks
	if status, _ := env.doJSON(nil, http.MethodPost, "/api/settings/admin/health", map[string]any{"mode": "quick"}); status != http.StatusUnauthorized {
		t.Fatalf("unauth health = %d, want 401", status)
	}
	if status, _ := env.doJSON(&member, http.MethodPost, "/api/settings/admin/health", map[string]any{"mode": "quick"}); status != http.StatusForbidden {
		t.Fatalf("non-admin health = %d, want 403", status)
	}

	// Create two collections with matching titles & duplicate identifiers + missing disk file/cover
	_, colResp := env.doJSON(&owner, http.MethodPost, "/api/collections", map[string]any{"name": "Second Shelf"})
	secondCol := colResp["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	_, b1Resp := env.doJSON(&owner, http.MethodPost, "/api/books", map[string]any{
		"title":   "Dune",
		"authors": []string{"Frank Herbert"},
	})
	b1ID := b1Resp["data"].(map[string]any)["book"].(map[string]any)["id"].(string)

	_, b2Resp := env.doJSON(&owner, http.MethodPost, "/api/books", map[string]any{
		"title":         "Dune",
		"authors":       []string{"Frank Herbert"},
		"collectionIds": []string{secondCol},
	})
	b2ID := b2Resp["data"].(map[string]any)["book"].(map[string]any)["id"].(string)

	// Duplicate identifier + missing book file + missing cover + cover without thumb
	if _, err := env.db.Exec(`INSERT INTO book_identifiers (book_id, type, value) VALUES (?, 'isbn', '9780441172719'), (?, 'isbn', '9780441172719')`, b1ID, b2ID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`INSERT INTO book_files (id, book_id, format, relative_path, created_at) VALUES ('f1', ?, 'epub', 'library/missing/book.epub', 100)`, b1ID); err != nil {
		t.Fatal(err)
	}
	coverFolder := filepath.Join(env.libraryDir, "hascover")
	if err := os.MkdirAll(coverFolder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(coverFolder, "cover.png"), makeSamplePNG(t), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`UPDATE books SET cover_image_path = 'library/hascover/missing-thumb.webp' WHERE id = ?`, b2ID); err != nil {
		t.Fatal(err)
	}

	// Quick mode
	status, resp := env.doJSON(&owner, http.MethodPost, "/api/settings/admin/health", map[string]any{"mode": "quick"})
	if status != http.StatusOK || resp["success"] != true {
		t.Fatalf("quick health failed: %d %v", status, resp)
	}
	data := resp["data"].(map[string]any)
	if data["mode"] != "quick" || data["overall"] != "warn" {
		t.Fatalf("unexpected quick health summary: %v", data)
	}
	checks := make(map[string]map[string]any)
	for _, raw := range data["results"].([]any) {
		m := raw.(map[string]any)
		checks[m["id"].(string)] = m
	}
	if checks["identifiers.duplicates"]["status"] != "warn" {
		t.Fatalf("expected identifiers.duplicates warn, got %v", checks["identifiers.duplicates"])
	}
	if checks["duplicates.cross-collection-titles"]["status"] != "warn" {
		t.Fatalf("expected cross-collection-titles warn, got %v", checks["duplicates.cross-collection-titles"])
	}
	if _, hasDeep := checks["duplicates.fuzzy-title-author"]; hasDeep {
		t.Fatalf("quick mode should not include deep checks")
	}

	// Deep mode
	status, deepResp := env.doJSON(&owner, http.MethodPost, "/api/settings/admin/health", map[string]any{"mode": "deep"})
	if status != http.StatusOK {
		t.Fatalf("deep health failed: %d %v", status, deepResp)
	}
	deepData := deepResp["data"].(map[string]any)
	if deepData["mode"] != "deep" || deepData["overall"] != "error" {
		t.Fatalf("unexpected deep health overall: %v", deepData)
	}
	deepChecks := make(map[string]map[string]any)
	for _, raw := range deepData["results"].([]any) {
		m := raw.(map[string]any)
		deepChecks[m["id"].(string)] = m
	}
	if deepChecks["duplicates.fuzzy-title-author"]["status"] != "warn" {
		t.Fatalf("expected fuzzy warn, got %v", deepChecks["duplicates.fuzzy-title-author"])
	}
	if deepChecks["book-files.missing-on-disk"]["status"] != "error" {
		t.Fatalf("expected missing file error, got %v", deepChecks["book-files.missing-on-disk"])
	}
	if deepChecks["covers.cover-image-path-missing-on-disk"]["status"] != "warn" {
		t.Fatalf("expected missing cover warn, got %v", deepChecks["covers.cover-image-path-missing-on-disk"])
	}
	if deepChecks["covers.missing-thumb-when-cover-exists"]["status"] != "warn" {
		t.Fatalf("expected missing thumb warn, got %v", deepChecks["covers.missing-thumb-when-cover-exists"])
	}
}

func TestAdminCalibreImportRescanAndRevocation(t *testing.T) {
	env := newAdminTestEnv(t)
	owner := env.signUp("Owner", "owner@example.invalid")

	_, colResp := env.doJSON(&owner, http.MethodPost, "/api/collections", map[string]any{"name": "Calibre Dest"})
	destCol := colResp["data"].(map[string]any)["collection"].(map[string]any)["id"].(string)

	// Missing metadata.db returns 400
	if status, _ := env.doJSON(&owner, http.MethodPost, "/api/settings/admin/calibre", map[string]any{
		"action":        "import",
		"collectionIds": []string{destCol},
	}); status != http.StatusBadRequest {
		t.Fatalf("missing calibre metadata.db = %d, want 400", status)
	}

	// Build a realistic Calibre metadata.db + fixture folder + cover + PDF
	bookFolder := filepath.Join(env.calibreDir, "Author One", "Calibre Book (1)")
	if err := os.MkdirAll(bookFolder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookFolder, "book.pdf"), []byte("%PDF-1.4\nfixture\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bookFolder, "cover.png"), makeSamplePNG(t), 0o644); err != nil {
		t.Fatal(err)
	}

	calDB, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Join(env.calibreDir, "metadata.db")))
	if err != nil {
		t.Fatal(err)
	}
	defer calDB.Close()
	for _, stmt := range []string{
		`CREATE TABLE books (id INTEGER PRIMARY KEY, title TEXT, sort TEXT, pubdate TEXT, path TEXT, series_index REAL)`,
		`CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT, sort TEXT)`,
		`CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT)`,
		`CREATE TABLE publishers (id INTEGER PRIMARY KEY, name TEXT)`,
		`CREATE TABLE series (id INTEGER PRIMARY KEY, name TEXT)`,
		`CREATE TABLE books_authors_link (book INTEGER, author INTEGER)`,
		`CREATE TABLE books_tags_link (book INTEGER, tag INTEGER)`,
		`CREATE TABLE books_publishers_link (book INTEGER, publisher INTEGER)`,
		`CREATE TABLE books_series_link (book INTEGER, series INTEGER)`,
		`CREATE TABLE comments (book INTEGER, text TEXT)`,
		`CREATE TABLE identifiers (book INTEGER, type TEXT, val TEXT)`,
		`INSERT INTO books VALUES (101, 'The Calibre Novel', 'Calibre Novel, The', '2020-05-01', 'Author One/Calibre Book (1)', 2.0)`,
		`INSERT INTO authors VALUES (1, 'Jane Doe', 'Doe, Jane')`,
		`INSERT INTO tags VALUES (1, 'Sci-Fi')`,
		`INSERT INTO publishers VALUES (1, 'Orbit')`,
		`INSERT INTO series VALUES (1, 'Star Saga')`,
		`INSERT INTO books_authors_link VALUES (101, 1)`,
		`INSERT INTO books_tags_link VALUES (101, 1)`,
		`INSERT INTO books_publishers_link VALUES (101, 1)`,
		`INSERT INTO books_series_link VALUES (101, 1)`,
		`INSERT INTO comments VALUES (101, '<p>Great book</p>')`,
		`INSERT INTO identifiers VALUES (101, 'isbn', '9780000000101')`,
	} {
		if _, err := calDB.Exec(stmt); err != nil {
			t.Fatalf("calibre seed %q: %v", stmt, err)
		}
	}

	// Dry run leaves Delb DB empty
	status, dryResp := env.doJSON(&owner, http.MethodPost, "/api/settings/admin/calibre", map[string]any{
		"action":        "import",
		"collectionIds": []string{destCol},
		"dryRun":        true,
	})
	if status != http.StatusOK {
		t.Fatalf("calibre dryRun = %d %v", status, dryResp)
	}
	var count int
	_ = env.db.QueryRow(`SELECT COUNT(*) FROM books WHERE calibre_book_id = 101`).Scan(&count)
	if count != 0 {
		t.Fatalf("dryRun should not write books, found %d", count)
	}

	// Real import
	status, impResp := env.doJSON(&owner, http.MethodPost, "/api/settings/admin/calibre", map[string]any{
		"action":        "import",
		"collectionIds": []string{destCol},
	})
	if status != http.StatusOK {
		t.Fatalf("calibre import = %d %v", status, impResp)
	}
	var bookID, title, coverPath string
	if err := env.db.QueryRow(`SELECT id, title, cover_image_path FROM books WHERE calibre_book_id = 101`).Scan(&bookID, &title, &coverPath); err != nil {
		t.Fatalf("imported book missing: %v", err)
	}
	if title != "The Calibre Novel" || !strings.HasSuffix(coverPath, "/thumb.webp") {
		t.Fatalf("unexpected imported book title=%q cover=%q", title, coverPath)
	}

	// Rescan updates metadata idempotently
	if _, err := calDB.Exec(`UPDATE books SET title = 'The Calibre Novel Updated' WHERE id = 101`); err != nil {
		t.Fatal(err)
	}
	status, _ = env.doJSON(&owner, http.MethodPost, "/api/settings/admin/calibre", map[string]any{
		"action":        "rescan",
		"collectionIds": []string{destCol},
	})
	if status != http.StatusOK {
		t.Fatalf("calibre rescan = %d", status)
	}
	_ = env.db.QueryRow(`SELECT title FROM books WHERE id = ?`, bookID).Scan(&title)
	if title != "The Calibre Novel Updated" {
		t.Fatalf("rescan did not update title: %q", title)
	}

	// Multiple collectionIds rejected with 400
	_, defColResp := env.doJSON(&owner, http.MethodGet, "/api/collections", nil)
	defaultCol := defColResp["data"].(map[string]any)["collections"].([]any)[0].(map[string]any)["id"].(string)
	if status, _ := env.doJSON(&owner, http.MethodPost, "/api/settings/admin/calibre", map[string]any{
		"action":        "import",
		"collectionIds": []string{destCol, defaultCol},
	}); status != http.StatusBadRequest {
		t.Fatalf("multi-collection calibre import = %d, want 400", status)
	}
}
