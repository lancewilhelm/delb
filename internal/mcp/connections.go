package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
)

const maxConnectionBodyBytes int64 = 4096

var bearerTokenRe = regexp.MustCompile(`^Bearer delb_mcp_([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$`)

// Actor represents an authenticated MCP connection principal.
type Actor struct {
	UserID          string
	ConnectionID    string
	CanWrite        bool
	CanEditMetadata bool
}

// ConnectionInfo is the public metadata for an MCP connection (never includes token/digest).
type ConnectionInfo struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	CanWrite        bool   `json:"canWrite"`
	CanEditMetadata bool   `json:"canEditMetadata"`
	CreatedAt       string `json:"createdAt"`
	ExpiresAt       string `json:"expiresAt"`
}

// CreatedConnection includes the one-time plaintext bearer token on creation.
type CreatedConnection struct {
	ConnectionInfo
	Token string `json:"token"`
}

func requestOrigin(r *http.Request) string {
	scheme := "http"
	if proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); proto != "" {
		if idx := strings.IndexByte(proto, ','); idx >= 0 {
			proto = proto[:idx]
		}
		scheme = strings.ToLower(strings.TrimSpace(proto))
	} else if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if fwdHost := strings.TrimSpace(r.Header.Get("X-Forwarded-Host")); fwdHost != "" {
		if idx := strings.IndexByte(fwdHost, ','); idx >= 0 {
			fwdHost = fwdHost[:idx]
		}
		host = strings.TrimSpace(fwdHost)
	}
	return scheme + "://" + host
}

func formatMillisISO(ms int64) string {
	return time.UnixMilli(ms).UTC().Format(iso8601Millis)
}

func (s *Service) createConnection(ctx context.Context, userID, name string, canWrite, canEditMetadata bool) (*CreatedConnection, error) {
	id := uuid.NewString()
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, err
	}
	secret := base64.RawURLEncoding.EncodeToString(secretBytes)
	token := "delb_mcp_" + id + "." + secret
	now := time.Now().UTC()
	createdMs := now.UnixMilli()
	expiresMs := now.Add(365 * 24 * time.Hour).UnixMilli()
	sum := sha256.Sum256([]byte(secret))
	digest := hex.EncodeToString(sum[:])

	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO mcp_connections (id, user_id, name, digest, can_write, can_edit_metadata, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, id, userID, name, digest, boolToInt(canWrite), boolToInt(canEditMetadata), createdMs, expiresMs); err != nil {
		return nil, err
	}
	return &CreatedConnection{
		ConnectionInfo: ConnectionInfo{
			ID:              id,
			Name:            name,
			CanWrite:        canWrite,
			CanEditMetadata: canEditMetadata,
			CreatedAt:       formatMillisISO(createdMs),
			ExpiresAt:       formatMillisISO(expiresMs),
		},
		Token: token,
	}, nil
}

func (s *Service) listConnections(ctx context.Context, userID string) ([]ConnectionInfo, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, can_write, can_edit_metadata, created_at, expires_at
		FROM mcp_connections
		WHERE user_id = ?
	`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]ConnectionInfo, 0)
	for rows.Next() {
		var (
			id, name         string
			canW, canM       int64
			createdMs, expMs int64
		)
		if err := rows.Scan(&id, &name, &canW, &canM, &createdMs, &expMs); err != nil {
			return nil, err
		}
		out = append(out, ConnectionInfo{
			ID:              id,
			Name:            name,
			CanWrite:        canW != 0,
			CanEditMetadata: canM != 0,
			CreatedAt:       formatMillisISO(createdMs),
			ExpiresAt:       formatMillisISO(expMs),
		})
	}
	return out, rows.Err()
}

func (s *Service) revokeConnection(ctx context.Context, userID, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM mcp_connections WHERE id = ? AND user_id = ?`, id, userID)
	return err
}

func (s *Service) setMetadataPermission(ctx context.Context, userID, id string, canEditMetadata bool) error {
	res, err := s.db.ExecContext(ctx, `
		UPDATE mcp_connections SET can_edit_metadata = ? WHERE id = ? AND user_id = ?
	`, boolToInt(canEditMetadata), id, userID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return httpapi.NewError(http.StatusNotFound, "Connection not found.")
	}
	return nil
}

func (s *Service) authenticateConnection(ctx context.Context, authHeader string) (*Actor, error) {
	m := bearerTokenRe.FindStringSubmatch(authHeader)
	if m == nil {
		return nil, nil
	}
	connID := m[1]
	secret := m[2]

	var (
		userID          string
		digest          string
		canWrite        int64
		canEditMetadata int64
		expiresAtMs     int64
		banned          sql.NullInt64
		banExpiresSec   sql.NullInt64
	)
	err := s.db.QueryRowContext(ctx, `
		SELECT mc.user_id, mc.digest, mc.can_write, mc.can_edit_metadata, mc.expires_at, u.banned, u.ban_expires
		FROM mcp_connections mc
		INNER JOIN users u ON u.id = mc.user_id
		WHERE mc.id = ?
		LIMIT 1
	`, connID).Scan(&userID, &digest, &canWrite, &canEditMetadata, &expiresAtMs, &banned, &banExpiresSec)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	if expiresAtMs <= now.UnixMilli() {
		return nil, nil
	}
	if banned.Valid && banned.Int64 != 0 {
		if !banExpiresSec.Valid || banExpiresSec.Int64 > now.Unix() {
			return nil, nil
		}
	}

	expected, err := hex.DecodeString(digest)
	if err != nil {
		return nil, nil
	}
	actual := sha256.Sum256([]byte(secret))
	if len(expected) != len(actual) || subtle.ConstantTimeCompare(expected, actual[:]) != 1 {
		return nil, nil
	}

	return &Actor{
		UserID:          userID,
		ConnectionID:    connID,
		CanWrite:        canWrite != 0,
		CanEditMetadata: canEditMetadata != 0,
	}, nil
}

func authorizeWrite(ctx context.Context, q library.Queryable, actor *Actor, scope string) error {
	var (
		canWrite        int64
		canEditMetadata int64
		expiresAtMs     int64
		banned          sql.NullInt64
		banExpiresSec   sql.NullInt64
	)
	err := q.QueryRowContext(ctx, `
		SELECT mc.can_write, mc.can_edit_metadata, mc.expires_at, u.banned, u.ban_expires
		FROM mcp_connections mc
		INNER JOIN users u ON u.id = mc.user_id
		WHERE mc.id = ? AND mc.user_id = ?
		LIMIT 1
	`, actor.ConnectionID, actor.UserID).Scan(&canWrite, &canEditMetadata, &expiresAtMs, &banned, &banExpiresSec)
	if errors.Is(err, sql.ErrNoRows) {
		return httpapi.NewError(http.StatusForbidden, "Connection no longer permits changes.")
	}
	if err != nil {
		return err
	}

	permitted := canWrite != 0
	if scope == "metadata" {
		permitted = canEditMetadata != 0
	}
	now := time.Now().UTC()
	isBanned := banned.Valid && banned.Int64 != 0 && (!banExpiresSec.Valid || banExpiresSec.Int64 > now.Unix())
	if !permitted || expiresAtMs <= now.UnixMilli() || isBanned {
		return httpapi.NewError(http.StatusForbidden, "Connection no longer permits changes.")
	}
	return nil
}

// /api/mcp-connections mirrors server/api/mcp-connections/index.ts.
func (s *Service) handleConnections(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")

	if r.Method != http.MethodGet {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		sfs := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))
		if origin == "" || origin != requestOrigin(r) || sfs == "cross-site" || sfs == "same-site" {
			httpapi.WriteError(w, http.StatusForbidden, "Same-origin request required.")
			return
		}
	}

	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("/api/mcp-connections session lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil || (swu.Session.ImpersonatedBy != nil && *swu.Session.ImpersonatedBy != "") {
		httpapi.WriteError(w, http.StatusUnauthorized, "Sign in to manage connections.")
		return
	}

	if r.Method == http.MethodGet {
		conns, err := s.listConnections(r.Context(), swu.User.ID)
		if err != nil {
			s.logger.Error("GET /api/mcp-connections failed", "error", err)
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, conns)
		return
	}

	if r.Method != http.MethodPost && r.Method != http.MethodDelete && r.Method != http.MethodPatch {
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return
	}

	raw, err := httpapi.ReadBodyBounded(r, maxConnectionBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var body map[string]json.RawMessage
	if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &body) != nil || body == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid request.")
		return
	}

	switch r.Method {
	case http.MethodPatch:
		var id string
		var canEdit bool
		idRaw, hasID := body["id"]
		metaRaw, hasMeta := body["canEditMetadata"]
		if !hasID || !hasMeta || json.Unmarshal(idRaw, &id) != nil || len(utf16.Encode([]rune(id))) > 128 || json.Unmarshal(metaRaw, &canEdit) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid connection permission.")
			return
		}
		if err := s.setMetadataPermission(r.Context(), swu.User.ID, id, canEdit); err != nil {
			if httpapi.WriteHTTPError(w, err) {
				return
			}
			s.logger.ErrorContext(r.Context(), "PATCH /api/mcp-connections failed", "error", err)
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		s.logger.InfoContext(r.Context(), "mcp connection permissions updated",
			"userId", swu.User.ID,
			"connectionId", id,
			"canEditMetadata", canEdit,
		)
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})

	case http.MethodDelete:
		var id string
		idRaw, hasID := body["id"]
		if !hasID || json.Unmarshal(idRaw, &id) != nil || len(utf16.Encode([]rune(id))) > 128 {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid connection.")
			return
		}
		if err := s.revokeConnection(r.Context(), swu.User.ID, id); err != nil {
			s.logger.ErrorContext(r.Context(), "DELETE /api/mcp-connections failed", "error", err)
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		s.logger.InfoContext(r.Context(), "mcp connection revoked",
			"userId", swu.User.ID,
			"connectionId", id,
		)
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})

	case http.MethodPost:
		var name string
		var canWrite bool
		nameRaw, hasName := body["name"]
		writeRaw, hasWrite := body["canWrite"]
		if !hasName || !hasWrite || json.Unmarshal(nameRaw, &name) != nil || json.Unmarshal(writeRaw, &canWrite) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Enter a name and select access.")
			return
		}
		trimmedName := strings.TrimSpace(name)
		if trimmedName == "" || len(utf16.Encode([]rune(trimmedName))) > 80 {
			httpapi.WriteError(w, http.StatusBadRequest, "Enter a name and select access.")
			return
		}
		canEditMetadata := false
		if metaRaw, hasMeta := body["canEditMetadata"]; hasMeta {
			if json.Unmarshal(metaRaw, &canEditMetadata) != nil {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid metadata permission.")
				return
			}
		}
		created, err := s.createConnection(r.Context(), swu.User.ID, trimmedName, canWrite, canEditMetadata)
		if err != nil {
			s.logger.ErrorContext(r.Context(), "POST /api/mcp-connections failed", "error", err)
			httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
			return
		}
		s.logger.InfoContext(r.Context(), "mcp connection created",
			"userId", swu.User.ID,
			"connectionId", created.ID,
			"name", created.Name,
			"canWrite", created.CanWrite,
			"canEditMetadata", created.CanEditMetadata,
		)
		httpapi.WriteJSON(w, http.StatusOK, created)
	}
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
