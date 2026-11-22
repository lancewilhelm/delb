package httpapi_test

import (
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
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/proxy"
)

func TestRouterAuthOwnedAndNonAuthProxied(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "router.db")
	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer opened.DB.Close()
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	upstreamHits := 0
	upstreamSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamHits++
		w.Header().Set("X-Handled-By", "upstream")
		_, _ = w.Write([]byte("upstream:" + r.URL.Path))
	}))
	defer upstreamSrv.Close()

	p, err := proxy.New(upstreamSrv.URL, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("proxy.New: %v", err)
	}
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:     opened.DB,
		Secret: "router-test-secret-0123456789abcdef0123456789",
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		AuthService: authSvc,
		Upstream:    p,
	})
	front := httptest.NewServer(handler)
	defer front.Close()

	// 1. /api/auth/user-count is handled directly by Go (0 upstream hits).
	resp, err := http.Get(front.URL + "/api/auth/user-count")
	if err != nil {
		t.Fatalf("GET /api/auth/user-count: %v", err)
	}
	var count int
	_ = json.NewDecoder(resp.Body).Decode(&count)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || count != 0 || upstreamHits != 0 {
		t.Fatalf("user-count = (%d, %d), upstreamHits=%d", resp.StatusCode, count, upstreamHits)
	}

	// 2. Unknown /api/auth/nonexistent returns JSON 404 from Go and never hits upstream.
	resp, err = http.Get(front.URL + "/api/auth/nonexistent")
	if err != nil {
		t.Fatalf("GET /api/auth/nonexistent: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound || upstreamHits != 0 {
		t.Fatalf("unknown auth route = %d, upstreamHits=%d", resp.StatusCode, upstreamHits)
	}

	// 3. /api/books and / are proxied to upstream.
	for _, p := range []string{"/api/books", "/"} {
		resp, err := http.Get(front.URL + p)
		if err != nil {
			t.Fatalf("GET %s: %v", p, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.Header.Get("X-Handled-By") != "upstream" || string(b) != "upstream:"+p {
			t.Fatalf("GET %s got header=%q body=%q", p, resp.Header.Get("X-Handled-By"), string(b))
		}
	}
	if upstreamHits != 2 {
		t.Fatalf("upstreamHits = %d, want 2", upstreamHits)
	}
}
