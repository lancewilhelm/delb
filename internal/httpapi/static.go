package httpapi

import (
	"bytes"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"
)

func init() {
	// Register explicit MIME types so FROM scratch containers (which lack
	// /etc/mime.types) still serve accurate Content-Type headers for all SPA
	// assets, fonts, PDF.js resources, and manifests.
	for ext, typ := range map[string]string{
		".html":        "text/html; charset=utf-8",
		".js":          "text/javascript; charset=utf-8",
		".mjs":         "text/javascript; charset=utf-8",
		".css":         "text/css; charset=utf-8",
		".json":        "application/json; charset=utf-8",
		".svg":         "image/svg+xml",
		".png":         "image/png",
		".jpg":         "image/jpeg",
		".jpeg":        "image/jpeg",
		".webp":        "image/webp",
		".gif":         "image/gif",
		".ico":         "image/x-icon",
		".woff":        "font/woff",
		".woff2":       "font/woff2",
		".ttf":         "font/ttf",
		".otf":         "font/otf",
		".wasm":        "application/wasm",
		".webmanifest": "application/manifest+json",
		".bcmap":       "application/octet-stream",
		".pfb":         "application/octet-stream",
		".txt":         "text/plain; charset=utf-8",
		".xml":         "application/xml; charset=utf-8",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}
}

var staticAssetExtensions = map[string]bool{
	".js":          true,
	".mjs":         true,
	".css":         true,
	".map":         true,
	".json":        true,
	".svg":         true,
	".png":         true,
	".jpg":         true,
	".jpeg":        true,
	".webp":        true,
	".gif":         true,
	".ico":         true,
	".woff":        true,
	".woff2":       true,
	".ttf":         true,
	".otf":         true,
	".wasm":        true,
	".webmanifest": true,
	".bcmap":       true,
	".pfb":         true,
	".txt":         true,
	".xml":         true,
}

func isStaticAssetPath(cleanPath string) bool {
	if strings.HasPrefix(cleanPath, "/assets/") ||
		strings.HasPrefix(cleanPath, "/pdfjs/") ||
		strings.HasPrefix(cleanPath, "/css/") {
		return true
	}
	ext := strings.ToLower(path.Ext(cleanPath))
	return staticAssetExtensions[ext]
}

func hasHiddenSegment(cleanPath string) bool {
	for _, seg := range strings.Split(cleanPath, "/") {
		if strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

// NewSPAHandler serves static assets from webFS with immutable caching for
// content-hashed /assets/* bundles, no-cache for index.html, and SPA history
// fallback to index.html for client-side routes.
func NewSPAHandler(webFS fs.FS) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
			WriteError(w, http.StatusNotFound, "Not Found")
			return
		}

		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}

		clean := path.Clean("/" + r.URL.Path)
		if hasHiddenSegment(clean) {
			http.NotFound(w, r)
			return
		}

		if clean != "/" {
			rel := strings.TrimPrefix(clean, "/")
			if data, ok := readRegularFile(webFS, rel); ok {
				if ct := mime.TypeByExtension(strings.ToLower(path.Ext(rel))); ct != "" {
					w.Header().Set("Content-Type", ct)
				}
				switch {
				case strings.HasPrefix(clean, "/assets/"):
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				case clean == "/index.html":
					w.Header().Set("Cache-Control", "no-cache")
				default:
					w.Header().Set("Cache-Control", "public, max-age=3600")
				}
				http.ServeContent(w, r, path.Base(rel), time.Time{}, bytes.NewReader(data))
				return
			}

			if isStaticAssetPath(clean) {
				http.NotFound(w, r)
				return
			}
		}

		indexBytes, ok := readRegularFile(webFS, "index.html")
		if !ok {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("Frontend bundle not built. Run `pnpm build:web` or set DELB_UPSTREAM_URL for Vite dev mode.\n"))
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(indexBytes))
	})
}

func readRegularFile(fsys fs.FS, name string) ([]byte, bool) {
	info, err := fs.Stat(fsys, name)
	if err != nil || info.IsDir() {
		return nil, false
	}
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		return nil, false
	}
	return data, true
}
