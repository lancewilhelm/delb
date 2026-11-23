package httpapi

import (
	"database/sql"
	"io/fs"
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
	WebFS       fs.FS
}

// NewHandler constructs the root HTTP handler:
//   - Wraps all /api/* routes with the global collections-model maintenance gate
//     and any caller-supplied outer middleware (such as startup storage recovery).
//   - Mounts /api/auth/* and all domain services (Settings, Users, Collections,
//     Books/Catalog/Reading/Search/Dashboard, Bookshelves/Shelves/Pictures,
//     Spines/SpineGeneration/ChatGPT-Image, Admin Health/Calibre/Nuke, MCP
//     Connections & Streamable HTTP MCP Server).
//   - Handles all unknown /api/* paths directly in Go with a clean JSON 404.
//   - Proxies non-API frontend paths (/, assets) to Upstream when configured
//     (e.g. Vite HMR dev server), or serves the embedded SPA from WebFS in
//     standalone production mode.
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

	// Catch-all for any unknown /api/* route: return a clean JSON 404 in Go
	// without ever hitting Upstream or the SPA fallback.
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		WriteError(w, http.StatusNotFound, "Not Found")
	})

	switch {
	case opts.Upstream != nil:
		mux.Handle("/", opts.Upstream)
	case opts.WebFS != nil:
		mux.Handle("/", NewSPAHandler(opts.WebFS))
	default:
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				WriteError(w, http.StatusNotFound, "Not Found")
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
