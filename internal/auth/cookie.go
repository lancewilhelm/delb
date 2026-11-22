package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

const (
	CookiePrefix          = "delb"
	SessionCookieBaseName = CookiePrefix + ".session_token"
	SecureCookiePrefix    = "__Secure-"
	SessionExpiresInSecs  = 7 * 24 * 60 * 60 // 7 days (Better Auth default)
	SessionUpdateAgeSecs  = 24 * 60 * 60     // 1 day (Better Auth default)
)

// SignCookieValue produces a Better Auth / better-call compatible signed cookie
// value: encodeURIComponent(value + "." + base64(HMAC-SHA256(secret, value))).
func SignCookieValue(value, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(value))
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return encodeURIComponent(value + "." + sig)
}

// VerifySignedCookieValue decodes and validates a Better Auth / better-call
// signed cookie value, returning the raw unsigned value when valid.
func VerifySignedCookieValue(rawCookieValue, secret string) (string, bool) {
	decoded, err := url.PathUnescape(rawCookieValue)
	if err != nil {
		return "", false
	}
	dotIdx := strings.LastIndexByte(decoded, '.')
	if dotIdx < 1 {
		return "", false
	}
	signedValue := decoded[:dotIdx]
	sigB64 := decoded[dotIdx+1:]
	// Better Auth / better-call requires exact 44-char standard base64 HMAC-SHA256 ending in '='.
	if len(sigB64) != 44 || !strings.HasSuffix(sigB64, "=") {
		return "", false
	}
	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil || len(sigBytes) != sha256.Size {
		return "", false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signedValue))
	expected := mac.Sum(nil)
	if !hmac.Equal(sigBytes, expected) {
		return "", false
	}
	return signedValue, true
}

// ShouldUseSecureCookies mirrors Better Auth's createCookieGetter logic:
// secure cookies (with the __Secure- prefix) are used when baseURL is https://
// or when baseURL is unset and the incoming request arrived over HTTPS.
func ShouldUseSecureCookies(baseURL string, r *http.Request) bool {
	if baseURL != "" {
		return strings.HasPrefix(strings.ToLower(baseURL), "https://")
	}
	if r != nil {
		if r.TLS != nil {
			return true
		}
		if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
			return true
		}
	}
	return false
}

// SessionCookieName returns the cookie name matching Better Auth's configuration.
func SessionCookieName(secure bool) string {
	if secure {
		return SecureCookiePrefix + SessionCookieBaseName
	}
	return SessionCookieBaseName
}

// ReadSessionCookie extracts and verifies the session token from the request's
// Cookie header, checking __Secure-delb.session_token before delb.session_token.
// Returns (token, cookieWasPresent).
func ReadSessionCookie(r *http.Request, secret string) (string, bool) {
	names := []string{
		SecureCookiePrefix + SessionCookieBaseName,
		SessionCookieBaseName,
	}
	sawAny := false
	for _, name := range names {
		c, err := r.Cookie(name)
		if err != nil {
			continue
		}
		sawAny = true
		if token, ok := VerifySignedCookieValue(c.Value, secret); ok {
			return token, true
		}
	}
	return "", sawAny
}

// SetSessionCookie writes the signed session Set-Cookie header in Better Auth's format.
func SetSessionCookie(w http.ResponseWriter, r *http.Request, baseURL, secret, token string, maxAge int) {
	secure := ShouldUseSecureCookies(baseURL, r)
	name := SessionCookieName(secure)
	signed := SignCookieValue(token, secret)
	var b strings.Builder
	fmt.Fprintf(&b, "%s=%s; Max-Age=%d; Path=/; HttpOnly", name, signed, maxAge)
	if secure {
		b.WriteString("; Secure")
	}
	b.WriteString("; SameSite=Lax")
	w.Header().Add("Set-Cookie", b.String())
}

// ClearSessionCookie expires the session cookie(s) on the client.
func ClearSessionCookie(w http.ResponseWriter, r *http.Request, baseURL string) {
	secure := ShouldUseSecureCookies(baseURL, r)
	name := SessionCookieName(secure)
	var b strings.Builder
	fmt.Fprintf(&b, "%s=; Max-Age=0; Path=/; HttpOnly", name)
	if secure {
		b.WriteString("; Secure")
	}
	b.WriteString("; SameSite=Lax")
	w.Header().Add("Set-Cookie", b.String())
}

// encodeURIComponent matches JavaScript's ECMA-262 encodeURIComponent exactly.
func encodeURIComponent(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s) + 12)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') ||
			(c >= 'a' && c <= 'z') ||
			(c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
		} else {
			b.WriteByte('%')
			b.WriteByte(hexDigits[c>>4])
			b.WriteByte(hexDigits[c&0x0F])
		}
	}
	return b.String()
}
