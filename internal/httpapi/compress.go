package httpapi

import (
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

var gzipWriterPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.DefaultCompression)
		return w
	},
}

// GzipMiddleware transparently compresses compressible HTTP responses (HTML,
// JS, CSS, JSON, SVG, plain text, WASM) when the client advertises gzip support.
// Already-compressed binary payloads (images, fonts, EPUBs, PDFs), SSE streams,
// WebSocket upgrades, HEAD requests, and Range requests are passed through
// untouched.
func GzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodHead ||
			r.Header.Get("Upgrade") != "" ||
			r.Header.Get("Range") != "" ||
			!acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}

		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.close()
		next.ServeHTTP(gw, r)
	})
}

func acceptsGzip(header string) bool {
	if header == "" {
		return false
	}
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		name, params, _ := strings.Cut(part, ";")
		name = strings.ToLower(strings.TrimSpace(name))
		if name != "gzip" {
			continue
		}
		if params == "" {
			return true
		}
		allowed := true
		for _, param := range strings.Split(params, ";") {
			k, v, ok := strings.Cut(strings.TrimSpace(param), "=")
			if !ok {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(k), "q") {
				q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
				if err == nil && q <= 0 {
					allowed = false
				}
			}
		}
		if allowed {
			return true
		}
	}
	return false
}

func isCompressibleContentType(contentType string) bool {
	if contentType == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		mediaType = strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	} else {
		mediaType = strings.ToLower(mediaType)
	}
	if mediaType == "text/event-stream" {
		return false
	}
	if strings.HasPrefix(mediaType, "text/") {
		return true
	}
	switch mediaType {
	case "application/json",
		"application/javascript",
		"application/x-javascript",
		"application/ecmascript",
		"application/xml",
		"application/xhtml+xml",
		"application/manifest+json",
		"application/wasm",
		"image/svg+xml":
		return true
	}
	return strings.HasSuffix(mediaType, "+json") || strings.HasSuffix(mediaType, "+xml")
}

func appendVaryAcceptEncoding(h http.Header) {
	for _, existing := range h.Values("Vary") {
		for _, token := range strings.Split(existing, ",") {
			t := strings.TrimSpace(token)
			if strings.EqualFold(t, "Accept-Encoding") || t == "*" {
				return
			}
		}
	}
	h.Add("Vary", "Accept-Encoding")
}

type gzipResponseWriter struct {
	http.ResponseWriter
	wroteHeader bool
	compressing bool
	gz          *gzip.Writer
}

func (g *gzipResponseWriter) decide(statusCode int, sniff []byte) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true

	// Never compress informational, No Content, or Not Modified responses.
	if (statusCode >= 100 && statusCode < 200) ||
		statusCode == http.StatusNoContent ||
		statusCode == http.StatusNotModified {
		g.ResponseWriter.WriteHeader(statusCode)
		return
	}

	h := g.ResponseWriter.Header()
	if h.Get("Content-Encoding") != "" {
		g.ResponseWriter.WriteHeader(statusCode)
		return
	}

	ct := h.Get("Content-Type")
	if ct == "" && len(sniff) > 0 {
		ct = http.DetectContentType(sniff)
	}

	if !isCompressibleContentType(ct) {
		g.ResponseWriter.WriteHeader(statusCode)
		return
	}

	appendVaryAcceptEncoding(h)
	h.Del("Content-Length")
	h.Del("Accept-Ranges")
	h.Set("Content-Encoding", "gzip")
	if h.Get("Content-Type") == "" && ct != "" {
		h.Set("Content-Type", ct)
	}

	gz := gzipWriterPool.Get().(*gzip.Writer)
	gz.Reset(g.ResponseWriter)
	g.gz = gz
	g.compressing = true
	g.ResponseWriter.WriteHeader(statusCode)
}

func (g *gzipResponseWriter) WriteHeader(statusCode int) {
	g.decide(statusCode, nil)
}

func (g *gzipResponseWriter) Write(p []byte) (int, error) {
	if !g.wroteHeader {
		g.decide(http.StatusOK, p)
	}
	if g.compressing && g.gz != nil {
		return g.gz.Write(p)
	}
	return g.ResponseWriter.Write(p)
}

func (g *gzipResponseWriter) Flush() {
	if g.compressing && g.gz != nil {
		_ = g.gz.Flush()
	}
	if fl, ok := g.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

func (g *gzipResponseWriter) Unwrap() http.ResponseWriter {
	return g.ResponseWriter
}

func (g *gzipResponseWriter) close() {
	if g.gz != nil {
		_ = g.gz.Close()
		g.gz.Reset(io.Discard)
		gzipWriterPool.Put(g.gz)
		g.gz = nil
	}
}
