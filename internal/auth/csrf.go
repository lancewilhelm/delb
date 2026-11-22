package auth

import (
	"net/http"
	"net/url"
	"strings"
)

// ValidateCSRF mirrors Better Auth's originCheckMiddleware + formCsrfMiddleware:
//   - Safe methods (GET, HEAD, OPTIONS) pass.
//   - State-changing requests with cookies MUST carry a trusted Origin or Referer.
//   - Requests with Fetch Metadata headers (Sec-Fetch-*) reject cross-site navigations
//     and validate Origin/Referer.
//   - Requests without cookies that explicitly include Origin or Referer validate it.
//   - Trusted origins include BETTER_AUTH_URL's origin (or the request's own origin
//     when BETTER_AUTH_URL is unset) plus BETTER_AUTH_TRUSTED_ORIGINS (supporting
//     simple wildcard patterns like https://*.example.com).
func ValidateCSRF(r *http.Request, baseURL string, trustedOrigins []string) *APIError {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return nil
	}

	origin := strings.TrimSpace(r.Header.Get("Origin"))
	referer := strings.TrimSpace(r.Header.Get("Referer"))
	hasCookie := strings.TrimSpace(r.Header.Get("Cookie")) != ""
	secFetchSite := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))
	secFetchMode := strings.TrimSpace(r.Header.Get("Sec-Fetch-Mode"))
	secFetchDest := strings.TrimSpace(r.Header.Get("Sec-Fetch-Dest"))

	if !hasCookie && secFetchSite == "cross-site" && secFetchMode == "navigate" {
		return &APIError{
			Status:  http.StatusForbidden,
			Code:    "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
			Message: "Cross-site navigation login blocked",
		}
	}

	mustValidate := hasCookie ||
		secFetchSite != "" || secFetchMode != "" || secFetchDest != "" ||
		origin != "" || referer != ""
	if !mustValidate {
		return nil
	}

	originHeader := origin
	if originHeader == "" {
		originHeader = referer
	}
	if origin == "null" && secFetchSite == "same-origin" {
		if reqOrigin := requestOrigin(r); reqOrigin != "" {
			originHeader = reqOrigin
		}
	}

	if originHeader == "" || originHeader == "null" {
		return &APIError{
			Status:  http.StatusForbidden,
			Code:    "MISSING_OR_NULL_ORIGIN",
			Message: "Missing or null Origin",
		}
	}

	reqOriginNorm := normalizeOrigin(originHeader)
	if reqOriginNorm == "" {
		return &APIError{
			Status:  http.StatusForbidden,
			Code:    "INVALID_ORIGIN",
			Message: "Invalid origin",
		}
	}

	allowed := collectTrustedOrigins(r, baseURL, trustedOrigins)
	for _, candidate := range allowed {
		if matchesOriginPattern(reqOriginNorm, candidate) {
			return nil
		}
	}

	return &APIError{
		Status:  http.StatusForbidden,
		Code:    "INVALID_ORIGIN",
		Message: "Invalid origin",
	}
}

func collectTrustedOrigins(r *http.Request, baseURL string, configured []string) []string {
	var out []string
	if baseURL != "" {
		if o := normalizeOrigin(baseURL); o != "" {
			out = append(out, o)
		}
	} else if reqO := requestOrigin(r); reqO != "" {
		out = append(out, reqO)
	}
	for _, entry := range configured {
		trimmed := strings.TrimRight(strings.TrimSpace(entry), "/")
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func requestOrigin(r *http.Request) string {
	host := strings.TrimSpace(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = strings.TrimSpace(r.Host)
	}
	if host == "" {
		return ""
	}
	scheme := "http"
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		scheme = strings.ToLower(strings.Split(proto, ",")[0])
	} else if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + host
}

func normalizeOrigin(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func matchesOriginPattern(origin, pattern string) bool {
	pattern = strings.TrimRight(strings.TrimSpace(pattern), "/")
	if pattern == "" {
		return false
	}
	if !strings.Contains(pattern, "*") {
		return strings.EqualFold(origin, normalizeOrigin(pattern))
	}
	// Wildcard match on scheme://*.domain or *.domain
	p := strings.ToLower(pattern)
	o := strings.ToLower(origin)
	parts := strings.Split(p, "*")
	if len(parts) == 2 {
		return strings.HasPrefix(o, parts[0]) && strings.HasSuffix(o, parts[1]) && len(o) >= len(parts[0])+len(parts[1])
	}
	return false
}
