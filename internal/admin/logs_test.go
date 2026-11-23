package admin_test

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
	"github.com/lancewilhelm/delb/internal/admin"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/logging"
)

func newLogsTestEnv(t *testing.T) (*testEnv, *logging.Manager) {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	logDir := filepath.Join(tmp, "logs")
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

	var stdout bytes.Buffer
	logMgr, err := logging.NewManager(logging.Options{
		Level:  slog.LevelInfo,
		Format: logging.FormatText,
		Stdout: &stdout,
		Dir:    logDir,
	})
	if err != nil {
		t.Fatalf("logging.NewManager: %v", err)
	}
	t.Cleanup(func() { _ = logMgr.Close() })

	authSvc := auth.NewService(auth.ServiceOptions{
		DB:     opened.DB,
		Secret: "admin-logs-test-secret-0123456789abcdef0123",
		Logger: logMgr.Logger().With("component", "auth"),
	})
	adminSvc := admin.NewService(admin.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		LogManager:  logMgr,
		Logger:      logMgr.Logger().With("component", "admin"),
	})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      logMgr.Logger().With("component", "httpapi"),
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{adminSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &testEnv{
		t:          t,
		db:         opened.DB,
		srv:        srv,
		tmpDir:     tmp,
		libraryDir: libDir,
	}, logMgr
}

func TestAdminLogsAuthQueryLevelAndDownload(t *testing.T) {
	env, logMgr := newLogsTestEnv(t)
	owner := env.signUp("Owner", "owner@example.invalid")
	member := env.signUp("Member", "member@example.invalid")

	// Seed logs including sensitive fields to confirm redaction end-to-end
	logMgr.Logger().With("component", "dropbox").Warn("dropbox test warning",
		"filename", "sample.epub",
		"password", "must-not-appear",
		"hardcover_token", "hc-secret-do-not-leak",
	)
	logMgr.Logger().With("component", "books").Error("book ingest error", "bookId", "book-99")

	// 1) Auth enforcement: 401 unauth, 403 non-admin
	for _, tc := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/settings/admin/logs", nil},
		{http.MethodPut, "/api/settings/admin/logs/level", map[string]string{"level": "debug"}},
		{http.MethodGet, "/api/settings/admin/logs/download", nil},
	} {
		if status, _ := env.doJSON(nil, tc.method, tc.path, tc.body); status != http.StatusUnauthorized {
			t.Fatalf("unauth %s %s = %d, want 401", tc.method, tc.path, status)
		}
		if status, _ := env.doJSON(&member, tc.method, tc.path, tc.body); status != http.StatusForbidden {
			t.Fatalf("member %s %s = %d, want 403", tc.method, tc.path, status)
		}
	}

	// 2) Query logs as owner with filters
	status, resp := env.doJSON(&owner, http.MethodGet, "/api/settings/admin/logs?component=dropbox&level=warn", nil)
	if status != http.StatusOK || resp["success"] != true {
		t.Fatalf("GET logs = %d %v", status, resp)
	}
	data := resp["data"].(map[string]any)
	entries := data["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("expected 1 dropbox warn entry, got %d (%v)", len(entries), entries)
	}
	first := entries[0].(map[string]any)
	attrs := first["attrs"].(map[string]any)
	if attrs["password"] != logging.RedactedPlaceholder || attrs["hardcover_token"] != logging.RedactedPlaceholder {
		t.Fatalf("sensitive attrs were not redacted: %#v", attrs)
	}
	if data["level"] != "info" {
		t.Fatalf("initial level = %v, want info", data["level"])
	}
	storage := data["storage"].(map[string]any)
	if storage["enabled"] != true || int(storage["fileCount"].(float64)) < 1 {
		t.Fatalf("unexpected storage summary: %#v", storage)
	}

	// 3) Invalid level rejected with 400
	if status, _ := env.doJSON(&owner, http.MethodPut, "/api/settings/admin/logs/level", map[string]string{"level": "verbose"}); status != http.StatusBadRequest {
		t.Fatalf("invalid level status = %d, want 400", status)
	}

	// 4) Update runtime level to debug and verify debug logs are captured
	status, lvlResp := env.doJSON(&owner, http.MethodPut, "/api/settings/admin/logs/level", map[string]string{"level": "debug"})
	if status != http.StatusOK || lvlResp["success"] != true {
		t.Fatalf("PUT level = %d %v", status, lvlResp)
	}
	lvlData := lvlResp["data"].(map[string]any)
	if lvlData["level"] != "debug" || lvlData["previousLevel"] != "info" {
		t.Fatalf("unexpected level update response: %#v", lvlData)
	}

	logMgr.Logger().With("component", "books").Debug("debug event after level change")
	status, dbgResp := env.doJSON(&owner, http.MethodGet, "/api/settings/admin/logs?level=debug&q=after+level+change", nil)
	if status != http.StatusOK {
		t.Fatalf("GET debug logs = %d", status)
	}
	dbgEntries := dbgResp["data"].(map[string]any)["entries"].([]any)
	if len(dbgEntries) != 1 {
		t.Fatalf("expected 1 debug entry after level switch, got %d", len(dbgEntries))
	}

	// 5) Download logs as text (all) and jsonl (filtered)
	dlReq, _ := http.NewRequest(http.MethodGet, env.srv.URL+"/api/settings/admin/logs/download?format=text&scope=all", nil)
	dlReq.Header.Set("Cookie", owner.Cookie)
	dlResp, err := http.DefaultClient.Do(dlReq)
	if err != nil {
		t.Fatalf("download text: %v", err)
	}
	dlBytes, _ := io.ReadAll(dlResp.Body)
	_ = dlResp.Body.Close()

	if dlResp.StatusCode != http.StatusOK {
		t.Fatalf("download text status = %d, want 200", dlResp.StatusCode)
	}
	cd := dlResp.Header.Get("Content-Disposition")
	if !strings.HasPrefix(cd, `attachment; filename="delb-logs-`) || !strings.HasSuffix(cd, `.log"`) {
		t.Fatalf("unexpected Content-Disposition: %q", cd)
	}
	if dlResp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("unexpected Cache-Control: %q", dlResp.Header.Get("Cache-Control"))
	}
	dlBody := string(dlBytes)
	if strings.Contains(dlBody, "must-not-appear") || strings.Contains(dlBody, "hc-secret-do-not-leak") {
		t.Fatalf("downloaded text log leaked secrets:\n%s", dlBody)
	}
	if !strings.Contains(dlBody, "dropbox test warning") || !strings.Contains(dlBody, "book ingest error") {
		t.Fatalf("downloaded text log missing expected entries:\n%s", dlBody)
	}

	// Filtered JSONL download
	dlJSONReq, _ := http.NewRequest(http.MethodGet, env.srv.URL+"/api/settings/admin/logs/download?format=jsonl&scope=filtered&component=books&level=error", nil)
	dlJSONReq.Header.Set("Cookie", owner.Cookie)
	dlJSONResp, err := http.DefaultClient.Do(dlJSONReq)
	if err != nil {
		t.Fatalf("download jsonl: %v", err)
	}
	dlJSONBytes, _ := io.ReadAll(dlJSONResp.Body)
	_ = dlJSONResp.Body.Close()

	if dlJSONResp.StatusCode != http.StatusOK {
		t.Fatalf("download jsonl status = %d, want 200", dlJSONResp.StatusCode)
	}
	if !strings.HasSuffix(dlJSONResp.Header.Get("Content-Disposition"), `.jsonl"`) {
		t.Fatalf("unexpected jsonl Content-Disposition: %q", dlJSONResp.Header.Get("Content-Disposition"))
	}
	jsonLines := strings.Split(strings.TrimSpace(string(dlJSONBytes)), "\n")
	if len(jsonLines) != 1 {
		t.Fatalf("expected 1 filtered jsonl line, got %d:\n%s", len(jsonLines), string(dlJSONBytes))
	}
	var entry logging.Entry
	if err := json.Unmarshal([]byte(jsonLines[0]), &entry); err != nil {
		t.Fatalf("invalid jsonl line: %v", err)
	}
	if entry.Component != "books" || entry.Level != "error" {
		t.Fatalf("unexpected filtered jsonl entry: %+v", entry)
	}
}
