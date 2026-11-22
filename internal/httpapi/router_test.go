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
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/proxy"
	"github.com/lancewilhelm/delb/internal/settings"
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

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{settingsSvc, usersSvc, collectionsSvc},
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
		{http.MethodGet, "/api/settings/admin/spine-prompt", http.StatusUnauthorized},
		{http.MethodDelete, "/api/users/delete", http.StatusUnauthorized},
		{http.MethodGet, "/api/collections", http.StatusUnauthorized},
		{http.MethodPost, "/api/collections", http.StatusUnauthorized},
		{http.MethodGet, "/api/settings/admin/collections", http.StatusUnauthorized},
		{http.MethodGet, "/api/settings/admin/collections-migration", http.StatusUnauthorized},
	} {
		req, _ := http.NewRequest(tc.method, front.URL+tc.path, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", tc.method, tc.path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.want || upstreamHits != 0 {
			t.Fatalf("%s %s = %d (want %d), upstreamHits=%d", tc.method, tc.path, resp.StatusCode, tc.want, upstreamHits)
		}
	}

	// 2. Unported routes — crucially including /api/collections/{id}/bookshelf and
	// unported /api/settings/admin/* endpoints — fall through cleanly to upstream!
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/collections/abc-123/bookshelf"},
		{http.MethodPut, "/api/collections/abc-123/bookshelf"},
		{http.MethodPost, "/api/settings/admin/health"},
		{http.MethodPost, "/api/settings/admin/calibre"},
		{http.MethodGet, "/api/settings/admin/chatgpt-image"},
		{http.MethodGet, "/api/books"},
		{http.MethodGet, "/"},
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
