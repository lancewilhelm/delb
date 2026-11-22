package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/config"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/proxy"
)

func main() {
	migrateOnly := flag.Bool("migrate-only", false, "run pending SQLite migrations and exit")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: cfg.LogLevel,
	}))
	slog.SetDefault(logger)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	opened, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		logger.Error("failed to open sqlite database", "database_url", cfg.DatabaseURL, "error", err)
		os.Exit(1)
	}
	defer func() {
		if closeErr := opened.DB.Close(); closeErr != nil {
			logger.Warn("failed to close sqlite database", "error", closeErr)
		}
	}()

	if cfg.AutoMigrate {
		migRes, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS)
		if err != nil {
			logger.Error("database migration failed", "error", err)
			os.Exit(1)
		}
		if migRes.SkippedExternalSchema {
			logger.Warn("database already has tables without __drizzle_migrations; skipping auto-migration")
		} else if migRes.Applied > 0 {
			logger.Info("applied pending database migrations",
				"applied", migRes.Applied,
				"backup", migRes.BackupPath,
			)
		} else {
			logger.Debug("database schema is up to date")
		}
	}

	if *migrateOnly {
		return
	}

	authSvc := auth.NewService(auth.ServiceOptions{
		DB:             opened.DB,
		Secret:         cfg.AuthSecret,
		BaseURL:        cfg.AuthURL,
		TrustedOrigins: cfg.TrustedOrigins,
		Logger:         logger.With("component", "auth"),
	})

	var upstream http.Handler
	if cfg.UpstreamURL != "" {
		upstream, err = proxy.New(cfg.UpstreamURL, logger.With("component", "proxy"))
		if err != nil {
			logger.Error("failed to initialize upstream reverse proxy", "upstream", cfg.UpstreamURL, "error", err)
			os.Exit(1)
		}
		logger.Info("strangler reverse proxy enabled", "upstream", cfg.UpstreamURL)
	}

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		AuthService: authSvc,
		Upstream:    upstream,
	})

	srv := &http.Server{
		Addr:              cfg.ListenAddr(),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("Delb Go server listening", "addr", cfg.ListenAddr(), "db", opened.FilePath)
		if serveErr := srv.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
		}
		close(errCh)
	}()

	select {
	case serveErr := <-errCh:
		if serveErr != nil {
			logger.Error("http server error", "error", serveErr)
			os.Exit(1)
		}
	case <-ctx.Done():
		logger.Info("shutting down Delb Go server")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
			os.Exit(1)
		}
	}
}
