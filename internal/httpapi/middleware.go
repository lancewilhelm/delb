package httpapi

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/lancewilhelm/delb/internal/auth"
)

type sessionContextKey struct{}

// WithSession attaches an authenticated session to ctx.
func WithSession(ctx context.Context, swu *auth.SessionWithUser) context.Context {
	return context.WithValue(ctx, sessionContextKey{}, swu)
}

// SessionFromContext returns the authenticated session stored by RequireSession / RequireAdmin.
func SessionFromContext(ctx context.Context) *auth.SessionWithUser {
	swu, _ := ctx.Value(sessionContextKey{}).(*auth.SessionWithUser)
	return swu
}

// RequireSession validates the delb.session_token cookie (refreshing it on the
// sliding window when appropriate) and injects the session into request context.
func RequireSession(authSvc *auth.Service, logger *slog.Logger, next http.Handler) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		swu, err := authSvc.Authenticate(w, r)
		if err != nil {
			logger.ErrorContext(r.Context(), "session lookup failed", "path", r.URL.Path, "error", err)
			WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		if swu == nil {
			WriteError(w, http.StatusUnauthorized, "Unauthorized")
			return
		}
		SetRequestUserID(r.Context(), swu.User.ID)
		next.ServeHTTP(w, r.WithContext(WithSession(r.Context(), swu)))
	})
}

// RequireSessionFunc wraps an http.HandlerFunc with RequireSession.
func RequireSessionFunc(authSvc *auth.Service, logger *slog.Logger, next http.HandlerFunc) http.HandlerFunc {
	h := RequireSession(authSvc, logger, next)
	return h.ServeHTTP
}

// RequireAdmin validates the session and enforces that the authenticated user
// has role "admin" or "owner".
func RequireAdmin(authSvc *auth.Service, logger *slog.Logger, next http.Handler) http.Handler {
	return RequireSession(authSvc, logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		swu := SessionFromContext(r.Context())
		if swu == nil || (swu.User.Role != "admin" && swu.User.Role != "owner") {
			WriteError(w, http.StatusForbidden, "Administrator access required")
			return
		}
		next.ServeHTTP(w, r)
	}))
}

// RequireAdminFunc wraps an http.HandlerFunc with RequireAdmin.
func RequireAdminFunc(authSvc *auth.Service, logger *slog.Logger, next http.HandlerFunc) http.HandlerFunc {
	h := RequireAdmin(authSvc, logger, next)
	return h.ServeHTTP
}
