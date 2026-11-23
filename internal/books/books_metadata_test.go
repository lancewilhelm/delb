package books_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/settings"
)

type metadataTestEnv struct {
	t      *testing.T
	opened *db.OpenResult
	server *httptest.Server
	client *http.Client
	logs   *bytes.Buffer
}

func newMetadataTestEnv(t *testing.T, googleBooksURL string) *metadataTestEnv {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "metadata.db")
	libDir := filepath.Join(tmp, "library")
	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	var logBuf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logBuf, nil))
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:        opened.DB,
		Secret:    "metadata-test-secret-0123456789abcdef0123456789",
		Logger:    logger,
		RateLimit: auth.RateLimitConfig{Disabled: true},
	})
	collectionsSvc := collections.NewService(collections.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		Logger:      logger,
	})
	booksSvc := books.NewService(books.ServiceOptions{
		DB:                  opened.DB,
		AuthService:         authSvc,
		LibraryDir:          libDir,
		Logger:              logger,
		GoogleBooksEndpoint: googleBooksURL,
	})
	settingsSvc := settings.NewService(settings.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      logger,
	})

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      logger,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{collectionsSvc, booksSvc, settingsSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	jar, _ := cookiejar.New(nil)
	return &metadataTestEnv{
		t:      t,
		opened: opened,
		server: srv,
		client: &http.Client{Jar: jar},
		logs:   &logBuf,
	}
}

func (e *metadataTestEnv) doJSON(method, path string, body any) (int, string, map[string]any) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			e.t.Fatalf("marshal: %v", err)
		}
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, e.server.URL+path, r)
	if err != nil {
		e.t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Origin", e.server.URL)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := e.client.Do(req)
	if err != nil {
		e.t.Fatalf("do %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var parsed map[string]any
	_ = json.Unmarshal(raw, &parsed)
	return resp.StatusCode, string(raw), parsed
}

func (e *metadataTestEnv) signUpOwner() {
	e.t.Helper()
	code, raw, _ := e.doJSON(http.MethodPost, "/api/auth/sign-up/email", map[string]any{
		"name":     "Owner",
		"email":    "owner@example.test",
		"password": "StrongPassword123!",
	})
	if code != http.StatusOK {
		e.t.Fatalf("sign-up failed (%d): %s", code, raw)
	}
}

func (e *metadataTestEnv) setGoogleBooksAPIKey(apiKey string) {
	e.t.Helper()
	if apiKey == "" {
		if _, err := e.opened.DB.ExecContext(context.Background(), `DELETE FROM global_secrets WHERE id = ?`, settings.GoogleBooksSecretID); err != nil {
			e.t.Fatalf("delete secret: %v", err)
		}
		return
	}
	if _, err := e.opened.DB.ExecContext(context.Background(), `
		INSERT INTO global_secrets (id, value, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`, settings.GoogleBooksSecretID, apiKey, time.Now().UTC().Unix()); err != nil {
		e.t.Fatalf("upsert secret: %v", err)
	}
}

func TestGoogleBooksSearchAPIKeyAndErrors(t *testing.T) {
	var (
		mu         sync.Mutex
		lastQuery  url.Values
		nextStatus = http.StatusOK
		nextBody   = `{"kind":"books#volumes","totalItems":1,"items":[{"id":"vol-1","volumeInfo":{"title":"Dune","authors":["Frank Herbert"]}}]}`
		closeConn  = false
	)

	mockGB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastQuery = r.URL.Query()
		status := nextStatus
		body := nextBody
		drop := closeConn
		mu.Unlock()

		if drop {
			if hj, ok := w.(http.Hijacker); ok {
				if conn, _, err := hj.Hijack(); err == nil {
					_ = conn.Close()
					return
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer mockGB.Close()

	env := newMetadataTestEnv(t, mockGB.URL)

	// 1. Without configured API key: omits `key` query param.
	code, raw, _ := env.doJSON(http.MethodGet, "/api/books/metadata/search?q=Dune", nil)
	if code != http.StatusOK {
		t.Fatalf("search without key = %d (%s), want 200", code, raw)
	}
	mu.Lock()
	gotQuery := lastQuery
	mu.Unlock()
	if gotQuery.Get("q") != "Dune" || gotQuery.Get("maxResults") != "20" {
		t.Fatalf("unexpected query params without key: %v", gotQuery)
	}
	if gotQuery.Has("key") {
		t.Fatalf("expected no `key` query param when unset, got %v", gotQuery)
	}

	// 2. With configured API key: appends `key=<apiKey>`.
	const secretKey = "AIzaSy-Secret-Google-Key-12345"
	env.setGoogleBooksAPIKey(secretKey)

	code, raw, _ = env.doJSON(http.MethodGet, "/api/books/metadata/search?q=Hyperion", nil)
	if code != http.StatusOK {
		t.Fatalf("search with key = %d (%s), want 200", code, raw)
	}
	mu.Lock()
	gotQuery = lastQuery
	mu.Unlock()
	if gotQuery.Get("key") != secretKey {
		t.Fatalf("expected key=%q, got %q", secretKey, gotQuery.Get("key"))
	}
	if gotQuery.Get("q") != "Hyperion" {
		t.Fatalf("expected q=Hyperion, got %q", gotQuery.Get("q"))
	}

	// 3. HTTP 429 RESOURCE_EXHAUSTED with NO key configured -> clear HTTP 429 message.
	env.setGoogleBooksAPIKey("")
	mu.Lock()
	nextStatus = http.StatusTooManyRequests
	nextBody = `{"error":{"code":429,"message":"Quota exceeded for quota metric 'Queries'","status":"RESOURCE_EXHAUSTED"}}`
	mu.Unlock()

	code, raw, parsed := env.doJSON(http.MethodGet, "/api/books/metadata/search?q=Dune", nil)
	if code != http.StatusTooManyRequests {
		t.Fatalf("429 without key = %d (%s), want 429", code, raw)
	}
	msg, _ := parsed["message"].(string)
	if !strings.Contains(msg, "quota exceeded") || !strings.Contains(msg, "Admin Settings") || !strings.Contains(msg, "Hardcover") {
		t.Fatalf("expected actionable quota error message, got %q", msg)
	}

	// 4. HTTP 429 RESOURCE_EXHAUSTED WITH key configured -> HTTP 429 and no secret leak in body or logs.
	env.setGoogleBooksAPIKey(secretKey)
	env.logs.Reset()
	code, raw, parsed = env.doJSON(http.MethodGet, "/api/books/metadata/search?q=Dune", nil)
	if code != http.StatusTooManyRequests {
		t.Fatalf("429 with key = %d (%s), want 429", code, raw)
	}
	if strings.Contains(raw, secretKey) {
		t.Fatalf("429 response body leaked API key: %s", raw)
	}
	if strings.Contains(env.logs.String(), secretKey) {
		t.Fatalf("429 logs leaked API key: %s", env.logs.String())
	}
	msg, _ = parsed["message"].(string)
	if !strings.Contains(msg, "quota exceeded") || !strings.Contains(msg, "Admin Settings") {
		t.Fatalf("expected actionable quota error message, got %q", msg)
	}

	// 5. Invalid API key (400 keyInvalid) -> clear error, no leak.
	mu.Lock()
	nextStatus = http.StatusBadRequest
	nextBody = `{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","errors":[{"reason":"keyInvalid"}]}}`
	mu.Unlock()
	env.logs.Reset()
	code, raw, parsed = env.doJSON(http.MethodGet, "/api/books/metadata/search?q=Dune", nil)
	if code != http.StatusBadGateway {
		t.Fatalf("invalid key = %d (%s), want 502", code, raw)
	}
	if strings.Contains(raw, secretKey) || strings.Contains(env.logs.String(), secretKey) {
		t.Fatalf("invalid key error leaked API key")
	}
	msg, _ = parsed["message"].(string)
	if !strings.Contains(msg, "rejected the configured API key") {
		t.Fatalf("unexpected invalid key message: %q", msg)
	}

	// 6. Upstream transport failure with API key configured -> never leaks key in body or logs.
	mu.Lock()
	closeConn = true
	mu.Unlock()
	env.logs.Reset()
	code, raw, _ = env.doJSON(http.MethodGet, "/api/books/metadata/search?q=Dune", nil)
	if code != http.StatusBadGateway {
		t.Fatalf("transport error = %d (%s), want 502", code, raw)
	}
	if strings.Contains(raw, secretKey) {
		t.Fatalf("transport error response leaked API key: %s", raw)
	}
	if strings.Contains(env.logs.String(), secretKey) {
		t.Fatalf("transport error logs leaked API key: %s", env.logs.String())
	}
}

func TestGoogleBooksMetadataImportCreateAPIKeyAndQuotaError(t *testing.T) {
	var (
		mu         sync.Mutex
		lastQuery  url.Values
		nextStatus = http.StatusOK
		nextBody   = `{"kind":"books#volumes","totalItems":1,"items":[{"id":"vol-42","volumeInfo":{"title":"The Left Hand of Darkness","authors":["Ursula K. Le Guin"],"publishedDate":"1969"}}]}`
	)

	mockGB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		lastQuery = r.URL.Query()
		status := nextStatus
		body := nextBody
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	defer mockGB.Close()

	env := newMetadataTestEnv(t, mockGB.URL)
	env.signUpOwner()

	// 1. Import without API key configured -> omits `key`, succeeds.
	code, raw, parsed := env.doJSON(http.MethodPost, "/api/books/metadata-import/create", map[string]any{
		"query": "The Left Hand of Darkness",
	})
	if code != http.StatusOK || parsed["success"] != true {
		t.Fatalf("import without key = %d (%s), want 200", code, raw)
	}
	mu.Lock()
	gotQuery := lastQuery
	mu.Unlock()
	if gotQuery.Has("key") || gotQuery.Get("maxResults") != "1" {
		t.Fatalf("unexpected query params on import without key: %v", gotQuery)
	}

	// 2. Import with API key configured -> appends `key`, succeeds.
	const secretKey = "AIzaSy-Import-Secret-Key-67890"
	env.setGoogleBooksAPIKey(secretKey)
	mu.Lock()
	nextBody = `{"kind":"books#volumes","totalItems":1,"items":[{"id":"vol-99","volumeInfo":{"title":"The Dispossessed","authors":["Ursula K. Le Guin"],"publishedDate":"1974"}}]}`
	mu.Unlock()

	code, raw, parsed = env.doJSON(http.MethodPost, "/api/books/metadata-import/create", map[string]any{
		"query": "The Dispossessed",
	})
	if code != http.StatusOK || parsed["success"] != true {
		t.Fatalf("import with key = %d (%s), want 200", code, raw)
	}
	mu.Lock()
	gotQuery = lastQuery
	mu.Unlock()
	if gotQuery.Get("key") != secretKey || gotQuery.Get("maxResults") != "1" {
		t.Fatalf("unexpected query params on import with key: %v", gotQuery)
	}

	// 3. Google Books HTTP 429 RESOURCE_EXHAUSTED -> returns HTTP 429, no secret leak.
	mu.Lock()
	nextStatus = http.StatusTooManyRequests
	nextBody = `{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}`
	mu.Unlock()
	env.logs.Reset()

	code, raw, parsed = env.doJSON(http.MethodPost, "/api/books/metadata-import/create", map[string]any{
		"query": "Earthsea",
	})
	if code != http.StatusTooManyRequests {
		t.Fatalf("import on 429 = %d (%s), want 429", code, raw)
	}
	if strings.Contains(raw, secretKey) || strings.Contains(env.logs.String(), secretKey) {
		t.Fatalf("import 429 leaked API key")
	}
	msg, _ := parsed["message"].(string)
	if !strings.Contains(msg, "quota exceeded") || !strings.Contains(msg, "Hardcover") {
		t.Fatalf("expected actionable quota error on import, got %q", msg)
	}
}
