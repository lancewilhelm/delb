package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/admin"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/mcp"
	"github.com/lancewilhelm/delb/internal/proxy"
	"github.com/lancewilhelm/delb/internal/settings"
	"github.com/lancewilhelm/delb/internal/spines"
	"github.com/lancewilhelm/delb/internal/users"
)

func TestRouterPhase2AOwnedAndUnportedProxied(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "router.db")
	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer opened.DB.Close()
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	upstreamHits := 0
	var lastUpstreamPath string
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		lastUpstreamPath = r.Method + " " + r.URL.Path
		w.Header().Set("X-Handled-By", "upstream")
		_, _ = w.Write([]byte("upstream:" + r.Method + ":" + r.URL.Path))
	}))
	defer upstreamSrv.Close()

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	p, err := proxy.New(upstreamSrv.URL, discard)
	if err != nil {
		t.Fatalf("proxy.New: %v", err)
	}
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:     opened.DB,
		Secret: "router-test-secret-0123456789abcdef0123456789",
		Logger: discard,
	})
	settingsSvc := settings.NewService(settings.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      discard,
	})
	usersSvc := users.NewService(users.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      discard,
	})
	collectionsSvc := collections.NewService(collections.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  filepath.Join(tmp, "library"),
		Logger:      discard,
	})
	booksSvc := books.NewService(books.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  filepath.Join(tmp, "library"),
		Logger:      discard,
	})
	bookshelfSvc := bookshelf.NewService(bookshelf.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		TokenSecret: "router-test-secret-0123456789abcdef0123456789",
		Logger:      discard,
	})
	spinesSvc := spines.NewService(spines.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		AuthSecret:  "router-test-secret-0123456789abcdef0123456789",
		LibraryDir:  filepath.Join(tmp, "library"),
		Logger:      discard,
	})
	adminSvc := admin.NewService(admin.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  filepath.Join(tmp, "library"),
		CalibreDir:  filepath.Join(tmp, "calibre"),
		Logger:      discard,
	})
	mcpSvc := mcp.NewService(mcp.ServiceOptions{
		DB:               opened.DB,
		AuthService:      authSvc,
		BooksService:     booksSvc,
		BookshelfService: bookshelfSvc,
		Logger:           discard,
	})

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{settingsSvc, usersSvc, collectionsSvc, booksSvc, bookshelfSvc, spinesSvc, adminSvc, mcpSvc},
		Upstream:    p,
	})
	front := httptest.NewServer(handler)
	defer front.Close()

	// 1. Go-owned routes never hit upstream (even unauthenticated -> 401/200/404 from Go).
	for _, tc := range []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodGet, "/api/auth/user-count", http.StatusOK},
		{http.MethodGet, "/api/auth/nonexistent", http.StatusNotFound},
		{http.MethodGet, "/api/settings", http.StatusUnauthorized},
		{http.MethodPut, "/api/settings/user", http.StatusUnauthorized},
		{http.MethodPut, "/api/settings/global", http.StatusUnauthorized},
		{http.MethodPut, "/api/settings/admin/hardcover-token", http.StatusUnauthorized},
		{http.MethodPut, "/api/settings/admin/google-books-api-key", http.StatusUnauthorized},
		{http.MethodGet, "/api/settings/admin/spine-prompt", http.StatusUnauthorized},
		{http.MethodDelete, "/api/users/delete", http.StatusUnauthorized},
		{http.MethodGet, "/api/collections", http.StatusUnauthorized},
		{http.MethodPost, "/api/collections", http.StatusUnauthorized},
		{http.MethodGet, "/api/settings/admin/collections", http.StatusUnauthorized},
		{http.MethodGet, "/api/settings/admin/collections-migration", http.StatusUnauthorized},
		// Phase 2B Go-owned routes
		{http.MethodGet, "/api/books", http.StatusUnauthorized},
		{http.MethodPost, "/api/books", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1", http.StatusUnauthorized},
		{http.MethodPut, "/api/books/book-1", http.StatusUnauthorized},
		{http.MethodDelete, "/api/books/book-1", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/upload", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/cover", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/cover", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/download", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/files", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/collections", http.StatusUnauthorized},
		{http.MethodPut, "/api/books/book-1/collections", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/move", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/collection-sources", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/bulk/copies", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/bulk/status", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/metadata/hardcover/search", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/metadata/cover", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/metadata-import/create", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/rating", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/status", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/status", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/rationale", http.StatusUnauthorized},
		{http.MethodPut, "/api/books/book-1/rationale", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/reading-position", http.StatusUnauthorized},
		{http.MethodPut, "/api/books/book-1/reading-position", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/progress", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/progress-logs", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/progress-logs", http.StatusUnauthorized},
		{http.MethodPut, "/api/books/book-1/progress-sync", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/finish-summary", http.StatusUnauthorized},
		{http.MethodGet, "/api/tbr", http.StatusUnauthorized},
		{http.MethodGet, "/api/dashboard", http.StatusUnauthorized},
		{http.MethodGet, "/api/dashboard/overview", http.StatusUnauthorized},
		{http.MethodGet, "/api/dashboard/recent", http.StatusUnauthorized},
		{http.MethodGet, "/api/authors", http.StatusUnauthorized},
		{http.MethodGet, "/api/authors/search", http.StatusUnauthorized},
		{http.MethodGet, "/api/authors/a1/books", http.StatusUnauthorized},
		{http.MethodGet, "/api/publishers", http.StatusUnauthorized},
		{http.MethodGet, "/api/publishers/search", http.StatusUnauthorized},
		{http.MethodGet, "/api/publishers/p1/books", http.StatusUnauthorized},
		{http.MethodGet, "/api/series", http.StatusUnauthorized},
		{http.MethodGet, "/api/series/search", http.StatusUnauthorized},
		{http.MethodGet, "/api/series/s1/books", http.StatusUnauthorized},
		{http.MethodGet, "/api/tags", http.StatusUnauthorized},
		{http.MethodGet, "/api/tags/search", http.StatusUnauthorized},
		{http.MethodGet, "/api/tags/t1/books", http.StatusUnauthorized},
		{http.MethodDelete, "/api/tags/t1", http.StatusUnauthorized},
		{http.MethodPost, "/api/tags/t1/merge", http.StatusUnauthorized},
		{http.MethodGet, "/api/genres", http.StatusUnauthorized},
		{http.MethodGet, "/api/genres/search", http.StatusUnauthorized},
		{http.MethodGet, "/api/genres/g1/books", http.StatusUnauthorized},
		{http.MethodDelete, "/api/genres/g1", http.StatusUnauthorized},
		{http.MethodPost, "/api/genres/g1/merge", http.StatusUnauthorized},
		{http.MethodGet, "/api/search", http.StatusUnauthorized},
		// Phase 2C Go-owned routes
		{http.MethodGet, "/api/collections/abc-123/bookshelf", http.StatusUnauthorized},
		{http.MethodPut, "/api/collections/abc-123/bookshelf", http.StatusUnauthorized},
		{http.MethodGet, "/api/shelves", http.StatusUnauthorized},
		{http.MethodPost, "/api/shelves", http.StatusUnauthorized},
		{http.MethodGet, "/api/shelves/s1", http.StatusUnauthorized},
		{http.MethodPut, "/api/shelves/s1", http.StatusUnauthorized},
		{http.MethodPatch, "/api/shelves/s1", http.StatusUnauthorized},
		{http.MethodDelete, "/api/shelves/s1", http.StatusUnauthorized},
		{http.MethodPost, "/api/shelves/s1/books", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/shelves", http.StatusUnauthorized},
		{http.MethodGet, "/api/bookshelf-pictures/collection/abc-123", http.StatusUnauthorized},
		{http.MethodPost, "/api/bookshelf-pictures/personal/s1", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/spine", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/spine", http.StatusUnauthorized},
		{http.MethodDelete, "/api/books/book-1/spine", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/spine-generate", http.StatusUnauthorized},
		{http.MethodGet, "/api/books/book-1/spine-generate/connection", http.StatusUnauthorized},
		{http.MethodPost, "/api/books/book-1/spine-generate/connection", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/books/book-1/spine-generate/series-references", http.StatusUnauthorized},
		{http.MethodGet, "/api/settings/admin/chatgpt-image", http.StatusUnauthorized},
		{http.MethodPost, "/api/settings/admin/chatgpt-image", http.StatusUnauthorized},
		{http.MethodDelete, "/api/settings/admin/chatgpt-image", http.StatusUnauthorized},
		// Phase 2D Go-owned routes
		{http.MethodPost, "/api/settings/admin/health", http.StatusUnauthorized},
		{http.MethodPost, "/api/settings/admin/calibre", http.StatusUnauthorized},
		{http.MethodGet, "/api/nuke", http.StatusUnauthorized},
		{http.MethodGet, "/api/mcp-connections", http.StatusUnauthorized},
		{http.MethodPost, "/api/mcp-connections", http.StatusForbidden},
		{http.MethodPatch, "/api/mcp-connections", http.StatusForbidden},
		{http.MethodDelete, "/api/mcp-connections", http.StatusForbidden},
		{http.MethodGet, "/api/mcp", http.StatusUnauthorized},
		{http.MethodPost, "/api/mcp", http.StatusUnauthorized},
		{http.MethodDelete, "/api/mcp", http.StatusUnauthorized},
		// Unknown /api/* routes return Go JSON 404 without hitting upstream
		{http.MethodGet, "/api/settings/admin/health", http.StatusNotFound},
		{http.MethodGet, "/api/settings/admin/calibre", http.StatusNotFound},
		{http.MethodPost, "/api/nuke", http.StatusNotFound},
		{http.MethodGet, "/api/does-not-exist", http.StatusNotFound},
		{http.MethodPost, "/api/unknown/nested/route", http.StatusNotFound},
	} {
		req, _ := http.NewRequest(tc.method, front.URL+tc.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != tc.want || upstreamHits != 0 {
			t.Fatalf("%s %s = %d (want %d), upstreamHits=%d body=%s", tc.method, tc.path, resp.StatusCode, tc.want, upstreamHits, string(b))
		}
		if tc.want == http.StatusNotFound {
			var payload map[string]any
			if err := json.Unmarshal(b, &payload); err != nil {
				t.Fatalf("%s %s 404 body is not valid JSON: %v (%s)", tc.method, tc.path, err, string(b))
			}
		}
	}

	// 2. Non-API frontend paths still proxy cleanly to upstream until Phase 3.
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/"},
		{http.MethodGet, "/library"},
		{http.MethodGet, "/_nuxt/app.js"},
	} {
		before := upstreamHits
		req, _ := http.NewRequest(tc.method, front.URL+tc.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		wantBody := "upstream:" + tc.method + ":" + tc.path
		if resp.Header.Get("X-Handled-By") != "upstream" || string(b) != wantBody || upstreamHits != before+1 {
			t.Fatalf("%s %s got header=%q body=%q (last=%q, hits=%d)", tc.method, tc.path, resp.Header.Get("X-Handled-By"), string(b), lastUpstreamPath, upstreamHits)
		}
	}
}

func TestCollectionMigrationGateMiddleware(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "gate.db")
	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer opened.DB.Close()
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	if _, err := opened.DB.ExecContext(ctx, `UPDATE system_state SET value = 'pending' WHERE key = 'collections-model'`); err != nil {
		t.Fatalf("set pending: %v", err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"ok": r.URL.Path})
	})
	srv := httptest.NewServer(httpapi.CollectionMigrationGate(opened.DB, slog.New(slog.NewTextHandler(io.Discard, nil)), next))
	defer srv.Close()

	check := func(method, path string, want int) {
		t.Helper()
		req, _ := http.NewRequest(method, srv.URL+path, bytes.NewReader([]byte(`{}`)))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatalf("%s %s = %d, want %d", method, path, resp.StatusCode, want)
		}
	}

	// Non-API and allowlisted paths pass through when pending & 0 users.
	check(http.MethodGet, "/", http.StatusOK)
	check(http.MethodGet, "/api/settings", http.StatusOK)
	check(http.MethodGet, "/api/settings/user", http.StatusOK)
	check(http.MethodGet, "/api/settings/global", http.StatusOK)
	check(http.MethodGet, "/api/settings/admin/collections-migration", http.StatusOK)
	check(http.MethodPost, "/api/settings/admin/collections-migration", http.StatusOK)
	check(http.MethodGet, "/api/auth/get-session", http.StatusOK)
	check(http.MethodPost, "/api/auth/sign-in/email", http.StatusOK)
	check(http.MethodPost, "/api/auth/sign-out", http.StatusOK)
	check(http.MethodPost, "/api/auth/sign-up/email", http.StatusOK)

	// Ordinary API routes return 503 during pending migration.
	check(http.MethodGet, "/api/books", http.StatusServiceUnavailable)
	check(http.MethodGet, "/api/collections", http.StatusServiceUnavailable)
	check(http.MethodPut, "/api/settings/user", http.StatusServiceUnavailable)
	check(http.MethodDelete, "/api/users/delete", http.StatusServiceUnavailable)

	// Once at least one user exists, sign-up is also blocked with 503.
	if _, err := opened.DB.ExecContext(ctx, `
		INSERT INTO users (id, name, email, email_verified, created_at, updated_at, role)
		VALUES ('u1', 'Owner', 'owner@example.invalid', 1, 0, 0, 'owner')
	`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	check(http.MethodPost, "/api/auth/sign-up/email", http.StatusServiceUnavailable)

	// Once state returns to 'exclusive', all routes pass through.
	if _, err := opened.DB.ExecContext(ctx, `UPDATE system_state SET value = 'exclusive' WHERE key = 'collections-model'`); err != nil {
		t.Fatalf("set exclusive: %v", err)
	}
	check(http.MethodGet, "/api/books", http.StatusOK)
	check(http.MethodGet, "/api/collections", http.StatusOK)
	check(http.MethodPut, "/api/settings/user", http.StatusOK)
}
