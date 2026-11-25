package books

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

// MaxReviewLength is the longest review, in UTF-16 code units, that Delb stores.
const MaxReviewLength = 50000

// MaxNoteLength is the longest private note, in UTF-16 code units, that Delb stores.
const MaxNoteLength = 10000

// ReviewDTO is one reader's private review of a book.
type ReviewDTO struct {
	Text             string  `json:"text"`
	ContainsSpoilers bool    `json:"containsSpoilers"`
	CreatedAt        *string `json:"createdAt"`
	UpdatedAt        *string `json:"updatedAt"`
}

// NoteDTO is one private note that a reader keeps about a book.
type NoteDTO struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func readReview(ctx context.Context, q collections.Queryable, userID, bookID string) (ReviewDTO, error) {
	var text string
	var spoilers int64
	var createdAt, updatedAt int64
	err := q.QueryRowContext(ctx, `
		SELECT text, contains_spoilers, created_at, updated_at
		FROM user_book_reviews WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&text, &spoilers, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return ReviewDTO{}, nil
	}
	if err != nil {
		return ReviewDTO{}, err
	}
	c := formatUnixSecISO(createdAt)
	u := formatUnixSecISO(updatedAt)
	return ReviewDTO{Text: text, ContainsSpoilers: spoilers != 0, CreatedAt: &c, UpdatedAt: &u}, nil
}

// writeReview stores or clears (when text is blank) a reader's review.
func writeReview(ctx context.Context, q collections.Queryable, userID, bookID, text string, spoilers bool, now int64) error {
	if strings.TrimSpace(text) == "" {
		_, err := q.ExecContext(ctx, `DELETE FROM user_book_reviews WHERE user_id = ? AND book_id = ?`, userID, bookID)
		return err
	}
	spoilerInt := 0
	if spoilers {
		spoilerInt = 1
	}
	_, err := q.ExecContext(ctx, `
		INSERT INTO user_book_reviews (user_id, book_id, text, contains_spoilers, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, book_id) DO UPDATE SET
			text = excluded.text,
			contains_spoilers = excluded.contains_spoilers,
			updated_at = excluded.updated_at
	`, userID, bookID, text, spoilerInt, now, now)
	return err
}

// GET /api/books/{id}/review
func (s *Service) handleGetReview(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	if !s.requireVisibleBook(w, r, userID, bookID, "GET /api/books/{id}/review") {
		return
	}
	review, err := readReview(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/review query failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": review})
}

// PUT /api/books/{id}/review
func (s *Service) handlePutReview(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	invalid := "A review must be text of at most 50,000 characters."

	var body struct {
		Text             *string `json:"text"`
		ContainsSpoilers *bool   `json:"containsSpoilers"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil || body.Text == nil {
		httpapi.WriteError(w, http.StatusBadRequest, invalid)
		return
	}
	text := strings.TrimSpace(*body.Text)
	if utf16Len(text) > MaxReviewLength {
		httpapi.WriteError(w, http.StatusBadRequest, invalid)
		return
	}
	spoilers := body.ContainsSpoilers != nil && *body.ContainsSpoilers

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/review tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	visible, err := isBookVisibleToUser(r.Context(), tx, userID, bookID)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/review vis failed", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err := writeReview(r.Context(), tx, userID, bookID, text, spoilers, time.Now().UTC().Unix()); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/review write failed", err)
		return
	}
	review, err := readReview(r.Context(), tx, userID, bookID)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/review read failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/review commit failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": review})
}

func listNotes(ctx context.Context, db *sql.DB, userID, bookID string) ([]NoteDTO, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, text, created_at, updated_at
		FROM book_notes WHERE user_id = ? AND book_id = ?
		ORDER BY created_at ASC, id ASC
	`, userID, bookID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]NoteDTO, 0)
	for rows.Next() {
		var n NoteDTO
		var c, u int64
		if err := rows.Scan(&n.ID, &n.Text, &c, &u); err != nil {
			return nil, err
		}
		n.CreatedAt = formatUnixSecISO(c)
		n.UpdatedAt = formatUnixSecISO(u)
		out = append(out, n)
	}
	return out, rows.Err()
}

func parseNoteText(r *http.Request) (string, error) {
	invalid := httpapi.NewError(http.StatusBadRequest, "A note must be text of 1 to 10,000 characters.")
	var body struct {
		Text *string `json:"text"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil || body.Text == nil {
		return "", invalid
	}
	text := strings.TrimSpace(*body.Text)
	if text == "" || utf16Len(text) > MaxNoteLength {
		return "", invalid
	}
	return text, nil
}

func (s *Service) requireVisibleBook(w http.ResponseWriter, r *http.Request, userID, bookID, logPrefix string) bool {
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return false
	}
	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErr(w, logPrefix+" vis failed", err)
		return false
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return false
	}
	return true
}

// GET /api/books/{id}/notes
func (s *Service) handleListNotes(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	if !s.requireVisibleBook(w, r, userID, bookID, "GET /api/books/{id}/notes") {
		return
	}
	notes, err := listNotes(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/notes query failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": notes})
}

// POST /api/books/{id}/notes
func (s *Service) handleCreateNote(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	text, err := parseNoteText(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if !s.requireVisibleBook(w, r, userID, bookID, "POST /api/books/{id}/notes") {
		return
	}
	now := time.Now().UTC().Unix()
	note := NoteDTO{ID: uuid.NewString(), Text: text, CreatedAt: formatUnixSecISO(now), UpdatedAt: formatUnixSecISO(now)}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO book_notes (id, user_id, book_id, text, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, note.ID, userID, bookID, text, now, now); err != nil {
		s.writeErr(w, "POST /api/books/{id}/notes insert failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": note})
}

// PUT /api/books/{id}/notes/{noteId}
func (s *Service) handleUpdateNote(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	noteID := strings.TrimSpace(r.PathValue("noteId"))
	text, err := parseNoteText(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if !s.requireVisibleBook(w, r, userID, bookID, "PUT /api/books/{id}/notes/{noteId}") {
		return
	}
	now := time.Now().UTC().Unix()
	res, err := s.db.ExecContext(r.Context(), `
		UPDATE book_notes SET text = ?, updated_at = ?
		WHERE id = ? AND user_id = ? AND book_id = ?
	`, text, now, noteID, userID, bookID)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/notes/{noteId} update failed", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Note not found")
		return
	}
	var createdAt int64
	_ = s.db.QueryRowContext(r.Context(), `SELECT created_at FROM book_notes WHERE id = ?`, noteID).Scan(&createdAt)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": NoteDTO{
		ID: noteID, Text: text, CreatedAt: formatUnixSecISO(createdAt), UpdatedAt: formatUnixSecISO(now),
	}})
}

// DELETE /api/books/{id}/notes/{noteId}
func (s *Service) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	noteID := strings.TrimSpace(r.PathValue("noteId"))
	if !s.requireVisibleBook(w, r, userID, bookID, "DELETE /api/books/{id}/notes/{noteId}") {
		return
	}
	res, err := s.db.ExecContext(r.Context(), `
		DELETE FROM book_notes WHERE id = ? AND user_id = ? AND book_id = ?
	`, noteID, userID, bookID)
	if err != nil {
		s.writeErr(w, "DELETE /api/books/{id}/notes/{noteId} failed", err)
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Note not found")
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})
}
