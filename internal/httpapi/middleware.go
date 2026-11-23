package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/auth"
)

const CollectionMigrationRequiredMessage = "Collection migration required. An administrator must preview and apply it in Settings > Admin > Collections."

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

// CollectionMigrationGate mirrors server/middleware/collection-migration.ts:
// when system_state['collections-model'] != 'exclusive', all /api/* routes
// return 503 except the migration endpoint, auth read/sign-in/sign-out,
// first-user sign-up (when users table is empty), and GET /api/settings*.
func CollectionMigrationGate(db *sql.DB, logger *slog.Logger, next http.Handler) http.Handler {
	if db == nil {
		return next
	}
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		pathname := r.URL.Path
		if !strings.HasPrefix(pathname, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		state, err := readCollectionModelState(r.Context(), db)
		if err != nil {
			logger.Error("failed to check collections-model state", "path", pathname, "error", err)
			WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		if state == "exclusive" {
			next.ServeHTTP(w, r)
			return
		}

		if pathname == "/api/settings/admin/collections-migration" {
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasSuffix(pathname, "/sign-up/email") {
			hasUsers, err := hasAnyUser(r.Context(), db)
			if err != nil {
				logger.Error("failed to check users table during maintenance gate", "error", err)
				WriteError(w, http.StatusInternalServerError, "Internal Server Error")
				return
			}
			if !hasUsers {
				next.ServeHTTP(w, r)
				return
			}
		}
		if strings.HasPrefix(pathname, "/api/auth/") &&
			(r.Method == http.MethodGet ||
				strings.HasSuffix(pathname, "/sign-in/email") ||
				strings.HasSuffix(pathname, "/sign-out")) {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodGet &&
			(pathname == "/api/settings" ||
				pathname == "/api/settings/user" ||
				pathname == "/api/settings/global") {
			next.ServeHTTP(w, r)
			return
		}

		WriteError(w, http.StatusServiceUnavailable, CollectionMigrationRequiredMessage)
	})
}

func readCollectionModelState(ctx context.Context, db *sql.DB) (string, error) {
	var val string
	err := db.QueryRowContext(ctx, `SELECT value FROM system_state WHERE key = 'collections-model' LIMIT 1`).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "pending", nil
	}
	if err != nil {
		return "", err
	}
	return val, nil
}

func hasAnyUser(ctx context.Context, db *sql.DB) (bool, error) {
	var id string
	err := db.QueryRowContext(ctx, `SELECT id FROM users LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}
