package bookshelf

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

const maxBookshelfBodyBytes int64 = 16 * 1024 * 1024

// GET /api/bookshelf
func (s *Service) handleGetUserBookshelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	w.Header().Set("Cache-Control", "private, no-store")

	var (
		revision int
		rawArr   string
	)
	err := s.db.QueryRowContext(r.Context(), `
		SELECT revision, arrangement FROM user_bookshelves WHERE user_id = ? LIMIT 1
	`, userID).Scan(&revision, &rawArr)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"revision":    0,
			"arrangement": nil,
		})
		return
	}
	if err != nil {
		s.writeErr(w, "GET /api/bookshelf failed", err)
		return
	}

	var parsed any
	if err := json.Unmarshal([]byte(rawArr), &parsed); err != nil {
		parsed = nil
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"revision":    revision,
		"arrangement": parsed,
	})
}

// PUT /api/bookshelf
func (s *Service) handlePutUserBookshelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	raw, err := httpapi.ReadBodyBounded(r, maxBookshelfBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookshelf revision")
		return
	}

	revRaw, hasRev := fields["revision"]
	arrRaw, hasArr := fields["arrangement"]
	rev, revOK := parseSafeNonNegInt(revRaw)
	if !hasRev || !hasArr || !revOK {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookshelf revision")
		return
	}

	arrangement := ParseBookshelfJSON(arrRaw)
	if arrangement == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookshelf arrangement")
		return
	}

	encoded, err := json.Marshal(arrangement)
	if err != nil {
		s.writeErr(w, "PUT /api/bookshelf marshal failed", err)
		return
	}

	nextRev := rev + 1
	var returnedRev int
	if rev == 0 {
		err = s.db.QueryRowContext(r.Context(), `
			INSERT INTO user_bookshelves (user_id, revision, arrangement)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id) DO NOTHING
			RETURNING revision
		`, userID, nextRev, string(encoded)).Scan(&returnedRev)
	} else {
		err = s.db.QueryRowContext(r.Context(), `
			UPDATE user_bookshelves
			SET revision = ?, arrangement = ?
			WHERE user_id = ? AND revision = ?
			RETURNING revision
		`, nextRev, string(encoded), userID, rev).Scan(&returnedRev)
	}
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusConflict, "A newer bookshelf arrangement exists")
		return
	}
	if err != nil {
		s.writeErr(w, "PUT /api/bookshelf save failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"revision": returnedRev,
	})
}
