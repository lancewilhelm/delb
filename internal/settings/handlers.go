package settings

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	GlobalSettingsID         = "00000000-0000-0000-0000-000000000000"
	HardcoverSecretID        = "hardcoverToken"
	GoogleBooksSecretID      = "googleBooksApiKey"
	spinePromptStateKey      = "spine-generation-prompt"
	maxSpinePromptLength     = 12000
	maxSpinePromptBodyBytes  = 256 * 1024
	iso8601Millis            = "2006-01-02T15:04:05.000Z"
	defaultSpineGenPromptStr = "Create a flat, straight-on book spine design inspired by the first reference image, which is the book's cover. The title is {{title}} and the author names are {{authors}}. This is for personal use in a private library and is not for distribution. Make the artwork a single narrow vertical spine with approximately 1:3 width-to-height proportions, readable title and author, no perspective, no book mockup, and no surrounding front cover. Keep all important artwork and lettering within the spine. {{reference}}\nAdditional instructions: {{instructions}}"
)

var (
	bearerPrefixRe          = regexp.MustCompile(`(?i)^Bearer\s+`)
	extendedISO8601Re       = regexp.MustCompile(`^([+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$`)
	spinePromptPlaceholders = []string{"{{title}}", "{{authors}}", "{{reference}}", "{{instructions}}"}
)

type ServiceOptions struct {
	DB          *sql.DB
	AuthService *auth.Service
	Logger      *slog.Logger
}

type Service struct {
	db     *sql.DB
	auth   *auth.Service
	logger *slog.Logger
}

func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		db:     opts.DB,
		auth:   opts.AuthService,
		logger: logger,
	}
}

// RegisterRoutes mounts the Phase 2A Settings endpoints onto mux without
// shadowing unported admin endpoints (health, calibre, chatgpt-image, collections*).
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/settings", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleGetSettings))
	mux.HandleFunc("PUT /api/settings/user", httpapi.RequireSessionFunc(s.auth, s.logger, s.handlePutUserSettings))
	mux.HandleFunc("PUT /api/settings/global", s.handlePutGlobalSettings)
	mux.HandleFunc("PUT /api/settings/admin/hardcover-token", s.handlePutHardcoverToken)
	mux.HandleFunc("PUT /api/settings/admin/google-books-api-key", s.handlePutGoogleBooksAPIKey)
	mux.HandleFunc("/api/settings/admin/spine-prompt", s.handleSpinePrompt)
}

type userSettingsRow struct {
	UserID    string `json:"userId"`
	Settings  any    `json:"settings"`
	UpdatedAt string `json:"updatedAt"`
}

type globalSettingsRow struct {
	ID        string         `json:"id"`
	Settings  map[string]any `json:"settings"`
	UpdatedAt string         `json:"updatedAt"`
}

type capabilitiesPayload struct {
	HardcoverAvailable          bool `json:"hardcoverAvailable"`
	GoogleBooksAPIKeyConfigured bool `json:"googleBooksApiKeyConfigured"`
}

func (s *Service) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	swu := httpapi.SessionFromContext(r.Context())
	userID := swu.User.ID

	userRow, err := s.readUserSettings(r.Context(), userID)
	if err != nil {
		s.logger.Error("GET /api/settings: failed to read user settings", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch settings")
		return
	}

	globalRow, err := s.readGlobalSettings(r.Context())
	if err != nil {
		s.logger.Error("GET /api/settings: failed to read global settings", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch settings")
		return
	}

	hardcoverAvail, err := s.hasHardcoverToken(r.Context())
	if err != nil {
		s.logger.Error("GET /api/settings: failed to read capabilities", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch settings")
		return
	}

	googleBooksKeyConfigured, err := s.hasGoogleBooksAPIKey(r.Context())
	if err != nil {
		s.logger.Error("GET /api/settings: failed to read capabilities", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch settings")
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"userSettings":   userRow,
			"globalSettings": globalRow,
			"capabilities": capabilitiesPayload{
				HardcoverAvailable:          hardcoverAvail,
				GoogleBooksAPIKeyConfigured: googleBooksKeyConfigured,
			},
		},
	})
}

func (s *Service) handlePutUserSettings(w http.ResponseWriter, r *http.Request) {
	swu := httpapi.SessionFromContext(r.Context())
	userID := swu.User.ID

	var body struct {
		Settings  *json.RawMessage `json:"settings"`
		UpdatedAt json.RawMessage  `json:"updatedAt"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if body.Settings == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing `settings`")
		return
	}

	var incomingVal any
	if err := json.Unmarshal(*body.Settings, &incomingVal); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid JSON request body")
		return
	}
	serialized, err := json.Marshal(incomingVal)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid settings payload")
		return
	}

	updatedAtMs := coerceDateMillis(body.UpdatedAt)

	var (
		retUserID      string
		retSettingsRaw string
		retUpdatedAtMs int64
	)
	err = s.db.QueryRowContext(r.Context(), `
		INSERT INTO user_settings (user_id, settings, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			settings = excluded.settings,
			updated_at = excluded.updated_at
		WHERE user_settings.user_id = ? AND user_settings.updated_at < ?
		RETURNING user_id, settings, updated_at
	`, userID, string(serialized), updatedAtMs, userID, updatedAtMs).Scan(&retUserID, &retSettingsRaw, &retUpdatedAtMs)

	if err == nil {
		var parsed any
		_ = json.Unmarshal([]byte(retSettingsRaw), &parsed)
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success":  true,
			"accepted": true,
			"data": &userSettingsRow{
				UserID:    retUserID,
				Settings:  parsed,
				UpdatedAt: formatMillis(retUpdatedAtMs),
			},
		})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		s.logger.Error("PUT /api/settings/user: upsert failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	// Conflict where stored updated_at >= updatedAtMs: read current row and
	// acknowledge if timestamp and JSON payload match identically.
	storedRow, storedMs, err := s.readUserSettingsWithMs(r.Context(), userID)
	if err != nil {
		s.logger.Error("PUT /api/settings/user: read current failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	matches := storedRow != nil && storedMs == updatedAtMs && reflect.DeepEqual(storedRow.Settings, incomingVal)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"accepted": matches,
		"data":     storedRow,
	})
}

func (s *Service) handlePutGlobalSettings(w http.ResponseWriter, r *http.Request) {
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("PUT /api/settings/global: session lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if swu.User.Role != "admin" && swu.User.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Forbidden")
		return
	}

	var body struct {
		Settings *json.RawMessage `json:"settings"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if body.Settings == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing `settings` in request body")
		return
	}

	// Match Nitro: non-object settings coerce to empty object `{}`.
	incoming := map[string]any{}
	var decoded any
	if err := json.Unmarshal(*body.Settings, &decoded); err == nil {
		if m, ok := decoded.(map[string]any); ok {
			incoming = m
		}
	}
	serialized, err := json.Marshal(incoming)
	if err != nil {
		s.logger.Error("PUT /api/settings/global: marshal failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	now := time.Now().UTC()
	_, err = s.db.ExecContext(r.Context(), `
		INSERT INTO global_settings (user_id, settings, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			settings = excluded.settings,
			updated_at = excluded.updated_at
	`, GlobalSettingsID, string(serialized), now.Unix())
	if err != nil {
		s.logger.ErrorContext(r.Context(), "PUT /api/settings/global: upsert failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	keys := make([]string, 0, len(incoming))
	for k := range incoming {
		keys = append(keys, k)
	}
	s.logger.InfoContext(r.Context(), "admin updated global settings",
		"actorUserId", swu.User.ID,
		"keys", keys,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"updatedAt": now.Format(iso8601Millis),
		},
	})
}

func (s *Service) handlePutHardcoverToken(w http.ResponseWriter, r *http.Request) {
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("PUT /api/settings/admin/hardcover-token: session lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if swu.User.Role != "admin" && swu.User.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Forbidden")
		return
	}

	var body struct {
		Token json.RawMessage `json:"token"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var tokenRaw string
	if len(body.Token) == 0 || string(body.Token) == "null" || json.Unmarshal(body.Token, &tokenRaw) != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing or invalid `token` (string) in body")
		return
	}

	normalized := normalizeHardcoverToken(tokenRaw)
	now := time.Now().UTC().Unix()
	_, err = s.db.ExecContext(r.Context(), `
		INSERT INTO global_secrets (id, value, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			value = excluded.value,
			updated_at = excluded.updated_at
	`, HardcoverSecretID, normalized, now)
	if err != nil {
		s.logger.ErrorContext(r.Context(), "PUT /api/settings/admin/hardcover-token: upsert failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	cleared := strings.TrimSpace(tokenRaw) == ""
	s.logger.InfoContext(r.Context(), "admin updated hardcover api token",
		"actorUserId", swu.User.ID,
		"cleared", cleared,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]bool{
			"cleared": cleared,
		},
	})
}

func (s *Service) handlePutGoogleBooksAPIKey(w http.ResponseWriter, r *http.Request) {
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.ErrorContext(r.Context(), "PUT /api/settings/admin/google-books-api-key: session lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if swu.User.Role != "admin" && swu.User.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Forbidden")
		return
	}

	var body struct {
		APIKey json.RawMessage `json:"apiKey"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var apiKeyRaw string
	if len(body.APIKey) == 0 || string(body.APIKey) == "null" || json.Unmarshal(body.APIKey, &apiKeyRaw) != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing or invalid `apiKey` (string) in body")
		return
	}

	normalized := strings.TrimSpace(apiKeyRaw)
	if normalized == "" {
		_, err = s.db.ExecContext(r.Context(), `
			DELETE FROM global_secrets WHERE id = ?
		`, GoogleBooksSecretID)
	} else {
		now := time.Now().UTC().Unix()
		_, err = s.db.ExecContext(r.Context(), `
			INSERT INTO global_secrets (id, value, updated_at)
			VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				value = excluded.value,
				updated_at = excluded.updated_at
		`, GoogleBooksSecretID, normalized, now)
	}
	if err != nil {
		s.logger.ErrorContext(r.Context(), "PUT /api/settings/admin/google-books-api-key: update failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	cleared := normalized == ""
	s.logger.InfoContext(r.Context(), "admin updated google books api key",
		"actorUserId", swu.User.ID,
		"cleared", cleared,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]bool{
			"cleared": cleared,
		},
	})
}

func (s *Service) handleSpinePrompt(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		secFetchSite := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))
		if secFetchSite == "cross-site" || secFetchSite == "same-site" {
			httpapi.WriteError(w, http.StatusForbidden, "Cross-site requests are not allowed.")
			return
		}
	}

	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("spine-prompt: session lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Sign in to Delb first.")
		return
	}
	if swu.User.Role != "admin" && swu.User.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Administrator access required")
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")

	if r.Method == http.MethodGet {
		resp, err := s.readSpineGenerationPrompt(r.Context())
		if err != nil {
			s.logger.Error("GET /api/settings/admin/spine-prompt: read failed", "error", err)
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, resp)
		return
	}

	if r.Method != http.MethodPut {
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return
	}

	raw, err := httpapi.ReadBodyBounded(r, maxSpinePromptBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Enter a prompt of at most 12,000 characters containing all four required placeholders.")
		return
	}

	promptRaw, hasPrompt := fields["prompt"]
	prevRaw, hasPrev := fields["previous"]
	if !hasPrompt || !hasPrev {
		httpapi.WriteError(w, http.StatusBadRequest, "Enter a prompt of at most 12,000 characters containing all four required placeholders.")
		return
	}

	var promptStr string
	if json.Unmarshal(promptRaw, &promptStr) != nil || !validSpineGenerationPrompt(promptStr) {
		httpapi.WriteError(w, http.StatusBadRequest, "Enter a prompt of at most 12,000 characters containing all four required placeholders.")
		return
	}

	var previous *string
	if strings.TrimSpace(string(prevRaw)) != "null" {
		var prevStr string
		if json.Unmarshal(prevRaw, &prevStr) != nil || utf16Len(prevStr) > maxSpinePromptLength {
			httpapi.WriteError(w, http.StatusBadRequest, "Enter a prompt of at most 12,000 characters containing all four required placeholders.")
			return
		}
		previous = &prevStr
	}

	// Re-verify session and admin role after reading body, matching Nitro.
	current, err := s.auth.Authenticate(nil, r)
	if err != nil {
		s.logger.Error("PUT /api/settings/admin/spine-prompt: session re-check failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if current == nil || current.Session.ID != swu.Session.ID {
		httpapi.WriteError(w, http.StatusUnauthorized, "Your session expired.")
		return
	}
	if current.User.Role != "admin" && current.User.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Administrator access required")
		return
	}

	saved, err := s.saveSpineGenerationPrompt(r.Context(), promptStr, previous)
	if err != nil {
		s.logger.Error("PUT /api/settings/admin/spine-prompt: save failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if !saved {
		httpapi.WriteError(w, http.StatusConflict, "The prompt changed since you opened it. Reload before saving.")
		return
	}

	s.logger.InfoContext(r.Context(), "admin updated spine generation prompt",
		"actorUserId", swu.User.ID,
		"promptLength", len(promptStr),
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"prompt":        promptStr,
		"savedPrompt":   promptStr,
		"defaultPrompt": defaultSpineGenPromptStr,
	})
}

func (s *Service) readUserSettings(ctx context.Context, userID string) (*userSettingsRow, error) {
	row, _, err := s.readUserSettingsWithMs(ctx, userID)
	return row, err
}

func (s *Service) readUserSettingsWithMs(ctx context.Context, userID string) (*userSettingsRow, int64, error) {
	var (
		uid       string
		raw       string
		updatedMs int64
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT user_id, settings, updated_at
		FROM user_settings
		WHERE user_id = ?
		LIMIT 1
	`, userID).Scan(&uid, &raw, &updatedMs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	var parsed any
	if unmarshalErr := json.Unmarshal([]byte(raw), &parsed); unmarshalErr != nil {
		parsed = map[string]any{}
	}
	return &userSettingsRow{
		UserID:    uid,
		Settings:  parsed,
		UpdatedAt: formatMillis(updatedMs),
	}, updatedMs, nil
}

func (s *Service) readGlobalSettings(ctx context.Context) (*globalSettingsRow, error) {
	var (
		id        string
		raw       string
		updatedAt int64
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT user_id, settings, updated_at
		FROM global_settings
		WHERE user_id = ?
		LIMIT 1
	`, GlobalSettingsID).Scan(&id, &raw, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	settingsMap := map[string]any{}
	var decoded any
	if json.Unmarshal([]byte(raw), &decoded) == nil {
		if m, ok := decoded.(map[string]any); ok {
			settingsMap = m
		}
	}
	return &globalSettingsRow{
		ID:        id,
		Settings:  settingsMap,
		UpdatedAt: formatUnixAuto(updatedAt),
	}, nil
}

func (s *Service) hasHardcoverToken(ctx context.Context) (bool, error) {
	var val string
	err := s.db.QueryRowContext(ctx, `
		SELECT value FROM global_secrets WHERE id = ? LIMIT 1
	`, HardcoverSecretID).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return normalizeHardcoverToken(val) != "", nil
}

func (s *Service) hasGoogleBooksAPIKey(ctx context.Context) (bool, error) {
	var val string
	err := s.db.QueryRowContext(ctx, `
		SELECT value FROM global_secrets WHERE id = ? LIMIT 1
	`, GoogleBooksSecretID).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(val) != "", nil
}

func (s *Service) readSpineGenerationPrompt(ctx context.Context) (map[string]any, error) {
	var val string
	err := s.db.QueryRowContext(ctx, `
		SELECT value FROM system_state WHERE key = ? LIMIT 1
	`, spinePromptStateKey).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{
			"prompt":        defaultSpineGenPromptStr,
			"savedPrompt":   nil,
			"defaultPrompt": defaultSpineGenPromptStr,
		}, nil
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"prompt":        val,
		"savedPrompt":   val,
		"defaultPrompt": defaultSpineGenPromptStr,
	}, nil
}

func (s *Service) saveSpineGenerationPrompt(ctx context.Context, prompt string, previous *string) (bool, error) {
	if previous == nil {
		res, err := s.db.ExecContext(ctx, `
			INSERT INTO system_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING
		`, spinePromptStateKey, prompt)
		if err != nil {
			return false, err
		}
		n, _ := res.RowsAffected()
		return n > 0, nil
	}
	res, err := s.db.ExecContext(ctx, `
		UPDATE system_state SET value = ? WHERE key = ? AND value = ?
	`, prompt, spinePromptStateKey, *previous)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func normalizeHardcoverToken(raw string) string {
	return bearerPrefixRe.ReplaceAllString(strings.TrimSpace(raw), "")
}

func validSpineGenerationPrompt(v string) bool {
	if strings.TrimSpace(v) == "" || utf16Len(v) > maxSpinePromptLength {
		return false
	}
	for _, placeholder := range spinePromptPlaceholders {
		if !strings.Contains(v, placeholder) {
			return false
		}
	}
	return true
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func coerceDateMillis(raw json.RawMessage) int64 {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return time.Now().UTC().UnixMilli()
	}
	var num float64
	if json.Unmarshal(raw, &num) == nil && !math.IsNaN(num) && !math.IsInf(num, 0) {
		return int64(math.Trunc(num))
	}
	var str string
	if json.Unmarshal(raw, &str) == nil {
		str = strings.TrimSpace(str)
		if ms, ok := parseExtendedISO8601Millis(str); ok {
			return ms
		}
		layouts := []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02T15:04:05.000Z",
			"2006-01-02T15:04:05Z",
			"2006-01-02",
			time.RFC1123,
			time.RFC1123Z,
			http.TimeFormat,
		}
		for _, layout := range layouts {
			if parsed, err := time.Parse(layout, str); err == nil {
				return parsed.UTC().UnixMilli()
			}
		}
	}
	return time.Now().UTC().UnixMilli()
}

// parseExtendedISO8601Millis parses ECMA-262 expanded-year ISO-8601 timestamps
// such as "+058814-08-02T21:49:22.374Z" that Go's time.Parse cannot parse.
func parseExtendedISO8601Millis(s string) (int64, bool) {
	m := extendedISO8601Re.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	year, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, false
	}
	month, _ := strconv.Atoi(m[2])
	day, _ := strconv.Atoi(m[3])
	hour, _ := strconv.Atoi(m[4])
	minute, _ := strconv.Atoi(m[5])
	sec, _ := strconv.Atoi(m[6])
	if month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || sec > 59 {
		return 0, false
	}
	nsec := 0
	if frac := m[7]; frac != "" {
		padded := frac + strings.Repeat("0", 9-len(frac))
		nsec, _ = strconv.Atoi(padded)
	}
	loc := time.UTC
	if tz := m[8]; tz != "Z" {
		tzSign := 1
		if tz[0] == '-' {
			tzSign = -1
		}
		tzH, _ := strconv.Atoi(tz[1:3])
		tzM, _ := strconv.Atoi(tz[4:6])
		loc = time.FixedZone("", tzSign*(tzH*3600+tzM*60))
	}
	t := time.Date(year, time.Month(month), day, hour, minute, sec, nsec, loc)
	return t.UTC().UnixMilli(), true
}

// formatMillis formats Unix milliseconds matching ECMA-262 Date.prototype.toISOString(),
// including 6-digit signed expanded years (+YYYYYY / -YYYYYY) for years outside 0000..9999.
func formatMillis(ms int64) string {
	t := time.UnixMilli(ms).UTC()
	y := t.Year()
	milli := t.Nanosecond() / 1_000_000
	if y >= 0 && y <= 9999 {
		return fmt.Sprintf("%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
			y, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), milli)
	}
	if y < 0 {
		return fmt.Sprintf("-%06d-%02d-%02dT%02d:%02d:%02d.%03dZ",
			-y, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), milli)
	}
	return fmt.Sprintf("+%06d-%02d-%02dT%02d:%02d:%02d.%03dZ",
		y, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), milli)
}

func formatUnixAuto(ts int64) string {
	if ts > 1_000_000_000_000 {
		return formatMillis(ts)
	}
	return formatMillis(ts * 1000)
}
