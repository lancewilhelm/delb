package config_test

import (
	"testing"

	"github.com/lancewilhelm/delb/internal/config"
)

func TestConfigLoadDefaultsAndValidation(t *testing.T) {
	t.Setenv("NODE_ENV", "development")
	t.Setenv("HOST", "")
	t.Setenv("HOSTNAME", "MyMac.local")
	t.Setenv("PORT", "")
	t.Setenv("DATABASE_URL", "")
	t.Setenv("BETTER_AUTH_SECRET", "")
	t.Setenv("AUTH_SECRET", "")
	t.Setenv("BETTER_AUTH_URL", "http://localhost:3000/")
	t.Setenv("BETTER_AUTH_TRUSTED_ORIGINS", "http://localhost:3000, https://books.example.com/")
	t.Setenv("DELB_UPSTREAM_URL", "http://127.0.0.1:3001/")
	t.Setenv("DELB_CODEX_AUTH_URL", "")
	t.Setenv("DELB_CODEX_API_URL", "")
	t.Setenv("DELB_AUTO_MIGRATE", "")

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("Load dev defaults: %v", err)
	}
	if cfg.CodexAuthURL != config.DefaultCodexAuthURL || cfg.CodexAPIURL != config.DefaultCodexAPIURL {
		t.Fatalf("Codex defaults = %q / %q", cfg.CodexAuthURL, cfg.CodexAPIURL)
	}
	if cfg.ListenAddr() != ":3000" {
		t.Fatalf("ListenAddr = %q, want :3000", cfg.ListenAddr())
	}
	if cfg.AuthSecret != config.DefaultDevSecret {
		t.Fatalf("dev fallback secret mismatch")
	}
	if cfg.AuthURL != "http://localhost:3000" {
		t.Fatalf("AuthURL = %q", cfg.AuthURL)
	}
	if len(cfg.TrustedOrigins) != 2 || cfg.TrustedOrigins[1] != "https://books.example.com" {
		t.Fatalf("TrustedOrigins = %v", cfg.TrustedOrigins)
	}
	if cfg.UpstreamURL != "http://127.0.0.1:3001" {
		t.Fatalf("UpstreamURL = %q", cfg.UpstreamURL)
	}
	if !cfg.AutoMigrate {
		t.Fatalf("AutoMigrate should default true")
	}

	// Production requires explicit non-default secret.
	t.Setenv("NODE_ENV", "production")
	if _, err := config.Load(); err == nil {
		t.Fatalf("expected error in production without BETTER_AUTH_SECRET")
	}
	t.Setenv("BETTER_AUTH_SECRET", config.DefaultDevSecret)
	if _, err := config.Load(); err == nil {
		t.Fatalf("expected error in production with default dev secret")
	}
	t.Setenv("BETTER_AUTH_SECRET", "prod-secret-0123456789abcdef0123456789abcdef")
	if _, err := config.Load(); err != nil {
		t.Fatalf("expected success in production with strong secret: %v", err)
	}

	// Custom Codex provider URLs validate scheme and trim trailing slash.
	t.Setenv("DELB_CODEX_AUTH_URL", "http://127.0.0.1:9999/")
	t.Setenv("DELB_CODEX_API_URL", "http://127.0.0.1:9998/")
	cfg, err = config.Load()
	if err != nil {
		t.Fatalf("custom codex URLs: %v", err)
	}
	if cfg.CodexAuthURL != "http://127.0.0.1:9999" || cfg.CodexAPIURL != "http://127.0.0.1:9998" {
		t.Fatalf("custom codex URLs = %q / %q", cfg.CodexAuthURL, cfg.CodexAPIURL)
	}
	t.Setenv("DELB_CODEX_API_URL", "ftp://invalid.example")
	if _, err := config.Load(); err == nil {
		t.Fatal("expected error for invalid DELB_CODEX_API_URL scheme")
	}
}
