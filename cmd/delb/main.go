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
	"path/filepath"
	"strings"
	"syscall"
	"time"
	_ "time/tzdata"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/admin"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/config"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/dropbox"
	"github.com/lancewilhelm/delb/internal/goodreads"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/logging"
	"github.com/lancewilhelm/delb/internal/mcp"
	"github.com/lancewilhelm/delb/internal/proxy"
	"github.com/lancewilhelm/delb/internal/settings"
	"github.com/lancewilhelm/delb/internal/spines"
	"github.com/lancewilhelm/delb/internal/storage"
	"github.com/lancewilhelm/delb/internal/users"
)

// version can be overridden at build time via -ldflags "-X main.version=...".
var version = "dev"

func resolveVersion() string {
	if version != "" && version != "dev" {
		return version
	}
	if v := strings.TrimSpace(os.Getenv("APP_VERSION")); v != "" && v != "unknown" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv("NUXT_PUBLIC_APP_VERSION")); v != "" && v != "unknown" {
		return v
	}
	return version
}

func resolveLogDir(cfg config.Config) string {
	if cfg.LogDir != "" {
		return cfg.LogDir
	}
	dbPath, isMem, err := db.ParseDatabaseURL(cfg.DatabaseURL)
	if err != nil || isMem || dbPath == "" {
		return ""
	}
	if absDB, absErr := filepath.Abs(dbPath); absErr == nil {
		dbPath = absDB
	}
	return filepath.Join(filepath.Dir(dbPath), "logs")
}

func main() {
	migrateOnly := flag.Bool("migrate-only", false, "run pending SQLite migrations and exit")
	flag.Parse()

	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration error", "error", err)
		os.Exit(1)
	}

	logDir := resolveLogDir(cfg)
	logMgr, err := logging.NewManager(logging.Options{
		Level:         cfg.LogLevel,
		Format:        cfg.LogFormat,
		Stdout:        os.Stdout,
		Dir:           logDir,
		MaxFileBytes:  cfg.LogMaxFileBytes,
		MaxFiles:      cfg.LogMaxFiles,
		MaxTotalBytes: cfg.LogMaxTotalBytes,
	})
	var logDirWarn error
	if err != nil {
		logDirWarn = err
		logDir = ""
		logMgr, err = logging.NewManager(logging.Options{
			Level:  cfg.LogLevel,
			Format: cfg.LogFormat,
			Stdout: os.Stdout,
		})
		if err != nil {
			slog.Error("failed to initialize logger", "error", err)
			os.Exit(1)
		}
	}
	defer func() {
		_ = logMgr.Close()
	}()

	rootLogger := logMgr.Logger()
	slog.SetDefault(rootLogger)
	logger := rootLogger.With("component", "server")
	dbLogger := rootLogger.With("component", "db")

	if logDirWarn != nil {
		logger.Warn("file log persistence disabled; falling back to stdout and memory buffer", "error", logDirWarn)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	opened, err := db.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		dbLogger.Error("failed to open sqlite database", "database_url", cfg.DatabaseURL, "error", err)
		os.Exit(1)
	}
	dbLogger.Info("sqlite database opened", "path", opened.FilePath, "inMemory", opened.IsMemory)
	defer func() {
		if closeErr := opened.DB.Close(); closeErr != nil {
			dbLogger.Warn("failed to close sqlite database", "error", closeErr)
		}
	}()

	if cfg.AutoMigrate {
		migStart := time.Now()
		migRes, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS)
		if err != nil {
			dbLogger.Error("database migration failed", "error", err)
			os.Exit(1)
		}
		if migRes.SkippedExternalSchema {
			dbLogger.Warn("database already has tables without __drizzle_migrations; skipping auto-migration")
		} else if migRes.Applied > 0 {
			dbLogger.Info("applied pending database migrations",
				"applied", migRes.Applied,
				"backup", migRes.BackupPath,
				"durationMs", time.Since(migStart).Milliseconds(),
			)
		} else {
			dbLogger.Debug("database schema is up to date")
		}
	}

	if *migrateOnly {
		logger.Info("migrate-only complete; exiting")
		return
	}

	authSvc := auth.NewService(auth.ServiceOptions{
		DB:             opened.DB,
		Secret:         cfg.AuthSecret,
		BaseURL:        cfg.AuthURL,
		TrustedOrigins: cfg.TrustedOrigins,
		Logger:         rootLogger.With("component", "auth"),
	})

	settingsSvc := settings.NewService(settings.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      rootLogger.With("component", "settings"),
	})

	usersSvc := users.NewService(users.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      rootLogger.With("component", "users"),
	})

	booksSvc := books.NewService(books.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  cfg.LibraryDir,
		Logger:      rootLogger.With("component", "books"),
	})

	bookshelfSvc := bookshelf.NewService(bookshelf.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		TokenSecret: cfg.AuthSecret,
		Logger:      rootLogger.With("component", "bookshelf"),
	})

	spinesSvc := spines.NewService(spines.ServiceOptions{
		DB:           opened.DB,
		AuthService:  authSvc,
		AuthSecret:   cfg.AuthSecret,
		LibraryDir:   cfg.LibraryDir,
		CodexAuthURL: cfg.CodexAuthURL,
		CodexAPIURL:  cfg.CodexAPIURL,
		Logger:       rootLogger.With("component", "spines"),
	})

	adminSvc := admin.NewService(admin.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  cfg.LibraryDir,
		LogManager:  logMgr,
		Logger:      rootLogger.With("component", "admin"),
	})

	mcpSvc := mcp.NewService(mcp.ServiceOptions{
		DB:               opened.DB,
		AuthService:      authSvc,
		BooksService:     booksSvc,
		BookshelfService: bookshelfSvc,
		Logger:           rootLogger.With("component", "mcp"),
	})

	goodreadsSvc := goodreads.NewService(goodreads.ServiceOptions{
		DB:               opened.DB,
		AuthService:      authSvc,
		BooksService:     booksSvc,
		BookshelfService: bookshelfSvc,
		Logger:           rootLogger.With("component", "goodreads"),
	})

	recoveryGate := storage.StartRecovery(ctx, opened.DB, cfg.LibraryDir, rootLogger.With("component", "storage"))

	dropboxWatcher := dropbox.NewWatcher(dropbox.WatcherOptions{
		DB:         opened.DB,
		LibraryDir: cfg.LibraryDir,
		Logger:     rootLogger.With("component", "dropbox"),
	})
	dropboxWatcher.Start(ctx, recoveryGate)

	var upstream http.Handler
	var webFS fs.FS
	if cfg.UpstreamURL != "" {
		upstream, err = proxy.New(cfg.UpstreamURL, rootLogger.With("component", "proxy"))
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
		Logger:      rootLogger.With("component", "httpapi"),
		AuthService: authSvc,
		Services: []httpapi.RouteRegistrar{
			settingsSvc,
			usersSvc,
			booksSvc,
			bookshelfSvc,
			spinesSvc,
			adminSvc,
			mcpSvc,
			goodreadsSvc,
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
		logger.Info("Delb server listening",
			"version", resolveVersion(),
			"addr", cfg.ListenAddr(),
			"db", opened.FilePath,
			"logLevel", logMgr.LevelString(),
			"logFormat", string(cfg.LogFormat),
			"logDir", logDir,
			"production", cfg.IsProduction,
		)
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
		shutdownStart := time.Now()
		logger.Info("shutting down Delb server")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			logger.Error("graceful shutdown failed", "error", err)
			os.Exit(1)
		}
		dropboxWatcher.Wait()
		logger.Info("Delb server shutdown complete", "durationMs", time.Since(shutdownStart).Milliseconds())
	}
}
