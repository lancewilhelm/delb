package httpapi

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGzipMiddlewareCompressesTextAndJSON(t *testing.T) {
	payload := strings.Repeat(`{"title":"Dune","author":"Frank Herbert"}`, 40)
	h := GzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Vary", "Cookie")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(payload))
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/books", nil)
	req.Header.Set("Accept-Encoding", "gzip, deflate, br")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	resp := rec.Result()
	defer resp.Body.Close()

	if resp.Header.Get("Content-Encoding") != "gzip" {
		t.Fatalf("expected Content-Encoding=gzip, got %q", resp.Header.Get("Content-Encoding"))
	}
	// Existing Vary: Cookie stays first while Accept-Encoding is appended.
	if resp.Header.Get("Vary") != "Cookie" {
		t.Fatalf("expected first Vary header to remain Cookie, got %q (all=%v)", resp.Header.Get("Vary"), resp.Header.Values("Vary"))
	}
	varyJoined := strings.Join(resp.Header.Values("Vary"), ", ")
	if !strings.Contains(varyJoined, "Accept-Encoding") {
		t.Fatalf("expected Vary to include Accept-Encoding, got %v", resp.Header.Values("Vary"))
	}
	if rec.Body.Len() >= len(payload) {
		t.Fatalf("expected compressed body smaller than %d bytes, got %d", len(payload), rec.Body.Len())
	}

	gzr, err := gzip.NewReader(resp.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer gzr.Close()
	decoded, err := io.ReadAll(gzr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if string(decoded) != payload {
		t.Fatalf("decoded mismatch: len=%d want=%d", len(decoded), len(payload))
	}
}

func TestGzipMiddlewareSkipsNonCompressibleAndSpecialCases(t *testing.T) {
	cases := []struct {
		name        string
		method      string
		headers     map[string]string
		status      int
		contentType string
		contentEnc  string
		body        string
	}{
		{
			name:        "webp image",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusOK,
			contentType: "image/webp",
			body:        strings.Repeat("RIFF", 30),
		},
		{
			name:        "epub binary",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusOK,
			contentType: "application/epub+zip",
			body:        strings.Repeat("PK\x03\x04", 30),
		},
		{
			name:        "server-sent events",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusOK,
			contentType: "text/event-stream",
			body:        "data: hello\n\n",
		},
		{
			name:        "no gzip accepted",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "identity"},
			status:      http.StatusOK,
			contentType: "application/json",
			body:        `{"ok":true}`,
		},
		{
			name:        "gzip q=0 rejected",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip;q=0, identity"},
			status:      http.StatusOK,
			contentType: "application/json",
			body:        `{"ok":true}`,
		},
		{
			name:        "HEAD request",
			method:      http.MethodHead,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusOK,
			contentType: "text/html",
			body:        "",
		},
		{
			name:        "Range request",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip", "Range": "bytes=0-10"},
			status:      http.StatusPartialContent,
			contentType: "text/plain",
			body:        "hello world",
		},
		{
			name:        "Upgrade request",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip", "Upgrade": "websocket"},
			status:      http.StatusOK,
			contentType: "text/plain",
			body:        "ws",
		},
		{
			name:        "204 No Content",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusNoContent,
			contentType: "application/json",
			body:        "",
		},
		{
			name:        "304 Not Modified",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusNotModified,
			contentType: "text/javascript",
			body:        "",
		},
		{
			name:        "already encoded",
			method:      http.MethodGet,
			headers:     map[string]string{"Accept-Encoding": "gzip"},
			status:      http.StatusOK,
			contentType: "text/javascript",
			contentEnc:  "br",
			body:        "already-compressed",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := GzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tc.contentType != "" {
					w.Header().Set("Content-Type", tc.contentType)
				}
				if tc.contentEnc != "" {
					w.Header().Set("Content-Encoding", tc.contentEnc)
				}
				w.WriteHeader(tc.status)
				if tc.body != "" {
					_, _ = w.Write([]byte(tc.body))
				}
			}))

			req := httptest.NewRequest(tc.method, "/test", nil)
			for k, v := range tc.headers {
				req.Header.Set(k, v)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			wantEnc := tc.contentEnc
			if got := rec.Header().Get("Content-Encoding"); got != wantEnc {
				t.Fatalf("Content-Encoding = %q, want %q", got, wantEnc)
			}
			if rec.Body.String() != tc.body {
				t.Fatalf("body = %q, want %q", rec.Body.String(), tc.body)
			}
		})
	}
}
