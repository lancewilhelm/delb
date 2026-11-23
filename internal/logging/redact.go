package logging

import (
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// RedactedPlaceholder replaces sensitive values across all log sinks.
const RedactedPlaceholder = "[REDACTED]"

var (
	sensitiveTokens = map[string]struct{}{
		"password":    {},
		"passwd":      {},
		"secret":      {},
		"token":       {},
		"authorization": {},
		"cookie":      {},
		"credential":  {},
		"credentials": {},
		"passphrase":  {},
		"bearer":      {},
	}

	sensitiveCollapsed = map[string]struct{}{
		"apikey":           {},
		"xapikey":          {},
		"setcookie":        {},
		"privatekey":       {},
		"clientsecret":     {},
		"betterauthsecret": {},
		"authsecret":       {},
		"hardcovertoken":   {},
		"accesstoken":      {},
		"refreshtoken":     {},
		"idtoken":          {},
		"sessiontoken":     {},
		"sessionid":        {},
		"mcptoken":         {},
		"authheader":       {},
	}

	bearerValueRe  = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}`)
	mcpTokenRe     = regexp.MustCompile(`delb_mcp_[0-9a-fA-F-]+\.[A-Za-z0-9_-]+`)
	sessionCookieRe = regexp.MustCompile(`(?i)(delb\.session_token|__Secure-delb\.session_token)=([^;\s,]+)`)
	querySecretRe  = regexp.MustCompile(`(?i)(^|[?&;\s])(password|passwd|secret|token|api_key|apikey|access_token|refresh_token|id_token|session_token|key|auth|authorization|cookie)=([^&\s;]+)`)
)

// IsSensitiveKey reports whether an attribute or header/query key name refers
// to credentials, tokens, passwords, cookies, or secrets.
func IsSensitiveKey(key string) bool {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return false
	}

	var collapsed strings.Builder
	var tokens []string
	var cur strings.Builder

	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, strings.ToLower(cur.String()))
			cur.Reset()
		}
	}

	runes := []rune(trimmed)
	for i, r := range runes {
		if r == '_' || r == '-' || r == '.' || r == '/' || unicode.IsSpace(r) {
			flush()
			continue
		}
		collapsed.WriteRune(unicode.ToLower(r))
		if i > 0 && unicode.IsUpper(r) && unicode.IsLower(runes[i-1]) {
			flush()
		}
		cur.WriteRune(r)
	}
	flush()

	collapsedStr := collapsed.String()
	if _, ok := sensitiveCollapsed[collapsedStr]; ok {
		return true
	}
	if strings.Contains(collapsedStr, "apikey") ||
		strings.Contains(collapsedStr, "privatekey") ||
		strings.Contains(collapsedStr, "setcookie") ||
		strings.Contains(collapsedStr, "sessionid") {
		return true
	}
	for _, tok := range tokens {
		if _, ok := sensitiveTokens[tok]; ok {
			return true
		}
	}
	return false
}

// SanitizeString scrubs bearer/basic auth headers, Delb MCP tokens, session
// cookies, and sensitive query parameters embedded inside arbitrary strings.
func SanitizeString(s string) string {
	if s == "" {
		return s
	}
	out := bearerValueRe.ReplaceAllString(s, "$1 "+RedactedPlaceholder)
	out = mcpTokenRe.ReplaceAllString(out, "delb_mcp_"+RedactedPlaceholder)
	out = sessionCookieRe.ReplaceAllString(out, "$1="+RedactedPlaceholder)
	out = querySecretRe.ReplaceAllString(out, "$1$2="+RedactedPlaceholder)
	return out
}

// SanitizeQuery parses a raw URL query string and redacts values of sensitive
// query parameters (e.g. token, key, secret, password, api_key, auth, code).
func SanitizeQuery(rawQuery string) string {
	if strings.TrimSpace(rawQuery) == "" {
		return ""
	}
	parts := strings.Split(rawQuery, "&")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		k, v, hasEq := strings.Cut(part, "=")
		decodedKey, err := url.QueryUnescape(k)
		if err != nil {
			decodedKey = k
		}
		lowerKey := strings.ToLower(strings.TrimSpace(decodedKey))
		if IsSensitiveKey(decodedKey) || lowerKey == "key" || lowerKey == "auth" || lowerKey == "code" {
			out = append(out, k+"="+RedactedPlaceholder)
			continue
		}
		if hasEq {
			decodedVal, derr := url.QueryUnescape(v)
			if derr == nil {
				sanitized := SanitizeString(decodedVal)
				if sanitized != decodedVal {
					out = append(out, k+"="+url.QueryEscape(sanitized))
					continue
				}
			}
			out = append(out, k+"="+SanitizeString(v))
		} else {
			out = append(out, k)
		}
	}
	return strings.Join(out, "&")
}

// RedactAttr redacts sensitive keys, nested groups, strings, errors, and maps.
func RedactAttr(_ []string, a slog.Attr) slog.Attr {
	return redactAttr(a)
}

func redactAttr(a slog.Attr) slog.Attr {
	if a.Equal(slog.Attr{}) {
		return a
	}
	if IsSensitiveKey(a.Key) {
		return slog.String(a.Key, RedactedPlaceholder)
	}
	return slog.Attr{
		Key:   a.Key,
		Value: redactValue(a.Value),
	}
}

func redactValue(v slog.Value) slog.Value {
	resolved := v.Resolve()
	switch resolved.Kind() {
	case slog.KindString:
		return slog.StringValue(SanitizeString(resolved.String()))
	case slog.KindGroup:
		attrs := resolved.Group()
		redacted := make([]slog.Attr, len(attrs))
		for i, child := range attrs {
			redacted[i] = redactAttr(child)
		}
		return slog.GroupValue(redacted...)
	case slog.KindAny:
		return slog.AnyValue(redactAny(resolved.Any()))
	default:
		return resolved
	}
}

func redactAny(val any) any {
	switch x := val.(type) {
	case nil:
		return nil
	case string:
		return SanitizeString(x)
	case error:
		return SanitizeString(x.Error())
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, v := range x {
			if IsSensitiveKey(k) {
				out[k] = RedactedPlaceholder
			} else {
				out[k] = redactAny(v)
			}
		}
		return out
	case map[string]string:
		out := make(map[string]string, len(x))
		for k, v := range x {
			if IsSensitiveKey(k) {
				out[k] = RedactedPlaceholder
			} else {
				out[k] = SanitizeString(v)
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = redactAny(item)
		}
		return out
	case []string:
		out := make([]string, len(x))
		for i, item := range x {
			out[i] = SanitizeString(item)
		}
		return out
	case fmt.Stringer:
		return SanitizeString(x.String())
	default:
		return val
	}
}
