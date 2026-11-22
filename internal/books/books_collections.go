package books

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

// GET /api/books/{id}/collections
func (s *Service) handleGetBookCollections(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	type colRow struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		OwnerUserID string `json:"ownerUserId"`
		IsDefault   bool   `json:"isDefault"`
		Role        string `json:"role"`
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT c.id, c.name, c.owner_user_id, c.is_default, cm.role
		FROM collection_books cb
		INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id AND cm.user_id = ?
		INNER JOIN collections c ON c.id = cb.collection_id
		WHERE cb.book_id = ?
	`, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/collections query failed", "Failed to fetch book collections", err)
		return
	}
	defer func() { _ = rows.Close() }()

	out := make([]colRow, 0)
	for rows.Next() {
		var c colRow
		var isDef int64
		if err := rows.Scan(&c.ID, &c.Name, &c.OwnerUserID, &isDef, &c.Role); err != nil {
			s.writeErrWithFallback(w, "GET /api/books/{id}/collections scan failed", "Failed to fetch book collections", err)
			return
		}
		c.IsDefault = isDef != 0
		if c.Role == "" {
			c.Role = "viewer"
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/collections rows err", "Failed to fetch book collections", err)
		return
	}

	if len(out) == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"collections": out},
	})
}

// PUT /api/books/{id}/collections
func (s *Service) handlePutBookCollections(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")

	var body struct {
		CollectionID       json.RawMessage `json:"collectionId"`
		SourceCollectionID json.RawMessage `json:"sourceCollectionId"`
		Confirmed          json.RawMessage `json:"confirmed"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var colID, srcColID string
	var confirmed bool
	if bookID == "" ||
		len(body.CollectionID) == 0 || string(body.CollectionID) == "null" || json.Unmarshal(body.CollectionID, &colID) != nil ||
		len(body.SourceCollectionID) == 0 || string(body.SourceCollectionID) == "null" || json.Unmarshal(body.SourceCollectionID, &srcColID) != nil ||
		json.Unmarshal(body.Confirmed, &confirmed) != nil || !confirmed {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose one destination and confirm the source collection access change")
		return
	}

	if _, err := collections.MoveCollectionBooks(r.Context(), s.db, userID, []string{bookID}, colID, srcColID); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/collections failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"collectionId": colID,
			"moved":        1,
		},
	})
}

// POST /api/books/move
func (s *Service) handleMoveBooks(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	var body struct {
		BookIDs            json.RawMessage `json:"bookIds"`
		TargetCollectionID json.RawMessage `json:"targetCollectionId"`
		ExpectedSources    json.RawMessage `json:"expectedSources"`
		Confirmed          json.RawMessage `json:"confirmed"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var rawIDs []json.RawMessage
	var targetID string
	var confirmed bool
	var rawSources []json.RawMessage

	if json.Unmarshal(body.BookIDs, &rawIDs) != nil || len(rawIDs) == 0 || len(rawIDs) > 10000 ||
		len(body.TargetCollectionID) == 0 || string(body.TargetCollectionID) == "null" || json.Unmarshal(body.TargetCollectionID, &targetID) != nil ||
		json.Unmarshal(body.Confirmed, &confirmed) != nil || !confirmed ||
		json.Unmarshal(body.ExpectedSources, &rawSources) != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose one destination and confirm the move")
		return
	}

	ids := make([]string, 0, len(rawIDs))
	for _, raw := range rawIDs {
		var id string
		if json.Unmarshal(raw, &id) != nil || strings.TrimSpace(id) == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose one destination and confirm the move")
			return
		}
		ids = append(ids, strings.TrimSpace(id))
	}
	ids = dedupeStrings(ids)

	expected := make(map[string]string, len(rawSources))
	for _, raw := range rawSources {
		var item map[string]json.RawMessage
		if json.Unmarshal(raw, &item) != nil || item == nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid source selection")
			return
		}
		var bID, cID string
		if json.Unmarshal(item["bookId"], &bID) != nil || json.Unmarshal(item["collectionId"], &cID) != nil ||
			len(item["bookId"]) == 0 || string(item["bookId"]) == "null" ||
			len(item["collectionId"]) == 0 || string(item["collectionId"]) == "null" {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid source selection")
			return
		}
		if _, dup := expected[bID]; dup {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid source selection")
			return
		}
		expected[bID] = cID
	}

	if len(expected) != len(ids) {
		httpapi.WriteError(w, http.StatusBadRequest, "Review the source selection again")
		return
	}
	for _, id := range ids {
		if _, ok := expected[id]; !ok {
			httpapi.WriteError(w, http.StatusBadRequest, "Review the source selection again")
			return
		}
	}

	moved, err := collections.MoveCollectionBooksWithExpected(r.Context(), s.db, userID, ids, targetID, expected)
	if err != nil {
		s.writeErr(w, "POST /api/books/move failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]int{"moved": moved},
	})
}

// POST /api/books/collection-sources
func (s *Service) handleBookCollectionSources(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	var body struct {
		BookIDs json.RawMessage `json:"bookIds"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var rawIDs []json.RawMessage
	if json.Unmarshal(body.BookIDs, &rawIDs) != nil || len(rawIDs) == 0 || len(rawIDs) > 10000 {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose books to move")
		return
	}
	ids := make([]string, 0, len(rawIDs))
	for _, raw := range rawIDs {
		var id string
		if json.Unmarshal(raw, &id) != nil || strings.TrimSpace(id) == "" {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose books to move")
			return
		}
		ids = append(ids, strings.TrimSpace(id))
	}
	ids = dedupeStrings(ids)

	type sourceRow struct {
		BookID       string `json:"bookId"`
		CollectionID string `json:"collectionId"`
		Name         string `json:"name"`
		Role         string `json:"role"`
	}

	args := make([]any, 0, len(ids)+1)
	args = append(args, userID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT b.id, b.collection_id, c.name, cm.role
		FROM books b
		INNER JOIN collections c ON c.id = b.collection_id
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id IN (`+makePlaceholders(len(ids))+`)
	`, args...)
	if err != nil {
		s.writeErr(w, "POST /api/books/collection-sources query failed", err)
		return
	}
	defer func() { _ = rows.Close() }()

	sources := make([]sourceRow, 0, len(ids))
	for rows.Next() {
		var sr sourceRow
		if err := rows.Scan(&sr.BookID, &sr.CollectionID, &sr.Name, &sr.Role); err != nil {
			s.writeErr(w, "POST /api/books/collection-sources scan failed", err)
			return
		}
		sources = append(sources, sr)
	}
	if err := rows.Err(); err != nil {
		s.writeErr(w, "POST /api/books/collection-sources rows err", err)
		return
	}
	if len(sources) != len(ids) {
		httpapi.WriteError(w, http.StatusNotFound, "One or more selected books are no longer accessible")
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"sources": sources},
	})
}

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
				SELECT 1 FROM collection_members cm
				WHERE cm.collection_id = books.collection_id
				  AND cm.user_id = ?
				  AND cm.role IN ('owner', 'editor')
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
