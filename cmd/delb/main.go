package main

import (
	"context"
	"errors"
	"flag"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/admin"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/config"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/dropbox"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/mcp"
	"github.com/lancewilhelm/delb/internal/proxy"
	"github.com/lancewilhelm/delb/internal/settings"
	"github.com/lancewilhelm/delb/internal/spines"
	"github.com/lancewilhelm/delb/internal/storage"
	"github.com/lancewilhelm/delb/internal/users"
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

	settingsSvc := settings.NewService(settings.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      logger.With("component", "settings"),
	})

	usersSvc := users.NewService(users.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      logger.With("component", "users"),
	})

	collectionsSvc := collections.NewService(collections.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  cfg.LibraryDir,
		Logger:      logger.With("component", "collections"),
	})

	booksSvc := books.NewService(books.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  cfg.LibraryDir,
		Logger:      logger.With("component", "books"),
	})

	bookshelfSvc := bookshelf.NewService(bookshelf.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		TokenSecret: cfg.AuthSecret,
		Logger:      logger.With("component", "bookshelf"),
	})

	spinesSvc := spines.NewService(spines.ServiceOptions{
		DB:           opened.DB,
		AuthService:  authSvc,
		AuthSecret:   cfg.AuthSecret,
		LibraryDir:   cfg.LibraryDir,
		CodexAuthURL: cfg.CodexAuthURL,
		CodexAPIURL:  cfg.CodexAPIURL,
		Logger:       logger.With("component", "spines"),
	})

	adminSvc := admin.NewService(admin.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  cfg.LibraryDir,
		Logger:      logger.With("component", "admin"),
	})

	mcpSvc := mcp.NewService(mcp.ServiceOptions{
		DB:               opened.DB,
		AuthService:      authSvc,
		BooksService:     booksSvc,
		BookshelfService: bookshelfSvc,
		Logger:           logger.With("component", "mcp"),
	})

	recoveryGate := storage.StartRecovery(ctx, opened.DB, cfg.LibraryDir, logger.With("component", "storage"))

	dropboxWatcher := dropbox.NewWatcher(dropbox.WatcherOptions{
		DB:         opened.DB,
		LibraryDir: cfg.LibraryDir,
		Logger:     logger.With("component", "dropbox"),
	})
	dropboxWatcher.Start(ctx, recoveryGate)

	var upstream http.Handler
	var webFS fs.FS
	if cfg.UpstreamURL != "" {
		upstream, err = proxy.New(cfg.UpstreamURL, logger.With("component", "proxy"))
		if err != nil {
			logger.Error("failed to initialize upstream reverse proxy", "upstream", cfg.UpstreamURL, "error", err)
			os.Exit(1)
		}
		logger.Info("frontend reverse proxy enabled", "upstream", cfg.UpstreamURL)
	} else {
		webFS, err = fs.Sub(delb.WebFS, "dist")
		if err != nil {
			logger.Error("failed to open embedded web assets", "error", err)
			os.Exit(1)
		}
		logger.Info("serving embedded web SPA")
	}

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      logger.With("component", "httpapi"),
		AuthService: authSvc,
		Services: []httpapi.RouteRegistrar{
			settingsSvc,
			usersSvc,
			collectionsSvc,
			booksSvc,
			bookshelfSvc,
			spinesSvc,
			adminSvc,
			mcpSvc,
		},
		Middleware: []func(http.Handler) http.Handler{
			recoveryGate.Middleware,
		},
		Upstream: upstream,
		WebFS:    webFS,
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
		stop()
		dropboxWatcher.Wait()
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
		dropboxWatcher.Wait()
	}
}
