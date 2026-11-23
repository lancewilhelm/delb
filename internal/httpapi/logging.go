package httpapi

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net"
	"net/http"
	"path"
	"runtime/debug"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/logging"
)

const (
	RequestIDHeader  = "X-Request-Id"
	maxRequestIDLen  = 64
	maxPanicStackLen = 8 * 1024
)

// RequestIDFromContext returns the correlation ID attached by RequestIDMiddleware.
func RequestIDFromContext(ctx context.Context) string {
	return logging.RequestIDFromContext(ctx)
}

// SetRequestUserID associates the authenticated user ID with the current HTTP
// request so access logging can record it.
func SetRequestUserID(ctx context.Context, userID string) {
	logging.SetRequestUserID(ctx, userID)
}

// RequestIDMiddleware accepts a sanitized inbound X-Request-Id header or
// generates a compact random ID, stores it in request context, and echoes it on
// the response.
func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := sanitizeRequestID(r.Header.Get(RequestIDHeader))
		if reqID == "" {
			reqID = generateRequestID()
		}
		w.Header().Set(RequestIDHeader, reqID)
		ctx := logging.WithRequestID(r.Context(), reqID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func sanitizeRequestID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > maxRequestIDLen {
		return ""
	}
	for i := 0; i < len(trimmed); i++ {
		c := trimmed[i]
		ok := (c >= 'a' && c <= 'z') ||
			(c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.'
		if !ok {
			return ""
		}
	}
	return trimmed
}

func generateRequestID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%x", time.Now().UnixNano())
	}
	return hex.EncodeToString(buf[:])
}

type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int64
	wroteHeader bool
}

func (sr *statusRecorder) WriteHeader(code int) {
	if !sr.wroteHeader {
		sr.status = code
		sr.wroteHeader = true
		sr.ResponseWriter.WriteHeader(code)
	}
}

func (sr *statusRecorder) Write(p []byte) (int, error) {
	if !sr.wroteHeader {
		sr.WriteHeader(http.StatusOK)
	}
	n, err := sr.ResponseWriter.Write(p)
	sr.bytes += int64(n)
	return n, err
}

func (sr *statusRecorder) Flush() {
	if fl, ok := sr.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

func (sr *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := sr.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, errors.New("hijacking not supported")
}

func (sr *statusRecorder) Unwrap() http.ResponseWriter {
	return sr.ResponseWriter
}

// RecoveryMiddleware catches panics in downstream handlers, logs the panic and
// stack trace at ERROR with the correlated requestId, and returns a clean 500
// response when headers have not yet been sent.
func RecoveryMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				rec := recover()
				if rec == nil {
					return
				}
				// Re-panic http.ErrAbortHandler per net/http contract.
				if err, ok := rec.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(rec)
				}

				stack := debug.Stack()
				if len(stack) > maxPanicStackLen {
					stack = stack[:maxPanicStackLen]
				}
				logger.ErrorContext(r.Context(), "http panic recovered",
					"method", r.Method,
					"path", r.URL.Path,
					"panic", fmt.Sprint(rec),
					"stack", string(stack),
				)

				if sr, ok := w.(*statusRecorder); ok && sr.wroteHeader {
					return
				}
				if strings.HasPrefix(r.URL.Path, "/api/") {
					WriteError(w, http.StatusInternalServerError, "Internal Server Error")
					return
				}
				http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// AccessLogMiddleware emits structured HTTP access logs with method, path,
// status, durationMs, bytes, remoteIp, requestId (via context), and userId
// (when authenticated). Static assets and log-viewer polling are logged at DEBUG.
func AccessLogMiddleware(logger *slog.Logger) func(http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sr := &statusRecorder{
				ResponseWriter: w,
				status:         http.StatusOK,
			}

			next.ServeHTTP(sr, r)

			durationMs := math.Round(float64(time.Since(start).Microseconds())/10.0) / 100.0
			level := accessLogLevel(r.Method, r.URL.Path, sr.status)
			if !logger.Enabled(r.Context(), level) {
				return
			}

			attrs := []slog.Attr{
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", sr.status),
				slog.Float64("durationMs", durationMs),
				slog.Int64("bytes", sr.bytes),
				slog.String("remoteIp", clientRemoteIP(r)),
			}
			if sanitizedQuery := logging.SanitizeQuery(r.URL.RawQuery); sanitizedQuery != "" {
				attrs = append(attrs, slog.String("query", sanitizedQuery))
			}
			if userID := logging.RequestUserIDFromContext(r.Context()); userID != "" {
				attrs = append(attrs, slog.String("userId", userID))
			}

			logger.LogAttrs(r.Context(), level, "http request", attrs...)
		})
	}
}

func accessLogLevel(method, reqPath string, status int) slog.Level {
	if status >= 500 {
		return slog.LevelError
	}
	if isQuietAssetPath(reqPath) {
		return slog.LevelDebug
	}
	// Avoid flooding logs when the admin log viewer polls GET /api/settings/admin/logs.
	if method == http.MethodGet && reqPath == "/api/settings/admin/logs" && status < 400 {
		return slog.LevelDebug
	}
	if status >= 400 {
		if strings.HasPrefix(reqPath, "/api/") {
			return slog.LevelWarn
		}
		return slog.LevelDebug
	}
	if strings.HasPrefix(reqPath, "/api/") {
		return slog.LevelInfo
	}
	return slog.LevelDebug
}

func isQuietAssetPath(reqPath string) bool {
	if strings.HasPrefix(reqPath, "/assets/") ||
		strings.HasPrefix(reqPath, "/pdfjs/") ||
		strings.HasPrefix(reqPath, "/favicon") ||
		reqPath == "/robots.txt" ||
		reqPath == "/manifest.webmanifest" ||
		reqPath == "/site.webmanifest" {
		return true
	}
	switch strings.ToLower(path.Ext(reqPath)) {
	case ".js", ".mjs", ".css", ".map", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".wasm":
		return true
	}
	return false
}

func clientRemoteIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		first, _, _ := strings.Cut(xff, ",")
		if trimmed := strings.TrimSpace(first); trimmed != "" {
			return trimmed
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}
