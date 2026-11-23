package proxy

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// New creates a transparent reverse proxy to upstreamURL that preserves cookies,
// headers, status codes, streaming responses, and HTTP/1.1 Upgrade (WebSocket/HMR)
// connections.
func New(upstreamURL string, logger *slog.Logger) (http.Handler, error) {
	target, err := url.Parse(upstreamURL)
	if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
		return nil, fmt.Errorf("invalid upstream URL %q", upstreamURL)
	}
	if logger == nil {
		logger = slog.Default()
	}

	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
			// Preserve the front-facing Host header so Nitro/Nuxt/Vite URL
			// reconstruction and HMR see the external host and port.
			pr.Out.Host = pr.In.Host
		},
		// Flush immediately so streaming responses (SSE, MCP Streamable HTTP,
		// large file downloads) are never buffered.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, proxyErr error) {
			logger.ErrorContext(r.Context(), "upstream proxy error", "method", r.Method, "path", r.URL.Path, "upstream", upstreamURL, "error", proxyErr)
			if strings.HasPrefix(r.URL.Path, "/api/") {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.WriteHeader(http.StatusBadGateway)
				_ = json.NewEncoder(w).Encode(map[string]string{
					"message": "Upstream service unavailable",
				})
				return
			}
			http.Error(w, "Upstream service unavailable", http.StatusBadGateway)
		},
	}

	return rp, nil
}
