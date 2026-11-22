package dropbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const GlobalSettingsID = "00000000-0000-0000-0000-000000000000"

// Settings mirrors server/utils/books/dropbox/config.ts DropboxIngestSettings.
type Settings struct {
	Enabled                 any      `json:"enabled"`
	Dir                     string   `json:"dir"`
	Extensions              any      `json:"extensions"`
	PollIntervalMs          any      `json:"pollIntervalMs"`
	StablePassesRequired    any      `json:"stablePassesRequired"`
	StableMaxAgeMs          any      `json:"stableMaxAgeMs"`
	TargetCollectionID      string   `json:"targetCollectionId"`
	AdditionalCollectionIDs []string `json:"additionalCollectionIds"`
	TargetUserID            string   `json:"targetUserId"`
	TargetUserEmail         string   `json:"targetUserEmail"`
}

// Config is the resolved runtime configuration for the Dropbox ingest watcher.
type Config struct {
	Enabled              bool
	DropboxDirAbs        string
	DropboxDirRel        string
	FailedDirAbs         string
	PollInterval         time.Duration
	StablePassesRequired int
	StableMaxAge         time.Duration
	AllowedExtensions    map[string]struct{}
}

func defaultExtensions() []string {
	return []string{".epub", ".pdf", ".mobi", ".azw3"}
}

func parseBoolSetting(v any, fallback bool) bool {
	if v == nil {
		return fallback
	}
	switch val := v.(type) {
	case bool:
		return val
	case float64:
		if val == 1 {
			return true
		}
		if val == 0 {
			return false
		}
		return fallback
	case string:
		raw := strings.ToLower(strings.TrimSpace(val))
		switch raw {
		case "":
			return fallback
		case "1", "true", "yes", "on":
			return true
		case "0", "false", "no", "off":
			return false
		default:
			return fallback
		}
	default:
		return fallback
	}
}

func parseIntSetting(v any, fallback int) int {
	if v == nil {
		return fallback
	}
	switch val := v.(type) {
	case float64:
		n := int(val)
		if n > 0 {
			return n
		}
	case int:
		if val > 0 {
			return val
		}
	case int64:
		if val > 0 {
			return int(val)
		}
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(val)); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func parseExtensions(v any) map[string]struct{} {
	var parts []string
	switch val := v.(type) {
	case []any:
		for _, elem := range val {
			if s, ok := elem.(string); ok {
				if trimmed := strings.TrimSpace(s); trimmed != "" {
					parts = append(parts, trimmed)
				}
			}
		}
	case []string:
		for _, s := range val {
			if trimmed := strings.TrimSpace(s); trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
	case string:
		if trimmed := strings.TrimSpace(val); trimmed != "" {
			for _, p := range strings.Split(trimmed, ",") {
				if s := strings.TrimSpace(p); s != "" {
					parts = append(parts, s)
				}
			}
		}
	}
	if len(parts) == 0 {
		parts = defaultExtensions()
	}
	out := make(map[string]struct{}, len(parts))
	for _, p := range parts {
		if !strings.HasPrefix(p, ".") {
			p = "." + p
		}
		out[strings.ToLower(p)] = struct{}{}
	}
	return out
}

func readGlobalSettingsMap(ctx context.Context, db *sql.DB) map[string]any {
	var raw string
	err := db.QueryRowContext(ctx, `SELECT settings FROM global_settings WHERE user_id = ? LIMIT 1`, GlobalSettingsID).Scan(&raw)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return map[string]any{}
		}
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil || m == nil {
		return map[string]any{}
	}
	return m
}

func parseDropboxSettings(root map[string]any) Settings {
	if root == nil {
		return Settings{}
	}
	raw, ok := root["dropbox"]
	if !ok || raw == nil {
		return Settings{}
	}
	b, err := json.Marshal(raw)
	if err != nil {
		return Settings{}
	}
	var s Settings
	if err := json.Unmarshal(b, &s); err != nil {
		return Settings{}
	}
	return s
}

func resolveConfigFromSettings(baseDir string, root map[string]any) Config {
	s := parseDropboxSettings(root)
	enabled := parseBoolSetting(s.Enabled, true)

	rel := strings.TrimSpace(s.Dir)
	if rel == "" {
		rel = "dropbox"
	}
	if baseDir == "" {
		if cwd, err := os.Getwd(); err == nil {
			baseDir = cwd
		}
	}
	abs := rel
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(baseDir, rel)
	}
	if cleaned, err := filepath.Abs(abs); err == nil {
		abs = cleaned
	}

	pollMs := parseIntSetting(s.PollIntervalMs, 2500)
	stablePasses := parseIntSetting(s.StablePassesRequired, 2)
	maxAgeMs := parseIntSetting(s.StableMaxAgeMs, 5*60*1000)

	return Config{
		Enabled:              enabled,
		DropboxDirAbs:        abs,
		DropboxDirRel:        rel,
		FailedDirAbs:         filepath.Join(abs, "failed"),
		PollInterval:         time.Duration(pollMs) * time.Millisecond,
		StablePassesRequired: stablePasses,
		StableMaxAge:         time.Duration(maxAgeMs) * time.Millisecond,
		AllowedExtensions:    parseExtensions(s.Extensions),
	}
}
