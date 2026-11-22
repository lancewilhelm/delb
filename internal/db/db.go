package db

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// OpenResult wraps an opened SQLite database and its normalized path metadata.
type OpenResult struct {
	DB       *sql.DB
	FilePath string
	IsMemory bool
}

// ParseDatabaseURL normalizes Drizzle/libSQL-style DATABASE_URL values such as
// "file:./data/delb.db", "file:///abs/path.db", ":memory:", or bare file paths.
func ParseDatabaseURL(raw string) (filePath string, isMemory bool, err error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		trimmed = "file:./data/delb.db"
	}

	if trimmed == ":memory:" || strings.HasPrefix(trimmed, "file::memory:") {
		return ":memory:", true, nil
	}

	if strings.HasPrefix(trimmed, "file:") {
		rest := strings.TrimPrefix(trimmed, "file:")
		// Strip query string if present (we attach our own pragmas cleanly).
		if idx := strings.IndexByte(rest, '?'); idx >= 0 {
			rest = rest[:idx]
		}
		if strings.HasPrefix(rest, "///") {
			// RFC 8089 file:///abs/path -> /abs/path
			u, parseErr := url.Parse(trimmed)
			if parseErr != nil {
				return "", false, fmt.Errorf("parse DATABASE_URL %q: %w", raw, parseErr)
			}
			rest = u.Path
		} else if strings.HasPrefix(rest, "//") {
			u, parseErr := url.Parse(trimmed)
			if parseErr != nil {
				return "", false, fmt.Errorf("parse DATABASE_URL %q: %w", raw, parseErr)
			}
			rest = u.Path
		}
		if rest == "" {
			return "", false, fmt.Errorf("empty path in DATABASE_URL %q", raw)
		}
		if rest == ":memory:" {
			return ":memory:", true, nil
		}
		return filepath.Clean(rest), false, nil
	}

	if strings.Contains(trimmed, "://") {
		return "", false, fmt.Errorf("unsupported DATABASE_URL scheme in %q (only local SQLite file: URLs are supported)", raw)
	}

	return filepath.Clean(trimmed), false, nil
}

// Open opens a pure-Go SQLite connection pool configured with WAL mode,
// foreign_keys=ON, busy_timeout=10000ms, and IMMEDIATE write transactions.
func Open(ctx context.Context, databaseURL string) (*OpenResult, error) {
	filePath, isMemory, err := ParseDatabaseURL(databaseURL)
	if err != nil {
		return nil, err
	}

	var dsn string
	if isMemory {
		dsn = "file::memory:?_pragma=foreign_keys(1)&_pragma=busy_timeout(10000)&_txlock=immediate"
	} else {
		dir := filepath.Dir(filePath)
		if dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("create database directory %q: %w", dir, err)
			}
		}
		absPath, err := filepath.Abs(filePath)
		if err != nil {
			return nil, fmt.Errorf("resolve database path %q: %w", filePath, err)
		}
		filePath = absPath
		q := url.Values{}
		q.Add("_pragma", "foreign_keys(1)")
		q.Add("_pragma", "busy_timeout(10000)")
		q.Add("_pragma", "journal_mode(WAL)")
		q.Add("_pragma", "synchronous(NORMAL)")
		q.Add("_txlock", "immediate")
		dsn = "file:" + filepath.ToSlash(absPath) + "?" + q.Encode()
	}

	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %q: %w", filePath, err)
	}

	if isMemory {
		// In-memory SQLite databases are per-connection unless shared cache is used.
		sqlDB.SetMaxOpenConns(1)
		sqlDB.SetMaxIdleConns(1)
	} else {
		sqlDB.SetMaxOpenConns(4)
		sqlDB.SetMaxIdleConns(4)
	}

	if err := sqlDB.PingContext(ctx); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("ping sqlite %q: %w", filePath, err)
	}

	// Verify pragmas took effect on the connection.
	if !isMemory {
		if _, err := sqlDB.ExecContext(ctx, "PRAGMA journal_mode = WAL"); err != nil {
			_ = sqlDB.Close()
			return nil, fmt.Errorf("enable WAL mode: %w", err)
		}
	}
	if _, err := sqlDB.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		_ = sqlDB.Close()
		return nil, fmt.Errorf("enable foreign_keys: %w", err)
	}

	return &OpenResult{
		DB:       sqlDB,
		FilePath: filePath,
		IsMemory: isMemory,
	}, nil
}
