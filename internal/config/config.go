package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/lancewilhelm/delb/internal/logging"
)

// DefaultDevSecret matches Better Auth's built-in development fallback so the
// Go server and Nitro share the same signing key during local development if
// neither BETTER_AUTH_SECRET nor AUTH_SECRET is set.
const DefaultDevSecret = "better-auth-secret-12345678901234567890"

const (
	DefaultCodexAuthURL = "https://auth.openai.com"
	DefaultCodexAPIURL  = "https://chatgpt.com"
)

type Config struct {
	Host             string
	Port             string
	DatabaseURL      string
	LibraryDir       string
	AuthSecret       string
	AuthURL          string
	TrustedOrigins   []string
	UpstreamURL      string
	CodexAuthURL     string
	CodexAPIURL      string
	LogLevel         slog.Level
	LogFormat        logging.Format
	LogDir           string
	LogMaxFileBytes  int64
	LogMaxFiles      int
	LogMaxTotalBytes int64
	IsProduction     bool
	AutoMigrate      bool
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

	codexAuthURL := strings.TrimRight(strings.TrimSpace(os.Getenv("DELB_CODEX_AUTH_URL")), "/")
	if codexAuthURL == "" {
		codexAuthURL = DefaultCodexAuthURL
	} else {
		u, err := url.Parse(codexAuthURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return Config{}, fmt.Errorf("invalid DELB_CODEX_AUTH_URL %q", codexAuthURL)
		}
	}

	codexAPIURL := strings.TrimRight(strings.TrimSpace(os.Getenv("DELB_CODEX_API_URL")), "/")
	if codexAPIURL == "" {
		codexAPIURL = DefaultCodexAPIURL
	} else {
		u, err := url.Parse(codexAPIURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return Config{}, fmt.Errorf("invalid DELB_CODEX_API_URL %q", codexAPIURL)
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

	logDir := strings.TrimSpace(os.Getenv("DELB_LOG_DIR"))
	if logDir != "" {
		absLogDir, err := filepath.Abs(logDir)
		if err != nil {
			return Config{}, fmt.Errorf("resolve log directory %q: %w", logDir, err)
		}
		logDir = absLogDir
	}

	return Config{
		Host:             host,
		Port:             port,
		DatabaseURL:      databaseURL,
		LibraryDir:       absLibraryDir,
		AuthSecret:       secret,
		AuthURL:          authURL,
		TrustedOrigins:   trustedOrigins,
		UpstreamURL:      upstreamURL,
		CodexAuthURL:     codexAuthURL,
		CodexAPIURL:      codexAPIURL,
		LogLevel:         parseLogLevel(os.Getenv("LOG_LEVEL")),
		LogFormat:        logging.ParseFormat(os.Getenv("LOG_FORMAT")),
		LogDir:           logDir,
		LogMaxFileBytes:  parsePositiveInt64(os.Getenv("DELB_LOG_MAX_FILE_BYTES"), logging.DefaultMaxFileBytes),
		LogMaxFiles:      parsePositiveInt(os.Getenv("DELB_LOG_MAX_FILES"), logging.DefaultMaxFiles),
		LogMaxTotalBytes: parsePositiveInt64(os.Getenv("DELB_LOG_MAX_TOTAL_BYTES"), logging.DefaultMaxTotalBytes),
		IsProduction:     isProd,
		AutoMigrate:      autoMigrate,
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
	lvl, err := logging.ParseLevel(raw)
	if err != nil {
		return slog.LevelInfo
	}
	return lvl
}

func parsePositiveInt(raw string, fallback int) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallback
	}
	n, err := strconv.Atoi(trimmed)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func parsePositiveInt64(raw string, fallback int64) int64 {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallback
	}
	n, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}
