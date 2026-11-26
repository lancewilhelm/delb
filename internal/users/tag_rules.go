package users

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
)

const maxTagRulesPerList = 500

type tagRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type tagRulesDTO struct {
	UserID    string   `json:"userId"`
	AllowTags []tagRef `json:"allowTags"`
	BlockTags []tagRef `json:"blockTags"`
}

func readTagRules(ctx context.Context, q library.Queryable, userID string) (tagRulesDTO, error) {
	out := tagRulesDTO{UserID: userID, AllowTags: []tagRef{}, BlockTags: []tagRef{}}
	rows, err := q.QueryContext(ctx, `
		SELECT r.mode, t.id, t.name
		FROM user_tag_rules r
		INNER JOIN tags t ON t.id = r.tag_id
		WHERE r.user_id = ?
		ORDER BY t.name COLLATE NOCASE, t.id
	`, userID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var mode string
		var ref tagRef
		if err := rows.Scan(&mode, &ref.ID, &ref.Name); err != nil {
			return out, err
		}
		if mode == library.RuleAllow {
			out.AllowTags = append(out.AllowTags, ref)
		} else {
			out.BlockTags = append(out.BlockTags, ref)
		}
	}
	return out, rows.Err()
}

// loadRuleTarget returns the target user's role, or an error response when the
// actor is not an administrator or the target does not exist.
func loadRuleTarget(ctx context.Context, q library.Queryable, actorID, targetID string) (string, error) {
	if err := library.RequireAdmin(ctx, q, actorID); err != nil {
		return "", err
	}
	role, err := library.UserRole(ctx, q, targetID)
	if err != nil {
		return "", err
	}
	if role == "" {
		return "", httpapi.NewError(http.StatusNotFound, "User not found")
	}
	return role, nil
}

// GET /api/settings/admin/users/{id}/tag-rules
func (s *Service) handleGetTagRules(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	targetID := strings.TrimSpace(r.PathValue("id"))
	if _, err := loadRuleTarget(r.Context(), s.db, actor.ID, targetID); err != nil {
		s.writeErr(w, "GET tag rules failed", err)
		return
	}
	rules, err := readTagRules(r.Context(), s.db, targetID)
	if err != nil {
		s.writeErr(w, "GET tag rules query failed", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": rules})
}

func cleanTagIDs(raw []string) ([]string, error) {
	if len(raw) > maxTagRulesPerList {
		return nil, httpapi.NewError(http.StatusBadRequest, "Too many tags in one rule list")
	}
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, id := range raw {
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, httpapi.NewError(http.StatusBadRequest, "Tag IDs must not be empty")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out, nil
}

// PUT /api/settings/admin/users/{id}/tag-rules
func (s *Service) handlePutTagRules(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	targetID := strings.TrimSpace(r.PathValue("id"))

	var body struct {
		AllowTagIDs *[]string `json:"allowTagIds"`
		BlockTagIDs *[]string `json:"blockTagIds"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, false); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if body.AllowTagIDs == nil || body.BlockTagIDs == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "allowTagIds and blockTagIds are required")
		return
	}
	allow, err := cleanTagIDs(*body.AllowTagIDs)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	block, err := cleanTagIDs(*body.BlockTagIDs)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	allowSet := make(map[string]struct{}, len(allow))
	for _, id := range allow {
		allowSet[id] = struct{}{}
	}
	for _, id := range block {
		if _, ok := allowSet[id]; ok {
			httpapi.WriteError(w, http.StatusBadRequest, "A tag cannot be both allowed and blocked")
			return
		}
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT tag rules begin failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	role, err := loadRuleTarget(r.Context(), tx, actor.ID, targetID)
	if err != nil {
		s.writeErr(w, "PUT tag rules auth failed", err)
		return
	}
	if library.IsAdminRole(role) && (len(allow) > 0 || len(block) > 0) {
		httpapi.WriteError(w, http.StatusConflict, "Tag visibility rules do not apply to administrators")
		return
	}

	for _, id := range append(append([]string{}, allow...), block...) {
		var found int
		err := tx.QueryRowContext(r.Context(), `SELECT 1 FROM tags WHERE id = ? LIMIT 1`, id).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			httpapi.WriteError(w, http.StatusBadRequest, "Unknown tag")
			return
		}
		if err != nil {
			s.writeErr(w, "PUT tag rules tag lookup failed", err)
			return
		}
	}

	if _, err := tx.ExecContext(r.Context(), `DELETE FROM user_tag_rules WHERE user_id = ?`, targetID); err != nil {
		s.writeErr(w, "PUT tag rules delete failed", err)
		return
	}
	now := time.Now().UTC().UnixMilli()
	insert := func(ids []string, mode string) error {
		for _, id := range ids {
			if _, err := tx.ExecContext(r.Context(), `
				INSERT INTO user_tag_rules (user_id, tag_id, mode, created_at) VALUES (?, ?, ?, ?)
			`, targetID, id, mode, now); err != nil {
				return err
			}
		}
		return nil
	}
	if err := insert(allow, library.RuleAllow); err != nil {
		s.writeErr(w, "PUT tag rules insert failed", err)
		return
	}
	if err := insert(block, library.RuleBlock); err != nil {
		s.writeErr(w, "PUT tag rules insert failed", err)
		return
	}
	rules, err := readTagRules(r.Context(), tx, targetID)
	if err != nil {
		s.writeErr(w, "PUT tag rules reload failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT tag rules commit failed", err)
		return
	}
	s.logger.Info("tag visibility rules updated",
		"actorUserId", actor.ID, "targetUserId", targetID,
		"allowCount", len(allow), "blockCount", len(block))
	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": rules})
}

func (s *Service) writeErr(w http.ResponseWriter, msg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(msg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}
