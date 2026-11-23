package logging

import (
	"fmt"
	"log/slog"
	"strings"
	"time"
)

// Format controls stdout log encoding.
type Format string

const (
	FormatText Format = "text"
	FormatJSON Format = "json"
)

// ExportFormat controls log download encoding.
type ExportFormat string

const (
	ExportFormatText  ExportFormat = "text"
	ExportFormatJSONL ExportFormat = "jsonl"
)

// ExportScope controls whether exports contain all logs or only filtered entries.
type ExportScope string

const (
	ExportScopeAll      ExportScope = "all"
	ExportScopeFiltered ExportScope = "filtered"
)

const (
	DefaultMaxFileBytes   int64 = 5 * 1024 * 1024  // 5 MiB per file
	DefaultMaxFiles       int   = 5                // up to 5 files (active + 4 rotated)
	DefaultMaxTotalBytes  int64 = 25 * 1024 * 1024 // 25 MiB total cap
	DefaultMemoryCapacity int   = 2000             // in-memory ring buffer entries
	DefaultQueryLimit     int   = 200
	MaxQueryLimit         int   = 1000
)

// Entry is a single structured log record persisted as JSONL and returned by the admin API.
type Entry struct {
	ID        uint64         `json:"id"`
	Time      time.Time      `json:"time"`
	Level     string         `json:"level"`
	Message   string         `json:"message"`
	Component string         `json:"component,omitempty"`
	RequestID string         `json:"requestId,omitempty"`
	Attrs     map[string]any `json:"attrs,omitempty"`
}

// StorageInfo summarizes log persistence and in-memory buffer status.
type StorageInfo struct {
	Enabled        bool   `json:"enabled"`
	Dir            string `json:"dir,omitempty"`
	FileCount      int    `json:"fileCount"`
	TotalBytes     int64  `json:"totalBytes"`
	MaxFileBytes   int64  `json:"maxFileBytes"`
	MaxFiles       int    `json:"maxFiles"`
	MaxTotalBytes  int64  `json:"maxTotalBytes"`
	MemoryEntries  int    `json:"memoryEntries"`
	MemoryCapacity int    `json:"memoryCapacity"`
}

// QueryOptions filters and paginates structured log entries.
type QueryOptions struct {
	Level     string
	MinLevel  string
	Component string
	RequestID string
	Query     string
	Since     time.Time
	Until     time.Time
	Limit     int
	Offset    int
	Order     string // "desc" (default) or "asc"
}

// QueryResult is the structured response for querying logs.
type QueryResult struct {
	Entries    []Entry     `json:"entries"`
	Total      int         `json:"total"`
	HasMore    bool        `json:"hasMore"`
	Limit      int         `json:"limit"`
	Offset     int         `json:"offset"`
	Components []string    `json:"components"`
	Level      string      `json:"level"`
	Storage    StorageInfo `json:"storage"`
}

// ParseLevel parses a log level string into slog.Level.
func ParseLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug", "trace":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error", "fatal":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, fmt.Errorf("invalid log level %q (expected debug, info, warn, or error)", raw)
	}
}

// LevelToString converts a slog.Level into a canonical lowercase level name.
func LevelToString(level slog.Level) string {
	switch {
	case level < slog.LevelInfo:
		return "debug"
	case level < slog.LevelWarn:
		return "info"
	case level < slog.LevelError:
		return "warn"
	default:
		return "error"
	}
}

func levelRank(level string) int {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug":
		return 0
	case "info":
		return 1
	case "warn", "warning":
		return 2
	case "error", "fatal":
		return 3
	default:
		return -1
	}
}

// ParseFormat parses LOG_FORMAT into Format.
func ParseFormat(raw string) Format {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "json":
		return FormatJSON
	default:
		return FormatText
	}
}
