package settings_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/settings"
)

type settingsTestEnv struct {
	t      *testing.T
	opened *db.OpenResult
	server *httptest.Server
}

func newSettingsTestEnv(t *testing.T) *settingsTestEnv {
	t.Helper()
	ctx := context.Background()
	opened, err := db.Open(ctx, "file:"+filepath.Join(t.TempDir(), "settings.db"))
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
		Secret:    "settings-test-secret-0123456789abcdef0123456789",
		Logger:    discard,
		RateLimit: auth.RateLimitConfig{Disabled: true},
	})
	settingsSvc := settings.NewService(settings.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      discard,
	})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{settingsSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &settingsTestEnv{t: t, opened: opened, server: srv}
}

func (e *settingsTestEnv) req(method, path, cookie string, body any, extraHeaders map[string]string) (int, map[string]any, http.Header) {
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
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("do %s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp.StatusCode, out, resp.Header
}

func (e *settingsTestEnv) signup(name, email string) string {
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
		e.t.Fatalf("signup: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("signup %s = %d", email, resp.StatusCode)
	}
	var pairs []string
	for _, c := range resp.Cookies() {
		pairs = append(pairs, c.Name+"="+c.Value)
	}
	return strings.Join(pairs, "; ")
}

func TestUserSettingsMillisecondOptimisticConcurrency(t *testing.T) {
	env := newSettingsTestEnv(t)
	ownerCookie := env.signup("Owner", "owner@example.invalid")

	// Unauthenticated GET/PUT -> 401
	code, _, _ := env.req(http.MethodGet, "/api/settings", "", nil, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unauth GET /api/settings = %d, want 401", code)
	}
	code, _, _ = env.req(http.MethodPut, "/api/settings/user", "", map[string]any{"settings": map[string]any{}}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unauth PUT /api/settings/user = %d, want 401", code)
	}

	// Missing settings -> 400
	code, _, _ = env.req(http.MethodPut, "/api/settings/user", ownerCookie, map[string]any{}, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("missing settings = %d, want 400", code)
	}

	base := int64(1700000001000)

	// 1. Write at base+2 -> accepted=true
	code, body, _ := env.req(http.MethodPut, "/api/settings/user", ownerCookie, map[string]any{
		"settings":  map[string]any{"fontFamily": "Inter"},
		"updatedAt": base + 2,
	}, nil)
	if code != http.StatusOK || body["accepted"] != true {
		t.Fatalf("write base+2 = (%d, %v)", code, body)
	}

	// 2. Older write at base+1 -> accepted=false, returns stored data with ms precision
	code, body, _ = env.req(http.MethodPut, "/api/settings/user", ownerCookie, map[string]any{
		"settings":  map[string]any{"fontFamily": "Nunito"},
		"updatedAt": base + 1,
	}, nil)
	if code != http.StatusOK || body["accepted"] != false {
		t.Fatalf("stale write base+1 = (%d, %v), want accepted=false", code, body)
	}
	data := body["data"].(map[string]any)
	if data["settings"].(map[string]any)["fontFamily"] != "Inter" {
		t.Fatalf("stored settings = %v, want Inter", data["settings"])
	}
	parsedTime, err := time.Parse(time.RFC3339Nano, data["updatedAt"].(string))
	if err != nil || parsedTime.UnixMilli() != base+2 {
		t.Fatalf("stored updatedAt = %v (%v), want %d", data["updatedAt"], err, base+2)
	}

	// 3. Same millisecond with different payload -> accepted=false
	code, body, _ = env.req(http.MethodPut, "/api/settings/user", ownerCookie, map[string]any{
		"settings":  map[string]any{"fontFamily": "Poppins"},
		"updatedAt": base + 2,
	}, nil)
	if code != http.StatusOK || body["accepted"] != false {
		t.Fatalf("same-ms different payload = (%d, %v), want accepted=false", code, body)
	}

	// 4. Same millisecond with identical payload -> accepted=true
	code, body, _ = env.req(http.MethodPut, "/api/settings/user", ownerCookie, map[string]any{
		"settings":  map[string]any{"fontFamily": "Inter"},
		"updatedAt": base + 2,
	}, nil)
	if code != http.StatusOK || body["accepted"] != true {
		t.Fatalf("same-ms identical payload = (%d, %v), want accepted=true", code, body)
	}

	// 5. GET /api/settings returns saved userSettings
	code, body, _ = env.req(http.MethodGet, "/api/settings", ownerCookie, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("GET /api/settings = %d %v", code, body)
	}
	getData := body["data"].(map[string]any)
	if getData["userSettings"].(map[string]any)["settings"].(map[string]any)["fontFamily"] != "Inter" {
		t.Fatalf("GET userSettings = %v", getData["userSettings"])
	}

	// 6. Legacy 16-digit extended-year timestamps (e.g. post-0005 rows > year 9999)
	// must serialize as ECMA-262 "+YYYYYY-..." and parse back cleanly on PUT.
	const extendedMs int64 = 1793841889762374
	const wantExtendedISO = "+058814-08-02T21:49:22.374Z"
	const nextExtendedISO = "+058814-08-02T21:49:22.375Z"
	if _, err := env.opened.DB.ExecContext(context.Background(), `UPDATE user_settings SET updated_at = ?`, extendedMs); err != nil {
		t.Fatalf("seed extended updated_at: %v", err)
	}
	code, body, _ = env.req(http.MethodGet, "/api/settings", ownerCookie, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("GET extended /api/settings = %d", code)
	}
	gotISO := body["data"].(map[string]any)["userSettings"].(map[string]any)["updatedAt"].(string)
	if gotISO != wantExtendedISO {
		t.Fatalf("extended updatedAt = %q, want %q", gotISO, wantExtendedISO)
	}
	code, body, _ = env.req(http.MethodPut, "/api/settings/user", ownerCookie, map[string]any{
		"settings":  map[string]any{"fontFamily": "Geist"},
		"updatedAt": nextExtendedISO,
	}, nil)
	if code != http.StatusOK || body["accepted"] != true {
		t.Fatalf("PUT extended updatedAt = (%d, %v), want accepted=true", code, body)
	}
	if got := body["data"].(map[string]any)["updatedAt"].(string); got != nextExtendedISO {
		t.Fatalf("saved extended updatedAt = %q, want %q", got, nextExtendedISO)
	}
}

func TestGlobalSettingsHardcoverAndSpinePrompt(t *testing.T) {
	env := newSettingsTestEnv(t)
	ownerCookie := env.signup("Owner", "owner@example.invalid")
	userCookie := env.signup("Reader", "reader@example.invalid")

	// Non-admin cannot update global settings or hardcover token -> 403
	code, _, _ := env.req(http.MethodPut, "/api/settings/global", userCookie, map[string]any{
		"settings": map[string]any{"allowRegistration": false},
	}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("non-admin PUT global = %d, want 403", code)
	}
	code, _, _ = env.req(http.MethodPut, "/api/settings/admin/hardcover-token", userCookie, map[string]any{
		"token": "secret-tok",
	}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("non-admin PUT hardcover-token = %d, want 403", code)
	}

	// Admin updates global settings (including dropbox config)
	code, body, _ := env.req(http.MethodPut, "/api/settings/global", ownerCookie, map[string]any{
		"settings": map[string]any{
			"allowRegistration": false,
			"dropbox":           map[string]any{"enabled": true, "pollIntervalMs": 500},
		},
	}, nil)
	if code != http.StatusOK || body["success"] != true {
		t.Fatalf("admin PUT global = (%d, %v)", code, body)
	}

	// Admin sets Hardcover token with Bearer prefix -> normalized, capabilities=true
	code, body, _ = env.req(http.MethodPut, "/api/settings/admin/hardcover-token", ownerCookie, map[string]any{
		"token": "Bearer hc_test_token_123",
	}, nil)
	if code != http.StatusOK || body["data"].(map[string]any)["cleared"] != false {
		t.Fatalf("set hardcover token = (%d, %v)", code, body)
	}

	code, body, _ = env.req(http.MethodGet, "/api/settings", userCookie, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("GET /api/settings = %d", code)
	}
	getData := body["data"].(map[string]any)
	if getData["capabilities"].(map[string]any)["hardcoverAvailable"] != true {
		t.Fatalf("expected hardcoverAvailable=true, got %v", getData["capabilities"])
	}
	gs := getData["globalSettings"].(map[string]any)
	if gs["id"] != settings.GlobalSettingsID {
		t.Fatalf("globalSettings.id = %v", gs["id"])
	}
	if gs["settings"].(map[string]any)["allowRegistration"] != false {
		t.Fatalf("globalSettings.settings = %v", gs["settings"])
	}

	// Clear Hardcover token -> cleared=true, hardcoverAvailable=false
	code, body, _ = env.req(http.MethodPut, "/api/settings/admin/hardcover-token", ownerCookie, map[string]any{
		"token": "   ",
	}, nil)
	if code != http.StatusOK || body["data"].(map[string]any)["cleared"] != true {
		t.Fatalf("clear hardcover token = (%d, %v)", code, body)
	}
	code, body, _ = env.req(http.MethodGet, "/api/settings", ownerCookie, nil, nil)
	if code != http.StatusOK || body["data"].(map[string]any)["capabilities"].(map[string]any)["hardcoverAvailable"] != false {
		t.Fatalf("expected hardcoverAvailable=false after clear, got %v", body)
	}

	// Spine prompt endpoint: auth, RBAC, Sec-Fetch-Site, method check, validation, CAS conflict
	code, _, _ = env.req(http.MethodGet, "/api/settings/admin/spine-prompt", "", nil, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unauth spine-prompt = %d, want 401", code)
	}
	code, _, _ = env.req(http.MethodGet, "/api/settings/admin/spine-prompt", userCookie, nil, nil)
	if code != http.StatusForbidden {
		t.Fatalf("non-admin spine-prompt = %d, want 403", code)
	}
	code, _, _ = env.req(http.MethodPut, "/api/settings/admin/spine-prompt", ownerCookie, map[string]any{
		"prompt": "x", "previous": nil,
	}, map[string]string{"Sec-Fetch-Site": "cross-site"})
	if code != http.StatusForbidden {
		t.Fatalf("cross-site spine-prompt PUT = %d, want 403", code)
	}
	code, _, _ = env.req(http.MethodDelete, "/api/settings/admin/spine-prompt", ownerCookie, nil, nil)
	if code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE spine-prompt = %d, want 405", code)
	}

	code, promptBody, hdrs := env.req(http.MethodGet, "/api/settings/admin/spine-prompt", ownerCookie, nil, nil)
	if code != http.StatusOK || promptBody["savedPrompt"] != nil || promptBody["prompt"] != promptBody["defaultPrompt"] {
		t.Fatalf("initial GET spine-prompt = (%d, %v)", code, promptBody)
	}
	if hdrs.Get("Cache-Control") != "private, no-store" || hdrs.Get("Vary") != "Cookie" {
		t.Fatalf("unexpected spine-prompt headers: Cache-Control=%q Vary=%q", hdrs.Get("Cache-Control"), hdrs.Get("Vary"))
	}

	// Missing placeholders -> 400
	code, _, _ = env.req(http.MethodPut, "/api/settings/admin/spine-prompt", ownerCookie, map[string]any{
		"prompt":   "missing placeholders",
		"previous": nil,
	}, nil)
	if code != http.StatusBadRequest {
		t.Fatalf("invalid spine-prompt = %d, want 400", code)
	}

	// Valid initial save -> 200
	defaultPrompt := promptBody["defaultPrompt"].(string)
	custom := defaultPrompt + "\nGold foil."
	code, saved, _ := env.req(http.MethodPut, "/api/settings/admin/spine-prompt", ownerCookie, map[string]any{
		"prompt":   custom,
		"previous": nil,
	}, nil)
	if code != http.StatusOK || saved["savedPrompt"] != custom {
		t.Fatalf("save spine-prompt = (%d, %v)", code, saved)
	}

	// Stale previous=nil -> 409
	code, _, _ = env.req(http.MethodPut, "/api/settings/admin/spine-prompt", ownerCookie, map[string]any{
		"prompt":   defaultPrompt,
		"previous": nil,
	}, nil)
	if code != http.StatusConflict {
		t.Fatalf("stale spine-prompt save = %d, want 409", code)
	}

	// Matching previous -> 200
	code, restored, _ := env.req(http.MethodPut, "/api/settings/admin/spine-prompt", ownerCookie, map[string]any{
		"prompt":   defaultPrompt,
		"previous": custom,
	}, nil)
	if code != http.StatusOK || restored["prompt"] != defaultPrompt {
		t.Fatalf("restore spine-prompt = (%d, %v)", code, restored)
	}
}

func TestGoogleBooksAPIKeySettings(t *testing.T) {
	env := newSettingsTestEnv(t)
	ownerCookie := env.signup("Owner", "owner@example.invalid")
	userCookie := env.signup("Reader", "reader@example.invalid")

	const rawSecret = "AIzaSy-Test-Google-Books-Secret-987654321"

	// Unauthenticated -> 401
	code, _, _ := env.req(http.MethodPut, "/api/settings/admin/google-books-api-key", "", map[string]any{
		"apiKey": rawSecret,
	}, nil)
	if code != http.StatusUnauthorized {
		t.Fatalf("unauth PUT google-books-api-key = %d, want 401", code)
	}

	// Non-admin -> 403
	code, _, _ = env.req(http.MethodPut, "/api/settings/admin/google-books-api-key", userCookie, map[string]any{
		"apiKey": rawSecret,
	}, nil)
	if code != http.StatusForbidden {
		t.Fatalf("non-admin PUT google-books-api-key = %d, want 403", code)
	}

	// Invalid payloads -> 400
	for _, payload := range []map[string]any{
		{},
		{"apiKey": nil},
		{"apiKey": 12345},
	} {
		code, _, _ = env.req(http.MethodPut, "/api/settings/admin/google-books-api-key", ownerCookie, payload, nil)
		if code != http.StatusBadRequest {
			t.Fatalf("invalid PUT google-books-api-key (%v) = %d, want 400", payload, code)
		}
	}

	// Initially not configured
	code, body, _ := env.req(http.MethodGet, "/api/settings", ownerCookie, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("initial GET /api/settings = %d", code)
	}
	caps := body["data"].(map[string]any)["capabilities"].(map[string]any)
	if caps["googleBooksApiKeyConfigured"] != false {
		t.Fatalf("expected googleBooksApiKeyConfigured=false initially, got %v", caps)
	}

	// Admin saves key with surrounding whitespace -> trimmed, cleared=false, secret never returned
	code, body, _ = env.req(http.MethodPut, "/api/settings/admin/google-books-api-key", ownerCookie, map[string]any{
		"apiKey": "  " + rawSecret + "  ",
	}, nil)
	if code != http.StatusOK || body["success"] != true || body["data"].(map[string]any)["cleared"] != false {
		t.Fatalf("save google-books-api-key = (%d, %v)", code, body)
	}
	putBytes, _ := json.Marshal(body)
	if strings.Contains(string(putBytes), rawSecret) {
		t.Fatalf("PUT response leaked raw API key: %s", string(putBytes))
	}

	// Verify DB stores trimmed key under expected ID
	var stored string
	if err := env.opened.DB.QueryRowContext(context.Background(), `SELECT value FROM global_secrets WHERE id = ?`, settings.GoogleBooksSecretID).Scan(&stored); err != nil {
		t.Fatalf("query stored secret: %v", err)
	}
	if stored != rawSecret {
		t.Fatalf("stored secret = %q, want %q", stored, rawSecret)
	}

	// GET /api/settings exposes only capability boolean for both admin and non-admin, never the raw key
	for _, cookie := range []string{ownerCookie, userCookie} {
		code, body, _ = env.req(http.MethodGet, "/api/settings", cookie, nil, nil)
		if code != http.StatusOK {
			t.Fatalf("GET /api/settings = %d", code)
		}
		getBytes, _ := json.Marshal(body)
		if strings.Contains(string(getBytes), rawSecret) {
			t.Fatalf("GET /api/settings leaked raw API key: %s", string(getBytes))
		}
		caps = body["data"].(map[string]any)["capabilities"].(map[string]any)
		if caps["googleBooksApiKeyConfigured"] != true {
			t.Fatalf("expected googleBooksApiKeyConfigured=true, got %v", caps)
		}
	}

	// Clear key with whitespace -> cleared=true, row removed, capability=false
	code, body, _ = env.req(http.MethodPut, "/api/settings/admin/google-books-api-key", ownerCookie, map[string]any{
		"apiKey": "   ",
	}, nil)
	if code != http.StatusOK || body["success"] != true || body["data"].(map[string]any)["cleared"] != true {
		t.Fatalf("clear google-books-api-key = (%d, %v)", code, body)
	}

	var count int
	if err := env.opened.DB.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM global_secrets WHERE id = ?`, settings.GoogleBooksSecretID).Scan(&count); err != nil {
		t.Fatalf("count secret rows: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected secret row to be deleted on clear, got count=%d", count)
	}

	code, body, _ = env.req(http.MethodGet, "/api/settings", ownerCookie, nil, nil)
	if code != http.StatusOK {
		t.Fatalf("GET /api/settings after clear = %d", code)
	}
	caps = body["data"].(map[string]any)["capabilities"].(map[string]any)
	if caps["googleBooksApiKeyConfigured"] != false {
		t.Fatalf("expected googleBooksApiKeyConfigured=false after clear, got %v", caps)
	}
}
