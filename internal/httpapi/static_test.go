package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestSPAHandler(t *testing.T) {
	webFS := fstest.MapFS{
		".gitkeep":             {Data: []byte{}},
		"index.html":           {Data: []byte("<!doctype html><html><body>Delb SPA</body></html>")},
		"favicon.svg":          {Data: []byte("<svg></svg>")},
		"manifest.webmanifest": {Data: []byte(`{"name":"Delb"}`)},
		"assets/app-1234.js":   {Data: []byte("console.log('delb');")},
		"css/themes/nord.css":  {Data: []byte(":root{--bg-color:#2e3440;}")},
		"pdfjs/wasm/test.wasm": {Data: []byte{0x00, 0x61, 0x73, 0x6d}},
	}

	h := NewHandler(RouterOptions{WebFS: webFS})

	t.Run("root serves index.html with no-cache", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("Cache-Control = %q, want no-cache", got)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
			t.Fatalf("Content-Type = %q, want text/html", ct)
		}
		if !strings.Contains(rec.Body.String(), "Delb SPA") {
			t.Fatalf("unexpected body %q", rec.Body.String())
		}
	})

	t.Run("client-side routes fall back to index.html", func(t *testing.T) {
		for _, p := range []string{"/books", "/books/abc-123/read", "/settings/admin/library", "/login"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("path %s: status = %d, want 200", p, rec.Code)
			}
			if !strings.Contains(rec.Body.String(), "Delb SPA") {
				t.Fatalf("path %s: expected SPA index.html", p)
			}
		}
	})

	t.Run("hashed assets get immutable cache and JS mime", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/assets/app-1234.js", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", rec.Code)
		}
		if got := rec.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
			t.Fatalf("Cache-Control = %q", got)
		}
		if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "javascript") {
			t.Fatalf("Content-Type = %q", ct)
		}
	})

	t.Run("static assets serve with accurate MIME types", func(t *testing.T) {
		cases := []struct {
			path string
			mime string
		}{
			{"/favicon.svg", "image/svg+xml"},
			{"/manifest.webmanifest", "application/manifest+json"},
			{"/css/themes/nord.css", "text/css"},
			{"/pdfjs/wasm/test.wasm", "application/wasm"},
		}
		for _, tc := range cases {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			if rec.Code != http.StatusOK {
				t.Fatalf("%s: status = %d", tc.path, rec.Code)
			}
			if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, tc.mime) {
				t.Fatalf("%s: Content-Type = %q, want %q", tc.path, ct, tc.mime)
			}
		}
	})

	t.Run("missing static assets and hidden files return 404", func(t *testing.T) {
		for _, p := range []string{"/assets/missing.js", "/pdfjs/wasm/missing.wasm", "/css/themes/missing.css", "/missing.png", "/.gitkeep"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, p, nil))
			if rec.Code != http.StatusNotFound {
				t.Fatalf("path %s: status = %d, want 404", p, rec.Code)
			}
		}
	})

	t.Run("unknown api routes still return JSON 404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/does-not-exist", nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("status = %d, want 404", rec.Code)
		}
		var payload map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("expected JSON error body, got %q: %v", rec.Body.String(), err)
		}
		if payload["message"] != "Not Found" {
			t.Fatalf("message = %q", payload["message"])
		}
	})

	t.Run("unbuilt placeholder returns 503", func(t *testing.T) {
		empty := NewHandler(RouterOptions{WebFS: fstest.MapFS{".gitkeep": {Data: []byte{}}}})
		rec := httptest.NewRecorder()
		empty.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("status = %d, want 503", rec.Code)
		}
	})
}
