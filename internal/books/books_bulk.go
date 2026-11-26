package books

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
)

// POST /api/books/bulk/copies
func (s *Service) handleBulkCopies(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	raw, err := httpapi.ReadBodyBounded(r, httpapi.DefaultMaxBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(raw, &body); err != nil || body == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid copy update")
		return
	}

	var rawIDs []json.RawMessage
	if json.Unmarshal(body["bookIds"], &rawIDs) != nil || len(rawIDs) == 0 {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose books and at least one copy change")
		return
	}
	ids := make([]string, 0, len(rawIDs))
	for _, item := range rawIDs {
		var id string
		if json.Unmarshal(item, &id) != nil || strings.TrimSpace(id) == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose books and at least one copy change")
			return
		}
		ids = append(ids, id)
	}
	ids = dedupeStrings(ids)

	var physical *bool
	if rawPhys, exists := body["physical"]; exists {
		var b bool
		if json.Unmarshal(rawPhys, &b) != nil || strings.TrimSpace(string(rawPhys)) == "null" {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose books and at least one copy change")
			return
		}
		physical = &b
	}
	var audiobook *bool
	if rawAudio, exists := body["audiobook"]; exists {
		var b bool
		if json.Unmarshal(rawAudio, &b) != nil || strings.TrimSpace(string(rawAudio)) == "null" {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose books and at least one copy change")
			return
		}
		audiobook = &b
	}
	if physical == nil && audiobook == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose books and at least one copy change")
		return
	}

	setClauses := make([]string, 0, 2)
	baseArgs := make([]any, 0, 2)
	if physical != nil {
		v := 0
		if *physical {
			v = 1
		}
		setClauses = append(setClauses, "has_physical_copy = ?")
		baseArgs = append(baseArgs, v)
	}
	if audiobook != nil {
		v := 0
		if *audiobook {
			v = 1
		}
		setClauses = append(setClauses, "has_audiobook_copy = ?")
		baseArgs = append(baseArgs, v)
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "POST /api/books/bulk/copies begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := library.RequireCatalogEditor(r.Context(), tx, userID); err != nil {
		s.writeErr(w, "POST /api/books/bulk/copies auth failed", err)
		return
	}

	updated := 0
	for offset := 0; offset < len(ids); offset += 400 {
		end := offset + 400
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[offset:end]
		args := make([]any, 0, len(baseArgs)+len(chunk)+1)
		args = append(args, baseArgs...)
		for _, id := range chunk {
			args = append(args, id)
		}
		args = append(args, userID)

		res, err := tx.ExecContext(r.Context(), `
			UPDATE books
			SET `+strings.Join(setClauses, ", ")+`
			WHERE id IN (`+makePlaceholders(len(chunk))+`)
			  AND EXISTS (
				SELECT 1 FROM visible_books vb
				WHERE vb.book_id = books.id AND vb.user_id = ?
			  )
		`, args...)
		if err != nil {
			s.writeErr(w, "POST /api/books/bulk/copies update failed", err)
			return
		}
		n, _ := res.RowsAffected()
		updated += int(n)
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "POST /api/books/bulk/copies commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]int{
			"updated": updated,
			"skipped": len(ids) - updated,
		},
	})
}

// POST /api/books/bulk/status
func (s *Service) handleBulkStatus(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	var body map[string]json.RawMessage
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if body == nil {
		body = map[string]json.RawMessage{}
	}

	var bookIDs []string
	if rawIDs, exists := body["bookIds"]; exists && strings.TrimSpace(string(rawIDs)) != "null" {
		var items []json.RawMessage
		if json.Unmarshal(rawIDs, &items) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookIds list")
			return
		}
		for _, item := range items {
			var sVal string
			if json.Unmarshal(item, &sVal) != nil || strings.TrimSpace(string(item)) == "null" {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookIds list")
				return
			}
			if trimmed := strings.TrimSpace(sVal); trimmed != "" {
				bookIDs = append(bookIDs, trimmed)
			}
		}
		bookIDs = dedupeStrings(bookIDs)
	}

	var status *string
	if rawStatus, exists := body["status"]; exists {
		trimmed := strings.TrimSpace(string(rawStatus))
		if trimmed != "null" && trimmed != `""` {
			var sVal string
			if json.Unmarshal(rawStatus, &sVal) != nil {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid status (must be a string or null)")
				return
			}
			if sVal != "" {
				if !isValidBookStatus(sVal) {
					httpapi.WriteError(w, http.StatusBadRequest, "Invalid status. Expected one of: "+strings.Join(userBookStatuses, ", "))
					return
				}
				status = &sVal
			}
		}
	}

	if len(bookIDs) == 0 {
		httpapi.WriteError(w, http.StatusBadRequest, "Pick at least one book.")
		return
	}

	res, err := transitionBookStatuses(r.Context(), s.db, userID, bookIDs, statusChange{
		statusSet: true,
		status:    status,
	}, time.Now())
	if err != nil {
		s.writeErrWithFallback(w, "POST /api/books/bulk/status failed", "Failed to apply bulk status", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"requested":         len(bookIDs),
			"visible":           res.visible,
			"updated":           res.updated,
			"cleared":           res.cleared,
			"ignoredNotVisible": len(bookIDs) - res.visible,
			"status":            status,
		},
	})
}
