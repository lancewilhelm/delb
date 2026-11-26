package users

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/httpapi"
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

func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("DELETE /api/users/delete", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleDeleteUser))
	mux.HandleFunc("GET /api/settings/admin/users/{id}/tag-rules", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleGetTagRules))
	mux.HandleFunc("PUT /api/settings/admin/users/{id}/tag-rules", httpapi.RequireSessionFunc(s.auth, s.logger, s.handlePutTagRules))
}

func (s *Service) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User

	var body struct {
		ID json.RawMessage `json:"id"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var targetID string
	if len(body.ID) == 0 || string(body.ID) == "null" || json.Unmarshal(body.ID, &targetID) != nil || strings.TrimSpace(targetID) == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "User id is required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.logger.Error("DELETE /api/users/delete: begin tx failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	defer func() { _ = tx.Rollback() }()

	var actorRole string
	err = tx.QueryRowContext(r.Context(), `SELECT role FROM users WHERE id = ? LIMIT 1`, actor.ID).Scan(&actorRole)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && actorRole != "admin" && actorRole != "owner") {
		httpapi.WriteError(w, http.StatusForbidden, "Administrator access required")
		return
	}
	if err != nil {
		s.logger.Error("DELETE /api/users/delete: actor lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	var targetRole string
	err = tx.QueryRowContext(r.Context(), `SELECT role FROM users WHERE id = ? LIMIT 1`, targetID).Scan(&targetRole)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.logger.Error("DELETE /api/users/delete: target lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if err == nil && targetRole == "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "The system owner cannot be removed")
		return
	}

	res, err := tx.ExecContext(r.Context(), `DELETE FROM users WHERE id = ?`, targetID)
	if err != nil {
		s.logger.Error("DELETE /api/users/delete: delete failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "User not found")
		return
	}

	if err := tx.Commit(); err != nil {
		s.logger.ErrorContext(r.Context(), "DELETE /api/users/delete: commit failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	s.logger.InfoContext(r.Context(), "admin deleted user",
		"actorUserId", actor.ID,
		"targetUserId", targetID,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"success": true})
}
