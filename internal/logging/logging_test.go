package logging_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lancewilhelm/delb/internal/logging"
)

func TestMultiSinkFanOutAndRedaction(t *testing.T) {
	var stdout bytes.Buffer
	logDir := filepath.Join(t.TempDir(), "logs")

	mgr, err := logging.NewManager(logging.Options{
		Level:  slog.LevelDebug,
		Format: logging.FormatJSON,
		Stdout: &stdout,
		Dir:    logDir,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	ctx := logging.WithRequestID(context.Background(), "req-abc-123")
	authLogger := mgr.Logger().With("component", "auth")
	authLogger.InfoContext(ctx, "login attempt with Bearer supersecrettoken1234",
		"password", "hunter2",
		"better_auth_secret", "top-secret-key",
		"hardcoverToken", "hc-secret-value",
		"googleBooksApiKey", "AIzaSy-test-google-key-12345",
		"api_key", "gbooks-key-999",
		"authorization", "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
		"cookie", "delb.session_token=secret-session-cookie",
		"mcpHeader", "Bearer delb_mcp_11111111-1111-1111-1111-111111111111.abcdefghijklmnopqrstuvwxyz0123456789abcdefg",
		"nested", slog.GroupValue(
			slog.String("access_token", "nested-access-token"),
			slog.String("refresh_token", "nested-refresh-token"),
			slog.String("safe", "visible-value"),
		),
		"errDetail", errors.New("upstream failed with ?api_key=leakme123&page=2"),
	)

	// Verify stdout does not contain any secret values
	stdoutText := stdout.String()
	for _, secret := range []string{
		"hunter2",
		"top-secret-key",
		"hc-secret-value",
		"AIzaSy-test-google-key-12345",
		"gbooks-key-999",
		"eyJhbGciOiJIUzI1NiJ9",
		"secret-session-cookie",
		"supersecrettoken1234",
		"abcdefghijklmnopqrstuvwxyz0123456789abcdefg",
		"nested-access-token",
		"nested-refresh-token",
		"leakme123",
	} {
		if strings.Contains(stdoutText, secret) {
			t.Fatalf("stdout leaked secret %q in: %s", secret, stdoutText)
		}
	}
	if !strings.Contains(stdoutText, "visible-value") {
		t.Fatalf("stdout missing non-sensitive value: %s", stdoutText)
	}

	// Verify disk file and Query()
	diskRaw, err := os.ReadFile(filepath.Join(logDir, "delb.jsonl"))
	if err != nil {
		t.Fatalf("read delb.jsonl: %v", err)
	}
	for _, secret := range []string{"hunter2", "top-secret-key", "hc-secret-value", "nested-access-token", "leakme123"} {
		if strings.Contains(string(diskRaw), secret) {
			t.Fatalf("disk JSONL leaked secret %q", secret)
		}
	}

	res, err := mgr.Query(logging.QueryOptions{})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if res.Total != 1 || len(res.Entries) != 1 {
		t.Fatalf("expected 1 entry, got total=%d len=%d", res.Total, len(res.Entries))
	}
	e := res.Entries[0]
	if e.Component != "auth" {
		t.Fatalf("component = %q, want auth", e.Component)
	}
	if e.RequestID != "req-abc-123" {
		t.Fatalf("requestId = %q, want req-abc-123", e.RequestID)
	}
	if e.Attrs["password"] != logging.RedactedPlaceholder {
		t.Fatalf("password attr = %v, want %q", e.Attrs["password"], logging.RedactedPlaceholder)
	}
	nested, ok := e.Attrs["nested"].(map[string]any)
	if !ok {
		t.Fatalf("nested attr not a map: %#v", e.Attrs["nested"])
	}
	if nested["access_token"] != logging.RedactedPlaceholder || nested["safe"] != "visible-value" {
		t.Fatalf("unexpected nested attrs: %#v", nested)
	}
}

func TestRotationAndRetentionBounds(t *testing.T) {
	logDir := filepath.Join(t.TempDir(), "logs")
	var stdout bytes.Buffer

	mgr, err := logging.NewManager(logging.Options{
		Level:         slog.LevelInfo,
		Format:        logging.FormatText,
		Stdout:        &stdout,
		Dir:           logDir,
		MaxFileBytes:  400,
		MaxFiles:      3,
		MaxTotalBytes: 1200,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	logger := mgr.Logger().With("component", "rotator-test")
	for i := 0; i < 40; i++ {
		logger.Info("log line for rotation testing", "seq", i, "payload", strings.Repeat("x", 60))
	}

	info := mgr.StorageInfo()
	if !info.Enabled {
		t.Fatalf("expected disk storage enabled")
	}
	if info.FileCount > 3 {
		t.Fatalf("fileCount = %d, exceeds MaxFiles=3", info.FileCount)
	}
	if info.FileCount < 2 {
		t.Fatalf("expected rotation to create at least 2 files, got %d", info.FileCount)
	}
	if info.TotalBytes > 1200+400 {
		t.Fatalf("totalBytes = %d, unexpectedly large above MaxTotalBytes", info.TotalBytes)
	}

	res, err := mgr.Query(logging.QueryOptions{Order: "asc", Limit: 100})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Entries) == 0 {
		t.Fatalf("expected rotated entries to remain readable")
	}
	// Latest entry should be present
	last := res.Entries[len(res.Entries)-1]
	if seq, ok := last.Attrs["seq"].(float64); !ok || int(seq) != 39 {
		t.Fatalf("expected last seq=39, got %#v", last.Attrs["seq"])
	}
}

func TestDynamicLevelAndFilteringAndExport(t *testing.T) {
	var stdout bytes.Buffer
	// Memory-only (simulating :memory: DB)
	mgr, err := logging.NewManager(logging.Options{
		Level:          slog.LevelInfo,
		Format:         logging.FormatText,
		Stdout:         &stdout,
		Dir:            "",
		MemoryCapacity: 100,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	if mgr.StorageInfo().Enabled {
		t.Fatalf("expected disk persistence disabled when Dir is empty")
	}

	authLog := mgr.Logger().With("component", "auth")
	booksLog := mgr.Logger().With("component", "books")

	authLog.Debug("ignored debug message")
	authLog.Info("user signed in", "userId", "u1")
	booksLog.Warn("metadata lookup slow", "bookId", "b42")
	booksLog.Error("cover decode failed", "bookId", "b42", "requestId", "req-err-1")

	// Enable debug dynamically
	if _, err := mgr.SetLevelString("debug"); err != nil {
		t.Fatalf("SetLevelString(debug): %v", err)
	}
	if mgr.LevelString() != "debug" {
		t.Fatalf("LevelString = %q, want debug", mgr.LevelString())
	}
	authLog.Debug("now visible debug message")

	// Query all
	all, err := mgr.Query(logging.QueryOptions{})
	if err != nil {
		t.Fatalf("Query all: %v", err)
	}
	if all.Total != 4 {
		t.Fatalf("total = %d, want 4", all.Total)
	}
	if len(all.Components) != 2 || all.Components[0] != "auth" || all.Components[1] != "books" {
		t.Fatalf("components = %v, want [auth books]", all.Components)
	}
	// Newest first by default
	if all.Entries[0].Message != "now visible debug message" {
		t.Fatalf("first entry = %q, want newest debug message", all.Entries[0].Message)
	}

	// Exact level filter
	warns, err := mgr.Query(logging.QueryOptions{Level: "warn"})
	if err != nil {
		t.Fatalf("Query warn: %v", err)
	}
	if warns.Total != 1 || warns.Entries[0].Message != "metadata lookup slow" {
		t.Fatalf("unexpected warn results: %+v", warns)
	}

	// MinLevel filter
	warnPlus, err := mgr.Query(logging.QueryOptions{MinLevel: "warn"})
	if err != nil {
		t.Fatalf("Query minLevel=warn: %v", err)
	}
	if warnPlus.Total != 2 {
		t.Fatalf("warnPlus total = %d, want 2", warnPlus.Total)
	}

	// Substring search across attrs
	byAttr, err := mgr.Query(logging.QueryOptions{Query: "B42"})
	if err != nil {
		t.Fatalf("Query q=B42: %v", err)
	}
	if byAttr.Total != 2 {
		t.Fatalf("q=B42 total = %d, want 2", byAttr.Total)
	}

	// Pagination
	page1, err := mgr.Query(logging.QueryOptions{Limit: 2, Offset: 0})
	if err != nil {
		t.Fatalf("Query page1: %v", err)
	}
	if len(page1.Entries) != 2 || !page1.HasMore {
		t.Fatalf("page1 len=%d hasMore=%v", len(page1.Entries), page1.HasMore)
	}

	// Export JSONL filtered
	var jsonlBuf bytes.Buffer
	if err := mgr.Export(&jsonlBuf, logging.ExportFormatJSONL, logging.QueryOptions{Component: "books"}, logging.ExportScopeFiltered); err != nil {
		t.Fatalf("Export jsonl: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(jsonlBuf.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 JSONL lines, got %d: %s", len(lines), jsonlBuf.String())
	}
	var parsed logging.Entry
	if err := json.Unmarshal([]byte(lines[0]), &parsed); err != nil {
		t.Fatalf("invalid exported JSONL: %v", err)
	}
	if parsed.Component != "books" {
		t.Fatalf("exported component = %q, want books", parsed.Component)
	}

	// Export plain text all
	var textBuf bytes.Buffer
	if err := mgr.Export(&textBuf, logging.ExportFormatText, logging.QueryOptions{}, logging.ExportScopeAll); err != nil {
		t.Fatalf("Export text: %v", err)
	}
	textOut := textBuf.String()
	if !strings.Contains(textOut, "[books]") || !strings.Contains(textOut, "[req:req-err-1]") || !strings.Contains(textOut, "bookId=b42") {
		t.Fatalf("unexpected text export:\n%s", textOut)
	}
}

func TestConcurrentLoggingSafety(t *testing.T) {
	logDir := filepath.Join(t.TempDir(), "logs")
	var stdout bytes.Buffer
	mgr, err := logging.NewManager(logging.Options{
		Level:        slog.LevelInfo,
		Format:       logging.FormatText,
		Stdout:       &stdout,
		Dir:          logDir,
		MaxFileBytes: 2048,
		MaxFiles:     5,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			l := mgr.Logger().With("component", fmt.Sprintf("worker-%d", id))
			for i := 0; i < 25; i++ {
				l.Info("concurrent message", "worker", id, "iter", i)
				if i%10 == 0 {
					_, _ = mgr.Query(logging.QueryOptions{Limit: 10})
				}
			}
		}(g)
	}
	wg.Wait()

	res, err := mgr.Query(logging.QueryOptions{Limit: 500})
	if err != nil {
		t.Fatalf("Query after concurrent writes: %v", err)
	}
	if res.Total == 0 {
		t.Fatalf("expected entries after concurrent logging")
	}
}

func TestSanitizeQuery(t *testing.T) {
	got := logging.SanitizeQuery("q=dune&token=secret123&api_key=abc&page=2&auth=xyz")
	if strings.Contains(got, "secret123") || strings.Contains(got, "abc") || strings.Contains(got, "xyz") {
		t.Fatalf("SanitizeQuery leaked sensitive values: %s", got)
	}
	if !strings.Contains(got, "q=dune") || !strings.Contains(got, "page=2") {
		t.Fatalf("SanitizeQuery dropped safe params: %s", got)
	}
}

func TestTimeRangeQuery(t *testing.T) {
	var stdout bytes.Buffer
	mgr, err := logging.NewManager(logging.Options{
		Level:  slog.LevelInfo,
		Stdout: &stdout,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	before := time.Now().UTC().Add(-time.Second)
	mgr.Logger().Info("within window")
	after := time.Now().UTC().Add(time.Second)

	res, err := mgr.Query(logging.QueryOptions{Since: before, Until: after})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if res.Total != 1 {
		t.Fatalf("expected 1 entry in window, got %d", res.Total)
	}

	empty, err := mgr.Query(logging.QueryOptions{Since: after})
	if err != nil {
		t.Fatalf("Query future: %v", err)
	}
	if empty.Total != 0 {
		t.Fatalf("expected 0 entries after window, got %d", empty.Total)
	}
}
