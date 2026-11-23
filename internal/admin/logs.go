package admin

import (
	"bytes"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/logging"
)

func parseLogQueryFromRequest(r *http.Request) (logging.QueryOptions, error) {
	q := r.URL.Query()
	opts := logging.QueryOptions{
		Level:     strings.TrimSpace(q.Get("level")),
		MinLevel:  strings.TrimSpace(q.Get("minLevel")),
		Component: strings.TrimSpace(q.Get("component")),
		RequestID: strings.TrimSpace(q.Get("requestId")),
		Query:     strings.TrimSpace(q.Get("q")),
		Order:     strings.TrimSpace(q.Get("order")),
	}

	if opts.Level != "" {
		if _, err := logging.ParseLevel(opts.Level); err != nil {
			return opts, httpapi.NewError(http.StatusBadRequest, "Invalid level filter")
		}
	}
	if opts.MinLevel != "" {
		if _, err := logging.ParseLevel(opts.MinLevel); err != nil {
			return opts, httpapi.NewError(http.StatusBadRequest, "Invalid minLevel filter")
		}
	}
	if rawSince := strings.TrimSpace(q.Get("since")); rawSince != "" {
		t, err := parseQueryTimestamp(rawSince)
		if err != nil {
			return opts, httpapi.NewError(http.StatusBadRequest, "Invalid since timestamp")
		}
		opts.Since = t
	}
	if rawUntil := strings.TrimSpace(q.Get("until")); rawUntil != "" {
		t, err := parseQueryTimestamp(rawUntil)
		if err != nil {
			return opts, httpapi.NewError(http.StatusBadRequest, "Invalid until timestamp")
		}
		opts.Until = t
	}
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		n, err := strconv.Atoi(rawLimit)
		if err != nil || n < 1 {
			return opts, httpapi.NewError(http.StatusBadRequest, "Invalid limit")
		}
		opts.Limit = n
	}
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		n, err := strconv.Atoi(rawOffset)
		if err != nil || n < 0 {
			return opts, httpapi.NewError(http.StatusBadRequest, "Invalid offset")
		}
		opts.Offset = n
	}
	return opts, nil
}

func parseQueryTimestamp(raw string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		iso8601Millis,
		"2006-01-02T15:04:05Z",
		"2006-01-02",
	}
	for _, layout := range layouts {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unrecognized timestamp %q", raw)
}

// GET /api/settings/admin/logs
func (s *Service) handleAdminLogs(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdminOrOwner(w, r); !ok {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")

	if s.logs == nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "Log manager is not configured")
		return
	}

	opts, err := parseLogQueryFromRequest(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	result, err := s.logs.Query(opts)
	if err != nil {
		s.logger.ErrorContext(r.Context(), "failed to query system logs", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to query system logs")
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    result,
	})
}

// PUT /api/settings/admin/logs/level
func (s *Service) handleAdminLogsLevel(w http.ResponseWriter, r *http.Request) {
	secFetchSite := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))
	if secFetchSite == "cross-site" || secFetchSite == "same-site" {
		httpapi.WriteError(w, http.StatusForbidden, "Cross-site requests are not allowed.")
		return
	}

	swu, ok := s.requireAdminOrOwner(w, r)
	if !ok {
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")

	if s.logs == nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "Log manager is not configured")
		return
	}

	var body struct {
		Level string `json:"level"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, false); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	prevLevel := s.logs.Level()
	prevStr := logging.LevelToString(prevLevel)
	nextLevel, err := logging.ParseLevel(body.Level)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Log level must be one of: debug, info, warn, error")
		return
	}
	nextStr := logging.LevelToString(nextLevel)

	// Log at INFO/WARN before raising verbosity threshold or after lowering it so
	// the runtime level change is always recorded in the audit log.
	if nextLevel > prevLevel {
		s.logger.InfoContext(r.Context(), "runtime log level updated",
			"actorUserId", swu.User.ID,
			"previousLevel", prevStr,
			"level", nextStr,
		)
		s.logs.SetLevel(nextLevel)
	} else {
		s.logs.SetLevel(nextLevel)
		s.logger.InfoContext(r.Context(), "runtime log level updated",
			"actorUserId", swu.User.ID,
			"previousLevel", prevStr,
			"level", nextStr,
		)
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"level":         nextStr,
			"previousLevel": prevStr,
		},
	})
}

// GET /api/settings/admin/logs/download
func (s *Service) handleAdminLogsDownload(w http.ResponseWriter, r *http.Request) {
	swu, ok := s.requireAdminOrOwner(w, r)
	if !ok {
		return
	}

	if s.logs == nil {
		httpapi.WriteError(w, http.StatusServiceUnavailable, "Log manager is not configured")
		return
	}

	q := r.URL.Query()
	formatRaw := strings.ToLower(strings.TrimSpace(q.Get("format")))
	var format logging.ExportFormat
	var ext, contentType string
	switch formatRaw {
	case "", "text", "log", "txt":
		format = logging.ExportFormatText
		ext = "log"
		contentType = "text/plain; charset=utf-8"
	case "jsonl", "ndjson":
		format = logging.ExportFormatJSONL
		ext = "jsonl"
		contentType = "application/x-ndjson; charset=utf-8"
	default:
		httpapi.WriteError(w, http.StatusBadRequest, "Format must be text or jsonl")
		return
	}

	scopeRaw := strings.ToLower(strings.TrimSpace(q.Get("scope")))
	var scope logging.ExportScope
	switch scopeRaw {
	case "", "all":
		scope = logging.ExportScopeAll
	case "filtered":
		scope = logging.ExportScopeFiltered
	default:
		httpapi.WriteError(w, http.StatusBadRequest, "Scope must be all or filtered")
		return
	}

	opts, err := parseLogQueryFromRequest(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if opts.Order == "" {
		opts.Order = "asc"
	}

	var buf bytes.Buffer
	if err := s.logs.Export(&buf, format, opts, scope); err != nil {
		s.logger.ErrorContext(r.Context(), "failed to export system logs", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to export system logs")
		return
	}

	filename := fmt.Sprintf("delb-logs-%s.%s", time.Now().UTC().Format("20060102-150405"), ext)
	s.logger.InfoContext(r.Context(), "admin downloaded system logs",
		"actorUserId", swu.User.ID,
		"format", string(format),
		"scope", string(scope),
		"bytes", buf.Len(),
	)

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buf.Bytes())
}
