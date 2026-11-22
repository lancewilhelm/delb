package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/auth"
)

type RouterOptions struct {
	AuthService *auth.Service
	Upstream    http.Handler
}

// NewHandler constructs the root HTTP handler:
//   - /api/auth/* is owned natively by Go.
//   - All other routes are proxied to Upstream when configured (strangler-fig
//     mode), or return a clean JSON 404 for /api/* when running standalone.
func NewHandler(opts RouterOptions) http.Handler {
	mux := http.NewServeMux()
	if opts.AuthService != nil {
		opts.AuthService.RegisterRoutes(mux)
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

	return mux
}
