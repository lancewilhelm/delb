package httpapi

import (
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/auth"
)

// RouteRegistrar is implemented by domain services that register their HTTP
// endpoints onto the root http.ServeMux.
type RouteRegistrar interface {
	RegisterRoutes(mux *http.ServeMux)
}

type RouterOptions struct {
	DB          *sql.DB
	Logger      *slog.Logger
	AuthService *auth.Service
	Services    []RouteRegistrar
	Middleware  []func(http.Handler) http.Handler
	Upstream    http.Handler
}

// NewHandler constructs the root HTTP handler:
//   - Wraps all /api/* routes with the global collections-model maintenance gate
//     and any caller-supplied outer middleware (such as startup storage recovery).
//   - Mounts /api/auth/* and all ported domain services (Settings, Users,
//     Collections, Books/Catalog/Reading/Search/Dashboard, Bookshelves/Shelves/
//     Pictures, Spines/SpineGeneration/ChatGPT-Image, ...).
//   - Proxies remaining unported Phase 2D routes (e.g. /api/settings/admin/health,
//     /api/settings/admin/calibre, /api/nuke, /api/mcp*, frontend assets) to
//     Upstream when configured, or returns a clean JSON 404 for /api/* when
//     running standalone.
func NewHandler(opts RouterOptions) http.Handler {
	mux := http.NewServeMux()
	if opts.AuthService != nil {
		opts.AuthService.RegisterRoutes(mux)
	}
	for _, svc := range opts.Services {
		if svc != nil {
			svc.RegisterRoutes(mux)
		}
	}

	if opts.Upstream != nil {
		mux.Handle("/", opts.Upstream)
	} else {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusNotFound)
				_ = json.NewEncoder(w).Encode(map[string]string{
					"message": "Not Found",
				})
				return
			}
			http.NotFound(w, r)
		})
	}

	var handler http.Handler = CollectionMigrationGate(opts.DB, opts.Logger, mux)
	for i := len(opts.Middleware) - 1; i >= 0; i-- {
		if opts.Middleware[i] != nil {
			handler = opts.Middleware[i](handler)
		}
	}
	return handler
}
