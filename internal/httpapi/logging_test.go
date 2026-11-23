package httpapi_test

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/logging"
)

func TestRequestIDPropagationAndSanitization(t *testing.T) {
	var stdout bytes.Buffer
	mgr, err := logging.NewManager(logging.Options{
		Level:  slog.LevelDebug,
		Stdout: &stdout,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		httpapi.SetRequestUserID(r.Context(), "user-123")
		mgr.Logger().With("component", "ping").InfoContext(r.Context(), "handled ping")
		httpapi.WriteJSON(w, http.StatusOK, map[string]string{
			"requestId": httpapi.RequestIDFromContext(r.Context()),
		})
	})

	handler := httpapi.RequestIDMiddleware(
		httpapi.AccessLogMiddleware(mgr.Logger().With("component", "httpapi"))(mux),
	)

	// 1) Auto-generated request ID when header absent
	req := httptest.NewRequest(http.MethodGet, "/api/ping?token=secret-query-val&page=1", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	respReqID := rec.Header().Get(httpapi.RequestIDHeader)
	if respReqID == "" {
		t.Fatalf("expected generated X-Request-Id header")
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["requestId"] != respReqID {
		t.Fatalf("context requestId=%q != header %q", body["requestId"], respReqID)
	}

	// 2) Accepted valid inbound X-Request-Id
	req2 := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	req2.Header.Set(httpapi.RequestIDHeader, "client-trace_01.abc")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	if got := rec2.Header().Get(httpapi.RequestIDHeader); got != "client-trace_01.abc" {
		t.Fatalf("inbound X-Request-Id = %q, want client-trace_01.abc", got)
	}

	// 3) Malicious inbound X-Request-Id with CRLF/spaces is replaced
	req3 := httptest.NewRequest(http.MethodGet, "/api/ping", nil)
	req3.Header.Set(httpapi.RequestIDHeader, "bad\r\nid with spaces")
	rec3 := httptest.NewRecorder()
	handler.ServeHTTP(rec3, req3)
	if got := rec3.Header().Get(httpapi.RequestIDHeader); got == "" || strings.ContainsAny(got, "\r\n ") {
		t.Fatalf("expected sanitized replacement request ID, got %q", got)
	}

	// Verify logs contain correlated requestId, userId, and sanitized query (no secret)
	res, err := mgr.Query(logging.QueryOptions{Component: "httpapi", RequestID: respReqID})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if res.Total != 1 {
		t.Fatalf("expected 1 httpapi access log for %s, got %d", respReqID, res.Total)
	}
	entry := res.Entries[0]
	if entry.Attrs["userId"] != "user-123" {
		t.Fatalf("expected userId=user-123, got %v", entry.Attrs["userId"])
	}
	queryAttr, _ := entry.Attrs["query"].(string)
	if strings.Contains(queryAttr, "secret-query-val") {
		t.Fatalf("access log leaked query secret: %s", queryAttr)
	}
	if !strings.Contains(queryAttr, "page=1") {
		t.Fatalf("access log missing safe query param: %s", queryAttr)
	}
}

func TestAccessLogLevelsForAssetsAndStatusCodes(t *testing.T) {
	var stdout bytes.Buffer
	mgr, err := logging.NewManager(logging.Options{
		Level:  slog.LevelDebug,
		Stdout: &stdout,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /assets/app.js", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /api/settings/admin/logs", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /api/books", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /api/missing", func(w http.ResponseWriter, r *http.Request) {
		httpapi.WriteError(w, http.StatusNotFound, "Not Found")
	})
	mux.HandleFunc("GET /api/boom", func(w http.ResponseWriter, r *http.Request) {
		httpapi.WriteError(w, http.StatusInternalServerError, "Boom")
	})

	handler := httpapi.RequestIDMiddleware(
		httpapi.AccessLogMiddleware(mgr.Logger().With("component", "httpapi"))(mux),
	)

	cases := []struct {
		path      string
		wantLevel string
	}{
		{"/assets/app.js", "debug"},
		{"/api/settings/admin/logs", "debug"},
		{"/api/books", "info"},
		{"/api/missing", "warn"},
		{"/api/boom", "error"},
	}

	for _, tc := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, tc.path, nil)
		handler.ServeHTTP(rec, req)
	}

	res, err := mgr.Query(logging.QueryOptions{Component: "httpapi", Order: "asc"})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if len(res.Entries) != len(cases) {
		t.Fatalf("got %d entries, want %d", len(res.Entries), len(cases))
	}
	for i, tc := range cases {
		if res.Entries[i].Level != tc.wantLevel {
			t.Errorf("path %s logged at %q, want %q", tc.path, res.Entries[i].Level, tc.wantLevel)
		}
	}
}

func TestRecoveryMiddlewareLogsPanicAndReturns500(t *testing.T) {
	var stdout bytes.Buffer
	mgr, err := logging.NewManager(logging.Options{
		Level:  slog.LevelInfo,
		Stdout: &stdout,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	defer func() { _ = mgr.Close() }()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/panic", func(w http.ResponseWriter, r *http.Request) {
		panic("unexpected nil deref")
	})
	mux.HandleFunc("GET /page-panic", func(w http.ResponseWriter, r *http.Request) {
		panic("page crash")
	})

	httpLogger := mgr.Logger().With("component", "httpapi")
	handler := httpapi.RequestIDMiddleware(
		httpapi.AccessLogMiddleware(httpLogger)(
			httpapi.RecoveryMiddleware(httpLogger)(mux),
		),
	)

	// API route returns JSON 500
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/panic", nil)
	req.Header.Set(httpapi.RequestIDHeader, "panic-req-1")
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("API panic status = %d, want 500", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("API panic response not JSON: %v (%s)", err, rec.Body.String())
	}
	if payload["success"] != false || int(payload["statusCode"].(float64)) != 500 {
		t.Fatalf("unexpected API panic payload: %#v", payload)
	}

	// Non-API route returns plain 500
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/page-panic", nil)
	handler.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusInternalServerError {
		t.Fatalf("non-API panic status = %d, want 500", rec2.Code)
	}

	// Verify panic entry logged at ERROR with requestId and stack
	res, err := mgr.Query(logging.QueryOptions{Level: "error", RequestID: "panic-req-1", Query: "http panic recovered"})
	if err != nil {
		t.Fatalf("Query: %v", err)
	}
	if res.Total != 1 {
		t.Fatalf("expected 1 panic log entry, got %d", res.Total)
	}
	if stack, _ := res.Entries[0].Attrs["stack"].(string); !strings.Contains(stack, "TestRecoveryMiddlewareLogsPanicAndReturns500") {
		t.Fatalf("expected stack trace in panic log, got %q", stack)
	}
}
