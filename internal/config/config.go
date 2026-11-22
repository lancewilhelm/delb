package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// DefaultDevSecret matches Better Auth's built-in development fallback so the
// Go server and Nitro share the same signing key during local development if
// neither BETTER_AUTH_SECRET nor AUTH_SECRET is set.
const DefaultDevSecret = "better-auth-secret-12345678901234567890"

type Config struct {
	Host           string
	Port           string
	DatabaseURL    string
	LibraryDir     string
	AuthSecret     string
	AuthURL        string
	TrustedOrigins []string
	UpstreamURL    string
	LogLevel       slog.Level
	IsProduction   bool
	AutoMigrate    bool
}

func Load() (Config, error) {
	nodeEnv := strings.TrimSpace(os.Getenv("NODE_ENV"))
	isProd := strings.EqualFold(nodeEnv, "production")

	host := resolveHost()
	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = "3000"
	}

	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		databaseURL = "file:./data/delb.db"
	}

	secret := strings.TrimSpace(os.Getenv("BETTER_AUTH_SECRET"))
	if secret == "" {
		secret = strings.TrimSpace(os.Getenv("AUTH_SECRET"))
	}
	if secret == "" {
		if isProd {
			return Config{}, fmt.Errorf("BETTER_AUTH_SECRET must be set in production")
		}
		secret = DefaultDevSecret
	} else if isProd && secret == DefaultDevSecret {
		return Config{}, fmt.Errorf("BETTER_AUTH_SECRET must not use the default development secret in production")
	}

	authURL := strings.TrimRight(strings.TrimSpace(os.Getenv("BETTER_AUTH_URL")), "/")
	var trustedOrigins []string
	if raw := strings.TrimSpace(os.Getenv("BETTER_AUTH_TRUSTED_ORIGINS")); raw != "" {
		for _, part := range strings.Split(raw, ",") {
			if trimmed := strings.TrimRight(strings.TrimSpace(part), "/"); trimmed != "" {
				trustedOrigins = append(trustedOrigins, trimmed)
			}
		}
	}

	upstreamURL := strings.TrimRight(strings.TrimSpace(os.Getenv("DELB_UPSTREAM_URL")), "/")
	if upstreamURL != "" {
		u, err := url.Parse(upstreamURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return Config{}, fmt.Errorf("invalid DELB_UPSTREAM_URL %q", upstreamURL)
		}
	}

	autoMigrate := true
	if raw := strings.TrimSpace(os.Getenv("DELB_AUTO_MIGRATE")); raw != "" {
		lower := strings.ToLower(raw)
		if lower == "false" || lower == "0" || lower == "no" {
			autoMigrate = false
		}
	}

	libraryDir := strings.TrimSpace(os.Getenv("DELB_LIBRARY_DIR"))
	if libraryDir == "" {
		libraryDir = "library"
	}
	absLibraryDir, err := filepath.Abs(libraryDir)
	if err != nil {
		return Config{}, fmt.Errorf("resolve library directory %q: %w", libraryDir, err)
	}

	return Config{
		Host:           host,
		Port:           port,
		DatabaseURL:    databaseURL,
		LibraryDir:     absLibraryDir,
		AuthSecret:     secret,
		AuthURL:        authURL,
		TrustedOrigins: trustedOrigins,
		UpstreamURL:    upstreamURL,
		LogLevel:       parseLogLevel(os.Getenv("LOG_LEVEL")),
		IsProduction:   isProd,
		AutoMigrate:    autoMigrate,
	}, nil
}

func (c Config) ListenAddr() string {
	return c.Host + ":" + c.Port
}

func resolveHost() string {
	if h := strings.TrimSpace(os.Getenv("HOST")); h != "" {
		return h
	}
	if h := strings.TrimSpace(os.Getenv("HOSTNAME")); h != "" {
		switch h {
		case "0.0.0.0", "127.0.0.1", "localhost", "::", "::1":
			return h
		}
	}
	// Empty host binds dual-stack (":PORT") so both IPv4 127.0.0.1 and IPv6 ::1
	// localhost requests work seamlessly.
	return ""
}

func parseLogLevel(raw string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug", "trace":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error", "fatal":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
