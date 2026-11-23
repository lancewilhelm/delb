package books

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

var (
	uuidV4LikeRe   = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	nonNegIntStrRe = regexp.MustCompile(`^(0|[1-9]\d*)$`)
)

func calendarDateLocal(sec int64) string {
	t := time.Unix(sec, 0).In(time.Local)
	return fmt.Sprintf("%04d-%02d-%02d", t.Year(), int(t.Month()), t.Day())
}

// POST /api/books/{id}/rating
func (s *Service) handlePostRating(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var body map[string]json.RawMessage
	_ = httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true)

	var rating *int
	rawRating, hasRating := body["rating"]
	trimmed := strings.TrimSpace(string(rawRating))
	wantsClear := !hasRating || trimmed == "" || trimmed == "null" || trimmed == "0"

	if !wantsClear {
		var parsed float64
		var ok bool
		if err := json.Unmarshal(rawRating, &parsed); err == nil {
			ok = true
		} else {
			var strVal string
			if err := json.Unmarshal(rawRating, &strVal); err == nil {
				if f, perr := strconv.ParseFloat(strings.TrimSpace(strVal), 64); perr == nil {
					parsed = f
					ok = true
				}
			}
		}
		if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid rating (must be a number 1..10, or null to clear).")
			return
		}
		if math.Trunc(parsed) != parsed || parsed < 1 || parsed > 10 {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid rating (must be an integer 1..10 half-stars).")
			return
		}
		v := int(parsed)
		rating = &v
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/rating vis failed", "Failed to set rating", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	if rating == nil {
		if _, err := s.db.ExecContext(r.Context(), `
			DELETE FROM book_ratings WHERE book_id = ? AND user_id = ?
		`, bookID, userID); err != nil {
			s.writeErrWithFallback(w, "POST /api/books/{id}/rating delete failed", "Failed to set rating", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"rating": nil},
		})
		return
	}

	now := time.Now().UTC().Unix()
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO book_ratings (user_id, book_id, rating, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, book_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at
	`, userID, bookID, *rating, now); err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/rating upsert failed", "Failed to set rating", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"rating": *rating},
	})
}

// GET /api/books/{id}/status
func (s *Service) handleGetStatus(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/status vis failed", "Failed to fetch status", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	var statusRaw string
	var startedAt, finishedAt, dnfAt, tbrRank sql.NullInt64
	err = s.db.QueryRowContext(r.Context(), `
		SELECT status, started_at, finished_at, dnf_at, tbr_rank
		FROM user_book_status
		WHERE user_id = ? AND book_id = ?
		LIMIT 1
	`, userID, bookID).Scan(&statusRaw, &startedAt, &finishedAt, &dnfAt, &tbrRank)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"status":     nil,
				"startedAt":  nil,
				"finishedAt": nil,
				"dnfAt":      nil,
				"tbrRank":    nil,
			},
		})
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/status query failed", "Failed to fetch status", err)
		return
	}

	if !isValidBookStatus(statusRaw) {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"status":     nil,
				"startedAt":  nil,
				"finishedAt": nil,
				"dnfAt":      nil,
				"tbrRank":    nil,
			},
		})
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"status":     statusRaw,
			"startedAt":  formatNullUnixSecISO(startedAt),
			"finishedAt": formatNullUnixSecISO(finishedAt),
			"dnfAt":      formatNullUnixSecISO(dnfAt),
			"tbrRank":    nullInt64Ptr(tbrRank),
		},
	})
}

// StatusChange describes a requested reading-status update.
type StatusChange struct {
	StatusSet     bool
	Status        *string
	StartedAtSet  bool
	StartedAt     *int64
	FinishedAtSet bool
	FinishedAt    *int64
	DnfAtSet      bool
	DnfAt         *int64
	TbrRankSet    bool
	TbrRank       *int
}

// StatusResultRow holds the post-transition reading status for one book.
type StatusResultRow struct {
	BookID     string
	Status     *string
	StartedAt  *int64
	FinishedAt *int64
	DnfAt      *int64
	TbrRank    *int
}

type statusChange struct {
	statusSet     bool
	status        *string
	startedAtSet  bool
	startedAt     *int64
	finishedAtSet bool
	finishedAt    *int64
	dnfAtSet      bool
	dnfAt         *int64
	tbrRankSet    bool
	tbrRank       *int
}

type statusResultRow = StatusResultRow

type statusTransitionResult struct {
	rows    []statusResultRow
	visible int
	updated int
	cleared int
}

// TransitionBookStatuses executes a status transition with an optional in-transaction
// authorization callback (used by MCP tools).
func TransitionBookStatuses(
	ctx context.Context,
	db *sql.DB,
	userID string,
	bookIDs []string,
	change StatusChange,
	now time.Time,
	authorize func(tx *sql.Tx) error,
) ([]StatusResultRow, error) {
	res, err := transitionBookStatusesWithAuth(ctx, db, userID, bookIDs, statusChange{
		statusSet:     change.StatusSet,
		status:        change.Status,
		startedAtSet:  change.StartedAtSet,
		startedAt:     change.StartedAt,
		finishedAtSet: change.FinishedAtSet,
		finishedAt:    change.FinishedAt,
		dnfAtSet:      change.DnfAtSet,
		dnfAt:         change.DnfAt,
		tbrRankSet:    change.TbrRankSet,
		tbrRank:       change.TbrRank,
	}, now, authorize)
	if err != nil {
		return nil, err
	}
	return res.rows, nil
}

// transitionBookStatuses mirrors server/utils/books/status-transition.ts.
func transitionBookStatuses(
	ctx context.Context,
	db *sql.DB,
	userID string,
	bookIDs []string,
	change statusChange,
	now time.Time,
) (statusTransitionResult, error) {
	return transitionBookStatusesWithAuth(ctx, db, userID, bookIDs, change, now, nil)
}

func transitionBookStatusesWithAuth(
	ctx context.Context,
	db *sql.DB,
	userID string,
	bookIDs []string,
	change statusChange,
	now time.Time,
	authorize func(tx *sql.Tx) error,
) (statusTransitionResult, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return statusTransitionResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	if authorize != nil {
		if err := authorize(tx); err != nil {
			return statusTransitionResult{}, err
		}
	}

	nowSec := now.UTC().Unix()

	visiblePages := make(map[string]*int64)
	if len(bookIDs) > 0 {
		args := make([]any, 0, len(bookIDs)+1)
		for _, id := range bookIDs {
			args = append(args, id)
		}
		args = append(args, userID)
		vRows, err := tx.QueryContext(ctx, `
			SELECT DISTINCT b.id, b.pages
			FROM books b
			INNER JOIN collection_books cb ON cb.book_id = b.id
			INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id
			WHERE b.id IN (`+makePlaceholders(len(bookIDs))+`) AND cm.user_id = ?
		`, args...)
		if err != nil {
			return statusTransitionResult{}, err
		}
		for vRows.Next() {
			var id string
			var pages sql.NullInt64
			if err := vRows.Scan(&id, &pages); err != nil {
				_ = vRows.Close()
				return statusTransitionResult{}, err
			}
			visiblePages[id] = nullInt64Ptr(pages)
		}
		if err := vRows.Close(); err != nil {
			return statusTransitionResult{}, err
		}
	}

	orderedIDs := make([]string, 0, len(bookIDs))
	for _, id := range bookIDs {
		if _, ok := visiblePages[id]; ok {
			orderedIDs = append(orderedIDs, id)
		}
	}

	type existingStatusRow struct {
		bookID     string
		status     string
		startedAt  sql.NullInt64
		finishedAt sql.NullInt64
		dnfAt      sql.NullInt64
		tbrRank    sql.NullInt64
	}
	eRows, err := tx.QueryContext(ctx, `
		SELECT ubs.book_id, ubs.status, ubs.started_at, ubs.finished_at, ubs.dnf_at, ubs.tbr_rank
		FROM user_book_status ubs
		WHERE ubs.user_id = ?
		  AND EXISTS (
			SELECT 1 FROM collection_books cb
			INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id
			WHERE cb.book_id = ubs.book_id AND cm.user_id = ?
		  )
	`, userID, userID)
	if err != nil {
		return statusTransitionResult{}, err
	}
	existingMap := make(map[string]existingStatusRow)
	var existingTbr []existingStatusRow
	for eRows.Next() {
		var r existingStatusRow
		if err := eRows.Scan(&r.bookID, &r.status, &r.startedAt, &r.finishedAt, &r.dnfAt, &r.tbrRank); err != nil {
			_ = eRows.Close()
			return statusTransitionResult{}, err
		}
		existingMap[r.bookID] = r
		if r.status == "to_be_read" {
			existingTbr = append(existingTbr, r)
		}
	}
	if err := eRows.Close(); err != nil {
		return statusTransitionResult{}, err
	}

	sort.Slice(existingTbr, func(i, j int) bool {
		ar := int64(math.MaxInt64)
		if existingTbr[i].tbrRank.Valid {
			ar = existingTbr[i].tbrRank.Int64
		}
		br := int64(math.MaxInt64)
		if existingTbr[j].tbrRank.Valid {
			br = existingTbr[j].tbrRank.Int64
		}
		if ar != br {
			return ar < br
		}
		return existingTbr[i].bookID < existingTbr[j].bookID
	})
	tbr := make([]string, len(existingTbr))
	for i, r := range existingTbr {
		tbr[i] = r.bookID
	}

	results := make([]statusResultRow, 0, len(orderedIDs))
	cleared := 0

	for _, bookID := range orderedIDs {
		old, hasOld := existingMap[bookID]
		var oldStatus *string
		if hasOld && isValidBookStatus(old.status) {
			sVal := old.status
			oldStatus = &sVal
		}

		status := oldStatus
		if change.statusSet {
			status = change.status
		}
		startedAt := nullInt64Ptr(old.startedAt)
		if change.startedAtSet {
			startedAt = change.startedAt
		}
		finishedAt := nullInt64Ptr(old.finishedAt)
		if change.finishedAtSet {
			finishedAt = change.finishedAt
		}
		dnfAt := nullInt64Ptr(old.dnfAt)
		if change.dnfAtSet {
			dnfAt = change.dnfAt
		}

		if !change.statusSet {
			if change.finishedAtSet && change.finishedAt != nil {
				sVal := "finished"
				status = &sVal
			} else if change.dnfAtSet && change.dnfAt != nil {
				sVal := "dnf"
				status = &sVal
			} else if change.startedAtSet && change.startedAt != nil && (oldStatus == nil || *oldStatus == "to_be_read" || *oldStatus == "reading") {
				sVal := "reading"
				status = &sVal
			} else if change.finishedAtSet && change.finishedAt == nil && oldStatus != nil && *oldStatus == "finished" {
				sVal := "to_be_read"
				if startedAt != nil {
					sVal = "reading"
				}
				status = &sVal
			} else if change.dnfAtSet && change.dnfAt == nil && oldStatus != nil && *oldStatus == "dnf" {
				sVal := "to_be_read"
				if startedAt != nil {
					sVal = "reading"
				}
				status = &sVal
			}
		}

		oldIndex := -1
		for idx, id := range tbr {
			if id == bookID {
				oldIndex = idx
				tbr = append(tbr[:idx], tbr[idx+1:]...)
				break
			}
		}

		if status == nil {
			if (change.startedAtSet && change.startedAt != nil) ||
				(change.finishedAtSet && change.finishedAt != nil) ||
				(change.dnfAtSet && change.dnfAt != nil) ||
				(change.tbrRankSet && change.tbrRank != nil) {
				return statusTransitionResult{}, httpapi.NewError(http.StatusBadRequest, "Cannot set status metadata when clearing status.")
			}
			res, err := tx.ExecContext(ctx, `
				DELETE FROM user_book_status WHERE user_id = ? AND book_id = ?
			`, userID, bookID)
			if err != nil {
				return statusTransitionResult{}, err
			}
			n, _ := res.RowsAffected()
			cleared += int(n)
			results = append(results, statusResultRow{BookID: bookID})
			continue
		}

		st := *status
		if change.tbrRankSet && st != "to_be_read" {
			return statusTransitionResult{}, httpapi.NewError(http.StatusBadRequest, "tbrRank can only be set when status is to_be_read.")
		}
		if st == "reading" && startedAt == nil {
			v := nowSec
			startedAt = &v
		}
		if st == "finished" {
			if finishedAt == nil {
				v := nowSec
				finishedAt = &v
			}
			if startedAt == nil {
				v := *finishedAt
				startedAt = &v
			}
		}
		if st == "dnf" {
			if dnfAt == nil {
				v := nowSec
				dnfAt = &v
			}
			if startedAt == nil {
				v := *dnfAt
				startedAt = &v
			}
		}
		if st != "finished" {
			finishedAt = nil
		}
		if st != "dnf" {
			dnfAt = nil
		}
		if st == "to_be_read" {
			startedAt = nil
			finishedAt = nil
			dnfAt = nil
		}
		if startedAt != nil && finishedAt != nil && *finishedAt < *startedAt {
			return statusTransitionResult{}, httpapi.NewError(http.StatusBadRequest, "finishedAt must be on or after startedAt.")
		}
		if startedAt != nil && dnfAt != nil && *dnfAt < *startedAt {
			return statusTransitionResult{}, httpapi.NewError(http.StatusBadRequest, "dnfAt must be on or after startedAt.")
		}

		if st == "to_be_read" {
			insertIdx := len(tbr)
			if change.tbrRank != nil {
				insertIdx = *change.tbrRank - 1
				if insertIdx < 0 {
					insertIdx = 0
				}
				if insertIdx > len(tbr) {
					insertIdx = len(tbr)
				}
			} else if oldIndex >= 0 {
				insertIdx = oldIndex
				if insertIdx > len(tbr) {
					insertIdx = len(tbr)
				}
			}
			tbr = append(tbr, "")
			copy(tbr[insertIdx+1:], tbr[insertIdx:])
			tbr[insertIdx] = bookID
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_book_status (user_id, book_id, status, started_at, finished_at, dnf_at, tbr_rank, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
			ON CONFLICT(user_id, book_id) DO UPDATE SET
				status = excluded.status,
				started_at = excluded.started_at,
				finished_at = excluded.finished_at,
				dnf_at = excluded.dnf_at,
				tbr_rank = NULL,
				updated_at = excluded.updated_at
		`, userID, bookID, st, startedAt, finishedAt, dnfAt, nowSec); err != nil {
			return statusTransitionResult{}, err
		}

		stCopy := st
		results = append(results, statusResultRow{
			BookID:     bookID,
			Status:     &stCopy,
			StartedAt:  startedAt,
			FinishedAt: finishedAt,
			DnfAt:      dnfAt,
		})

		if st == "finished" && finishedAt != nil {
			var existingLogID string
			err := tx.QueryRowContext(ctx, `
				SELECT id FROM user_book_progress_log
				WHERE user_id = ? AND book_id = ? AND source = 'status-finished'
				LIMIT 1
			`, userID, bookID).Scan(&existingLogID)
			pagesVal := visiblePages[bookID]
			if err == nil {
				if _, uerr := tx.ExecContext(ctx, `
					UPDATE user_book_progress_log
					SET progress_percent = 100, page_number = ?, occurred_at = ?
					WHERE id = ?
				`, pagesVal, *finishedAt, existingLogID); uerr != nil {
					return statusTransitionResult{}, uerr
				}
			} else if errors.Is(err, sql.ErrNoRows) {
				if _, ierr := tx.ExecContext(ctx, `
					INSERT INTO user_book_progress_log (
						id, user_id, book_id, progress_percent, page_number, location, source, occurred_at, created_at
					) VALUES (?, ?, ?, 100, ?, NULL, 'status-finished', ?, ?)
				`, uuid.NewString(), userID, bookID, pagesVal, *finishedAt, nowSec); ierr != nil {
					return statusTransitionResult{}, ierr
				}
			} else {
				return statusTransitionResult{}, err
			}
		}
	}

	for i, id := range tbr {
		if _, err := tx.ExecContext(ctx, `
			UPDATE user_book_status SET tbr_rank = ? WHERE user_id = ? AND book_id = ?
		`, i+1, userID, id); err != nil {
			return statusTransitionResult{}, err
		}
	}

	tbrRankByID := make(map[string]int, len(tbr))
	for i, id := range tbr {
		tbrRankByID[id] = i + 1
	}
	for i := range results {
		if results[i].Status != nil && *results[i].Status == "to_be_read" {
			r := tbrRankByID[results[i].BookID]
			results[i].TbrRank = &r
		}
	}

	if err := tx.Commit(); err != nil {
		return statusTransitionResult{}, err
	}

	updatedCount := 0
	if !change.statusSet || change.status != nil {
		for _, r := range results {
			if r.Status != nil {
				updatedCount++
			}
		}
	}
	return statusTransitionResult{
		rows:    results,
		visible: len(orderedIDs),
		updated: updatedCount,
		cleared: cleared,
	}, nil
}

func parseFlexibleDateJSON(raw json.RawMessage) (present bool, sec *int64, invalid bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return false, nil, false
	}
	if trimmed == "null" || trimmed == `""` {
		return true, nil, false
	}
	var num float64
	if err := json.Unmarshal(raw, &num); err == nil {
		if math.IsNaN(num) || math.IsInf(num, 0) {
			return true, nil, true
		}
		v := int64(math.Floor(num / 1000.0))
		return true, &v, false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return true, nil, true
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return true, nil, false
	}
	if m := ymdStrictRe.FindStringSubmatch(s); m != nil {
		y, _ := strconv.Atoi(m[1])
		mo, _ := strconv.Atoi(m[2])
		d, _ := strconv.Atoi(m[3])
		dt := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.Local)
		v := dt.Unix()
		return true, &v, false
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05", "2006-01-02 15:04:05", time.RFC1123, time.RFC1123Z} {
		if dt, err := time.Parse(layout, s); err == nil {
			v := dt.UTC().Unix()
			return true, &v, false
		}
	}
	return true, nil, true
}

// POST /api/books/{id}/status
func (s *Service) handlePostStatus(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var body map[string]json.RawMessage
	_ = httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true)

	var ch statusChange
	if rawStatus, exists := body["status"]; exists {
		ch.statusSet = true
		trimmed := strings.TrimSpace(string(rawStatus))
		if trimmed != "null" && trimmed != `""` {
			var sVal string
			if json.Unmarshal(rawStatus, &sVal) != nil {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid status (must be a string or null to clear).")
				return
			}
			if sVal != "" {
				if !isValidBookStatus(sVal) {
					httpapi.WriteError(w, http.StatusBadRequest, "Invalid status. Expected one of: "+strings.Join(userBookStatuses, ", "))
					return
				}
				ch.status = &sVal
			}
		}
	}

	if raw, exists := body["startedAt"]; exists {
		_, val, invalid := parseFlexibleDateJSON(raw)
		if invalid {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid startedAt date.")
			return
		}
		ch.startedAtSet = true
		ch.startedAt = val
	}
	if raw, exists := body["finishedAt"]; exists {
		_, val, invalid := parseFlexibleDateJSON(raw)
		if invalid {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid finishedAt date.")
			return
		}
		ch.finishedAtSet = true
		ch.finishedAt = val
	}
	if raw, exists := body["dnfAt"]; exists {
		_, val, invalid := parseFlexibleDateJSON(raw)
		if invalid {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid dnfAt date.")
			return
		}
		ch.dnfAtSet = true
		ch.dnfAt = val
	}

	if rawRank, exists := body["tbrRank"]; exists {
		ch.tbrRankSet = true
		trimmed := strings.TrimSpace(string(rawRank))
		if trimmed != "null" && trimmed != `""` {
			var parsed float64
			var ok bool
			if json.Unmarshal(rawRank, &parsed) == nil {
				ok = true
			} else {
				var sVal string
				if json.Unmarshal(rawRank, &sVal) == nil {
					if f, err := strconv.ParseFloat(strings.TrimSpace(sVal), 64); err == nil {
						parsed = f
						ok = true
					}
				}
			}
			if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) || math.Trunc(parsed) != parsed || parsed < 1 {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid tbrRank value (must be a whole number >= 1).")
				return
			}
			v := int(parsed)
			ch.tbrRank = &v
		}
	}

	res, err := transitionBookStatuses(r.Context(), s.db, userID, []string{bookID}, ch, time.Now())
	if err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/status failed", "Failed to set status", err)
		return
	}
	if len(res.rows) == 0 {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	row := res.rows[0]
	var startedISO, finishedISO, dnfISO *string
	if row.StartedAt != nil {
		sVal := formatUnixSecISO(*row.StartedAt)
		startedISO = &sVal
	}
	if row.FinishedAt != nil {
		sVal := formatUnixSecISO(*row.FinishedAt)
		finishedISO = &sVal
	}
	if row.DnfAt != nil {
		sVal := formatUnixSecISO(*row.DnfAt)
		dnfISO = &sVal
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"status":     row.Status,
			"startedAt":  startedISO,
			"finishedAt": finishedISO,
			"dnfAt":      dnfISO,
			"tbrRank":    row.TbrRank,
		},
	})
}

// GET /api/books/{id}/rationale
func (s *Service) handleGetRationale(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/rationale vis failed", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	var text string
	err = s.db.QueryRowContext(r.Context(), `
		SELECT text FROM user_book_rationale WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&text)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.writeErr(w, "GET /api/books/{id}/rationale query failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]string{"rationale": text},
	})
}

// WriteRationale mirrors server/utils/books/tbr.ts writeRationale.
func WriteRationale(
	ctx context.Context,
	db *sql.DB,
	userID, bookID, text string,
	authorize func(tx *sql.Tx) error,
) (string, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()

	if authorize != nil {
		if err := authorize(tx); err != nil {
			return "", err
		}
	}
	visible, err := isBookVisibleToUser(ctx, tx, userID, bookID)
	if err != nil {
		return "", err
	}
	if !visible {
		return "", httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_book_rationale (user_id, book_id, text)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, book_id) DO UPDATE SET text = excluded.text
	`, userID, bookID, text); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return text, nil
}

// ReadingProgressEntry is a single reading-progress history row formatted for MCP/API.
type ReadingProgressEntry struct {
	ID              string  `json:"id"`
	ProgressPercent float64 `json:"progressPercent"`
	PageNumber      *int64  `json:"pageNumber"`
	Source          string  `json:"source"`
	OccurredAt      string  `json:"occurredAt"`
	CreatedAt       string  `json:"createdAt"`
}

// ReaderPositionSnapshot holds a book's saved reader percentage and update timestamp.
type ReaderPositionSnapshot struct {
	Progress  *float64 `json:"progress"`
	UpdatedAt string   `json:"updatedAt"`
}

// LatestProgressDTO mirrors server/utils/books/progress-order.ts latestReadingProgress output.
type LatestProgressDTO struct {
	ProgressPercent float64 `json:"progressPercent"`
	PageNumber      *int64  `json:"pageNumber"`
	Source          string  `json:"source"`
	OccurredAt      string  `json:"occurredAt"`
}

// ReadingProgressSnapshot mirrors server/utils/books/progress.ts readReadingProgress.
type ReadingProgressSnapshot struct {
	BookID              string                  `json:"bookId"`
	PageCount           *int64                  `json:"pageCount"`
	ProgressSyncEnabled bool                    `json:"progressSyncEnabled"`
	ReaderPosition      *ReaderPositionSnapshot `json:"readerPosition"`
	History             []ReadingProgressEntry  `json:"history"`
	Latest              *LatestProgressDTO      `json:"latest"`
}

// ReadReadingProgress mirrors server/utils/books/progress.ts readReadingProgress.
func ReadReadingProgress(ctx context.Context, db *sql.DB, userID, bookID string, limit int) (*ReadingProgressSnapshot, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var bookPages sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT b.pages
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&bookPages)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if err != nil {
		return nil, err
	}

	var syncEnabled int64
	_ = tx.QueryRowContext(ctx, `
		SELECT progress_sync_enabled FROM user_book_preferences WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&syncEnabled)

	var (
		posProg    sql.NullFloat64
		posUpd     sql.NullInt64
		hasPosRow  bool
	)
	if err := tx.QueryRowContext(ctx, `
		SELECT progress, updated_at FROM user_book_reading_position WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&posProg, &posUpd); err == nil {
		hasPosRow = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT id, progress_percent, page_number, location, source, occurred_at, created_at
		FROM user_book_progress_log
		WHERE user_id = ? AND book_id = ?
		ORDER BY `+progressHistoryOrderSQL+`
		LIMIT ?
	`, userID, bookID, limit)
	if err != nil {
		return nil, err
	}
	var rawHistory []progressLogRow
	history := make([]ReadingProgressEntry, 0)
	for rows.Next() {
		var row progressLogRow
		var page sql.NullInt64
		var loc sql.NullString
		if err := rows.Scan(&row.id, &row.progressPercent, &page, &loc, &row.source, &row.occurredAtSec, &row.createdAtSec); err != nil {
			_ = rows.Close()
			return nil, err
		}
		row.pageNumber = nullInt64Ptr(page)
		row.location = nullStringPtr(loc)
		rawHistory = append(rawHistory, row)
		history = append(history, ReadingProgressEntry{
			ID:              row.id,
			ProgressPercent: row.progressPercent,
			PageNumber:      row.pageNumber,
			Source:          row.source,
			OccurredAt:      formatUnixSecISO(row.occurredAtSec),
			CreatedAt:       formatUnixSecISO(row.createdAtSec),
		})
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	var readerPos *ReaderPositionSnapshot
	var posProgPtr *float64
	var posUpdPtr *int64
	if hasPosRow {
		posProgPtr = nullFloat64Ptr(posProg)
		posUpdPtr = nullInt64Ptr(posUpd)
		readerPos = &ReaderPositionSnapshot{
			Progress:  posProgPtr,
			UpdatedAt: formatUnixSecISO(posUpd.Int64),
		}
	}

	var firstLog *progressLogRow
	if len(rawHistory) > 0 {
		firstLog = &rawHistory[0]
	}
	var latestDTO *LatestProgressDTO
	if latest := computeLatestReadingProgress(firstLog, posProgPtr, posUpdPtr); latest != nil {
		latestDTO = &LatestProgressDTO{
			ProgressPercent: latest.ProgressPercent,
			PageNumber:      latest.PageNumber,
			Source:          latest.Source,
			OccurredAt:      formatUnixSecISO(latest.OccurredAtSec),
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ReadingProgressSnapshot{
		BookID:              bookID,
		PageCount:           nullInt64Ptr(bookPages),
		ProgressSyncEnabled: syncEnabled != 0,
		ReaderPosition:      readerPos,
		History:             history,
		Latest:              latestDTO,
	}, nil
}

// ManualProgressLog mirrors the return object of MCP log_reading_progress.
type ManualProgressLog struct {
	ID              string  `json:"id"`
	BookID          string  `json:"bookId"`
	ProgressPercent float64 `json:"progressPercent"`
	PageNumber      *int64  `json:"pageNumber"`
	Source          string  `json:"source"`
	OccurredAt      string  `json:"occurredAt"`
	CreatedAt       string  `json:"createdAt"`
}

// RecordManualProgress mirrors server/utils/books/progress.ts recordManualProgress.
func RecordManualProgress(
	ctx context.Context,
	db *sql.DB,
	userID, bookID string,
	progressPercent *float64,
	pageNumber *int64,
	occurredSec int64,
	authorize func(tx *sql.Tx) error,
) (*ManualProgressLog, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if authorize != nil {
		if err := authorize(tx); err != nil {
			return nil, err
		}
	}

	var bookPages sql.NullInt64
	err = tx.QueryRowContext(ctx, `
		SELECT b.pages
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&bookPages)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if err != nil {
		return nil, err
	}

	pct := progressPercent
	if pageNumber != nil {
		if !bookPages.Valid || bookPages.Int64 <= 0 {
			return nil, httpapi.NewError(http.StatusBadRequest, "This book has no page count. Add pages to log by page.")
		}
		if *pageNumber > bookPages.Int64 {
			return nil, httpapi.NewError(http.StatusBadRequest, fmt.Sprintf("pageNumber must be <= %d.", bookPages.Int64))
		}
		v := (float64(*pageNumber) / float64(bookPages.Int64)) * 100.0
		pct = &v
	}
	if pct == nil {
		return nil, httpapi.NewError(http.StatusBadRequest, "Provide progressPercent or pageNumber.")
	}

	logID := uuid.NewString()
	createdSec := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_book_progress_log (
			id, user_id, book_id, progress_percent, page_number, location, source, occurred_at, created_at
		) VALUES (?, ?, ?, ?, ?, NULL, 'manual', ?, ?)
	`, logID, userID, bookID, *pct, pageNumber, occurredSec, createdSec); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &ManualProgressLog{
		ID:              logID,
		BookID:          bookID,
		ProgressPercent: *pct,
		PageNumber:      pageNumber,
		Source:          "manual",
		OccurredAt:      formatUnixSecISO(occurredSec),
		CreatedAt:       formatUnixSecISO(createdSec),
	}, nil
}

// PUT /api/books/{id}/rationale
func (s *Service) handlePutRationale(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := strings.TrimSpace(r.PathValue("id"))
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	body, err := decodeBodyObject(r)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Rationale must be text of at most 10,000 characters.")
		return
	}
	rawRat, exists := body["rationale"]
	var rat string
	if !exists || strings.TrimSpace(string(rawRat)) == "null" || json.Unmarshal(rawRat, &rat) != nil || len(utf16.Encode([]rune(rat))) > 10000 {
		httpapi.WriteError(w, http.StatusBadRequest, "Rationale must be text of at most 10,000 characters.")
		return
	}

	trimmed := strings.TrimSpace(rat)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/rationale tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	visible, err := isBookVisibleToUser(r.Context(), tx, userID, bookID)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/rationale vis failed", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO user_book_rationale (user_id, book_id, text)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, book_id) DO UPDATE SET text = excluded.text
	`, userID, bookID, trimmed); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/rationale upsert failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/rationale commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]string{"rationale": trimmed},
	})
}

// GET /api/books/{id}/reading-position
func (s *Service) handleGetReadingPosition(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/reading-position vis failed", "Failed to fetch reading position", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	var loc sql.NullString
	var prog sql.NullFloat64
	err = s.db.QueryRowContext(r.Context(), `
		SELECT location, progress FROM user_book_reading_position WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&loc, &prog)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.writeErrWithFallback(w, "GET /api/books/{id}/reading-position query failed", "Failed to fetch reading position", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"location": nullStringPtr(loc),
			"progress": nullFloat64Ptr(prog),
		},
	})
}

// PUT /api/books/{id}/reading-position
func (s *Service) handlePutReadingPosition(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var body map[string]json.RawMessage
	_ = httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true)

	rawLoc, hasLoc := body["location"]
	locTrimmed := strings.TrimSpace(string(rawLoc))
	wantsClear := !hasLoc || locTrimmed == "" || locTrimmed == "null" || locTrimmed == `""`

	rawCSID, hasCSID := body["clientSessionId"]
	rawCSeq, hasCSeq := body["clientSequence"]
	hasSession := hasCSID || hasCSeq

	var clientSessionID *string
	var clientSequence *int64

	if hasSession {
		if wantsClear {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid client session or sequence.")
			return
		}
		var csid string
		var cseq float64
		if !hasCSID || !hasCSeq ||
			json.Unmarshal(rawCSID, &csid) != nil || !uuidV4LikeRe.MatchString(csid) ||
			json.Unmarshal(rawCSeq, &cseq) != nil || math.IsNaN(cseq) || math.IsInf(cseq, 0) ||
			math.Trunc(cseq) != cseq || cseq < 1 || cseq > 9007199254740991 {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid client session or sequence.")
			return
		}
		clientSessionID = &csid
		seq := int64(cseq)
		clientSequence = &seq
	}

	var location string
	if !wantsClear {
		if json.Unmarshal(rawLoc, &location) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid location (must be a string or null to clear).")
			return
		}
	}

	var progress *float64
	if !wantsClear {
		if rawProg, hasProg := body["progress"]; hasProg && strings.TrimSpace(string(rawProg)) != "null" {
			var parsed float64
			var ok bool
			if json.Unmarshal(rawProg, &parsed) == nil {
				ok = true
			} else {
				var sVal string
				if json.Unmarshal(rawProg, &sVal) == nil {
					if f, err := strconv.ParseFloat(strings.TrimSpace(sVal), 64); err == nil {
						parsed = f
						ok = true
					}
				}
			}
			if !ok || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid progress (must be a number 0..100).")
				return
			}
			if parsed < 0 || parsed > 100 {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid progress (must be between 0 and 100).")
				return
			}
			progress = &parsed
		}
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "PUT /api/books/{id}/reading-position vis failed", "Failed to update reading position", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	if wantsClear {
		if _, err := s.db.ExecContext(r.Context(), `
			DELETE FROM user_book_reading_position WHERE user_id = ? AND book_id = ?
		`, userID, bookID); err != nil {
			s.writeErrWithFallback(w, "PUT /api/books/{id}/reading-position delete failed", "Failed to update reading position", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"location": nil, "progress": nil},
		})
		return
	}

	now := time.Now().UTC().Unix()
	var retLoc sql.NullString
	var retProg sql.NullFloat64
	err = s.db.QueryRowContext(r.Context(), `
		INSERT INTO user_book_reading_position (user_id, book_id, location, progress, client_session_id, client_sequence, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, book_id) DO UPDATE SET
			location = excluded.location,
			progress = coalesce(excluded.progress, user_book_reading_position.progress),
			client_session_id = excluded.client_session_id,
			client_sequence = excluded.client_sequence,
			updated_at = excluded.updated_at
		WHERE excluded.client_session_id IS NULL
		   OR user_book_reading_position.client_session_id IS NULL
		   OR excluded.client_session_id != user_book_reading_position.client_session_id
		   OR excluded.client_sequence >= user_book_reading_position.client_sequence
		RETURNING location, progress
	`, userID, bookID, location, progress, clientSessionID, clientSequence, now).Scan(&retLoc, &retProg)

	if errors.Is(err, sql.ErrNoRows) {
		// Rejected as stale sequence; return current position
		var curLoc sql.NullString
		var curProg sql.NullFloat64
		_ = s.db.QueryRowContext(r.Context(), `
			SELECT location, progress FROM user_book_reading_position WHERE user_id = ? AND book_id = ? LIMIT 1
		`, userID, bookID).Scan(&curLoc, &curProg)
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"location": nullStringPtr(curLoc),
				"progress": nullFloat64Ptr(curProg),
			},
		})
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "PUT /api/books/{id}/reading-position upsert failed", "Failed to update reading position", err)
		return
	}

	if progress != nil {
		var syncEnabled int64
		if err := s.db.QueryRowContext(r.Context(), `
			SELECT progress_sync_enabled FROM user_book_preferences WHERE user_id = ? AND book_id = ? LIMIT 1
		`, userID, bookID).Scan(&syncEnabled); err == nil && syncEnabled != 0 {
			var latestPercent float64
			hasLatest := s.db.QueryRowContext(r.Context(), `
				SELECT progress_percent FROM user_book_progress_log
				WHERE user_id = ? AND book_id = ?
				ORDER BY occurred_at DESC
				LIMIT 1
			`, userID, bookID).Scan(&latestPercent) == nil
			if !hasLatest || math.Abs(latestPercent-*progress) >= 1.0 {
				_, _ = s.db.ExecContext(r.Context(), `
					INSERT INTO user_book_progress_log (
						id, user_id, book_id, progress_percent, page_number, location, source, occurred_at, created_at
					) VALUES (?, ?, ?, ?, NULL, ?, 'reader', ?, ?)
				`, uuid.NewString(), userID, bookID, *progress, location, now, now)
			}
		}
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"location": location,
			"progress": progress,
		},
	})
}

const progressEventTimeSQL = `CASE
	WHEN source = 'manual'
	  AND date(occurred_at, 'unixepoch', 'localtime') = date(created_at, 'unixepoch', 'localtime')
	  AND time(occurred_at, 'unixepoch', 'localtime') = '00:00:00'
	THEN created_at
	ELSE occurred_at
END`

const progressHistoryOrderSQL = progressEventTimeSQL + ` DESC, occurred_at DESC, created_at DESC, id DESC`

type progressLogRow struct {
	id              string
	progressPercent float64
	pageNumber      *int64
	location        *string
	source          string
	occurredAtSec   int64
	createdAtSec    int64
}

type latestProgressSummary struct {
	ProgressPercent float64
	PageNumber      *int64
	Source          string
	OccurredAtSec   int64
}

func computeLatestReadingProgress(log *progressLogRow, posProgress *float64, posUpdatedSec *int64) *latestProgressSummary {
	var posTime int64 = math.MinInt64
	if posProgress != nil && posUpdatedSec != nil {
		posTime = *posUpdatedSec
	}
	var logTime int64 = math.MinInt64
	if log != nil {
		occ := time.Unix(log.occurredAtSec, 0).In(time.Local)
		cre := time.Unix(log.createdAtSec, 0).In(time.Local)
		sameDay := occ.Year() == cre.Year() && occ.Month() == cre.Month() && occ.Day() == cre.Day()
		if log.source == "manual" && sameDay && occ.Hour() == 0 && occ.Minute() == 0 && occ.Second() == 0 {
			logTime = log.createdAtSec
		} else {
			logTime = log.occurredAtSec
		}
	}
	if log != nil && logTime >= posTime {
		return &latestProgressSummary{
			ProgressPercent: log.progressPercent,
			PageNumber:      log.pageNumber,
			Source:          log.source,
			OccurredAtSec:   log.occurredAtSec,
		}
	}
	if posProgress != nil && posUpdatedSec != nil {
		return &latestProgressSummary{
			ProgressPercent: *posProgress,
			PageNumber:      nil,
			Source:          "reader",
			OccurredAtSec:   *posUpdatedSec,
		}
	}
	return nil
}

// GET /api/books/{id}/progress
func (s *Service) handleGetProgress(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/progress vis failed", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	var posProg sql.NullFloat64
	var posUpd sql.NullInt64
	_ = s.db.QueryRowContext(r.Context(), `
		SELECT progress, updated_at FROM user_book_reading_position WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&posProg, &posUpd)

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, progress_percent, page_number, location, source, occurred_at, created_at
		FROM user_book_progress_log
		WHERE user_id = ? AND book_id = ?
		ORDER BY `+progressHistoryOrderSQL+`
		LIMIT 51
	`, userID, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/progress query failed", err)
		return
	}
	var history []progressLogRow
	for rows.Next() {
		var row progressLogRow
		var page sql.NullInt64
		var loc sql.NullString
		if err := rows.Scan(&row.id, &row.progressPercent, &page, &loc, &row.source, &row.occurredAtSec, &row.createdAtSec); err != nil {
			_ = rows.Close()
			s.writeErr(w, "GET /api/books/{id}/progress scan failed", err)
			return
		}
		row.pageNumber = nullInt64Ptr(page)
		row.location = nullStringPtr(loc)
		history = append(history, row)
	}
	_ = rows.Close()

	var firstLog *progressLogRow
	if len(history) > 0 {
		firstLog = &history[0]
	}
	latest := computeLatestReadingProgress(firstLog, nullFloat64Ptr(posProg), nullInt64Ptr(posUpd))

	var latestOut any
	if latest != nil {
		latestOut = map[string]any{
			"progressPercent": latest.ProgressPercent,
			"pageNumber":      latest.PageNumber,
			"source":          latest.Source,
			"occurredDate":    calendarDateLocal(latest.OccurredAtSec),
		}
	}

	hasMore := len(history) > 50
	displaySlice := history
	if hasMore {
		displaySlice = history[:50]
	}
	historyOut := make([]map[string]any, len(displaySlice))
	for i, h := range displaySlice {
		historyOut[i] = map[string]any{
			"id":              h.id,
			"progressPercent": h.progressPercent,
			"pageNumber":      h.pageNumber,
			"source":          h.source,
			"occurredDate":    calendarDateLocal(h.occurredAtSec),
		}
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"latest":  latestOut,
			"history": historyOut,
			"hasMore": hasMore,
		},
	})
}

// GET /api/books/{id}/progress-logs
func (s *Service) handleGetProgressLogs(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}
	limit := clampIntQuery(r.URL.Query().Get("limit"), 1, 200, 50)

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/progress-logs vis failed", "Failed to fetch progress logs", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, progress_percent, page_number, location, source, occurred_at, created_at
		FROM user_book_progress_log
		WHERE user_id = ? AND book_id = ?
		ORDER BY `+progressHistoryOrderSQL+`
		LIMIT ?
	`, userID, bookID, limit)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/progress-logs query failed", "Failed to fetch progress logs", err)
		return
	}
	defer func() { _ = rows.Close() }()

	logs := make([]map[string]any, 0)
	for rows.Next() {
		var (
			id              string
			progressPercent float64
			page            sql.NullInt64
			loc             sql.NullString
			source          string
			occurredAt      int64
			createdAt       int64
		)
		if err := rows.Scan(&id, &progressPercent, &page, &loc, &source, &occurredAt, &createdAt); err != nil {
			s.writeErrWithFallback(w, "GET /api/books/{id}/progress-logs scan failed", "Failed to fetch progress logs", err)
			return
		}
		logs = append(logs, map[string]any{
			"id":              id,
			"progressPercent": progressPercent,
			"pageNumber":      nullInt64Ptr(page),
			"location":        nullStringPtr(loc),
			"source":          source,
			"occurredAt":      formatUnixSecISO(occurredAt),
			"createdAt":       formatUnixSecISO(createdAt),
		})
	}
	if err := rows.Err(); err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/progress-logs rows err", "Failed to fetch progress logs", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"logs": logs},
	})
}

// POST /api/books/{id}/progress-logs
func (s *Service) handlePostProgressLog(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var body map[string]json.RawMessage
	_ = httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true)

	var progressPercent *float64
	if rawPct, ok := body["progressPercent"]; ok {
		tr := strings.TrimSpace(string(rawPct))
		if tr != "" && tr != "null" && tr != `""` {
			var parsed float64
			var parsedOK bool
			if json.Unmarshal(rawPct, &parsed) == nil {
				parsedOK = true
			} else {
				var sVal string
				if json.Unmarshal(rawPct, &sVal) == nil {
					if f, err := strconv.ParseFloat(strings.TrimSpace(sVal), 64); err == nil {
						parsed = f
						parsedOK = true
					}
				}
			}
			if !parsedOK || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid progressPercent value.")
				return
			}
			if parsed < 0 || parsed > 100 {
				httpapi.WriteError(w, http.StatusBadRequest, "progressPercent must be 0..100.")
				return
			}
			progressPercent = &parsed
		}
	}

	var pageNumber *int64
	if rawPage, ok := body["pageNumber"]; ok {
		tr := strings.TrimSpace(string(rawPage))
		if tr != "" && tr != "null" && tr != `""` {
			var parsed float64
			var parsedOK bool
			if json.Unmarshal(rawPage, &parsed) == nil {
				parsedOK = true
			} else {
				var sVal string
				if json.Unmarshal(rawPage, &sVal) == nil {
					if f, err := strconv.ParseFloat(strings.TrimSpace(sVal), 64); err == nil {
						parsed = f
						parsedOK = true
					}
				}
			}
			if !parsedOK || math.IsNaN(parsed) || math.IsInf(parsed, 0) || math.Trunc(parsed) != parsed {
				httpapi.WriteError(w, http.StatusBadRequest, "Invalid pageNumber value.")
				return
			}
			if parsed < 0 {
				httpapi.WriteError(w, http.StatusBadRequest, "pageNumber must be >= 0.")
				return
			}
			v := int64(parsed)
			pageNumber = &v
		}
	}

	occurredSec := time.Now().UTC().Unix()
	if rawOcc, ok := body["occurredAt"]; ok {
		_, val, invalid := parseFlexibleDateJSON(rawOcc)
		if invalid {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid occurredAt date.")
			return
		}
		if val != nil {
			occurredSec = *val
		}
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/progress-logs tx failed", "Failed to create progress log", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	var bookPages sql.NullInt64
	err = tx.QueryRowContext(r.Context(), `
		SELECT b.pages
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&bookPages)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/progress-logs lookup failed", "Failed to create progress log", err)
		return
	}

	if pageNumber != nil {
		if !bookPages.Valid || bookPages.Int64 <= 0 {
			httpapi.WriteError(w, http.StatusBadRequest, "This book has no page count. Add pages to log by page.")
			return
		}
		if *pageNumber > bookPages.Int64 {
			httpapi.WriteError(w, http.StatusBadRequest, fmt.Sprintf("pageNumber must be <= %d.", bookPages.Int64))
			return
		}
		pct := (float64(*pageNumber) / float64(bookPages.Int64)) * 100.0
		progressPercent = &pct
	}
	if progressPercent == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Provide progressPercent or pageNumber.")
		return
	}

	logID := uuid.NewString()
	createdSec := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO user_book_progress_log (
			id, user_id, book_id, progress_percent, page_number, location, source, occurred_at, created_at
		) VALUES (?, ?, ?, ?, ?, NULL, 'manual', ?, ?)
	`, logID, userID, bookID, *progressPercent, pageNumber, occurredSec, createdSec); err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/progress-logs insert failed", "Failed to create progress log", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/progress-logs commit failed", "Failed to create progress log", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"log": map[string]any{
				"id":              logID,
				"userId":          userID,
				"bookId":          bookID,
				"progressPercent": *progressPercent,
				"pageNumber":      pageNumber,
				"location":        nil,
				"source":          "manual",
				"occurredAt":      formatUnixSecISO(occurredSec),
				"createdAt":       formatUnixSecISO(createdSec),
			},
		},
	})
}

// PUT /api/books/{id}/progress-sync
func (s *Service) handlePutProgressSync(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var body map[string]json.RawMessage
	_ = httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true)

	rawEnabled, ok := body["enabled"]
	enabled, valid := parseFlexibleBool(rawEnabled, ok)
	if !valid {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid enabled value.")
		return
	}

	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "PUT /api/books/{id}/progress-sync vis failed", "Failed to update progress sync", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}

	valInt := 0
	if enabled {
		valInt = 1
	}
	now := time.Now().UTC().Unix()
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_book_preferences (user_id, book_id, progress_sync_enabled, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, book_id) DO UPDATE SET
			progress_sync_enabled = excluded.progress_sync_enabled,
			updated_at = excluded.updated_at
	`, userID, bookID, valInt, now); err != nil {
		s.writeErrWithFallback(w, "PUT /api/books/{id}/progress-sync upsert failed", "Failed to update progress sync", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"progressSyncEnabled": enabled},
	})
}

func parseFlexibleBool(raw json.RawMessage, exists bool) (bool, bool) {
	if !exists || len(raw) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return false, false
	}
	var b bool
	if json.Unmarshal(raw, &b) == nil {
		return b, true
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return n != 0, true
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		switch strings.ToLower(strings.TrimSpace(s)) {
		case "true", "1":
			return true, true
		case "false", "0":
			return false, true
		}
	}
	return false, false
}

// GET /api/tbr
func (s *Service) handleGetTbr(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT b.id, b.title, b.description, b.cover_image_path, b.updated_at,
		       ubs.tbr_rank, ubr.text, a.id, a.name
		FROM books b
		INNER JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		LEFT JOIN user_book_rationale ubr ON ubr.book_id = b.id AND ubr.user_id = ?
		LEFT JOIN book_authors ba ON ba.book_id = b.id
		LEFT JOIN authors a ON a.id = ba.author_id
		WHERE ubs.status = 'to_be_read'
		  AND ubs.tbr_rank IS NOT NULL
		  AND EXISTS (
			SELECT 1 FROM collection_books cb
			INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id
			WHERE cb.book_id = b.id AND cm.user_id = ?
		  )
		ORDER BY ubs.tbr_rank ASC, ba.position ASC, a.id ASC
	`, userID, userID, userID)
	if err != nil {
		s.writeErr(w, "GET /api/tbr query failed", err)
		return
	}
	defer func() { _ = rows.Close() }()

	type tbrBook struct {
		ID                string     `json:"id"`
		Title             string     `json:"title"`
		Description       *string    `json:"description"`
		CoverThumbnailURL *string    `json:"coverThumbnailUrl"`
		Rank              int64      `json:"rank"`
		Rationale         string     `json:"rationale"`
		Authors           []namedRef `json:"authors"`
	}

	byID := make(map[string]*tbrBook)
	order := make([]string, 0)

	for rows.Next() {
		var (
			id        string
			title     string
			desc      sql.NullString
			cover     sql.NullString
			updatedAt int64
			rank      sql.NullInt64
			rationale sql.NullString
			authorID  sql.NullString
			authorNm  sql.NullString
		)
		if err := rows.Scan(&id, &title, &desc, &cover, &updatedAt, &rank, &rationale, &authorID, &authorNm); err != nil {
			s.writeErr(w, "GET /api/tbr scan failed", err)
			return
		}
		if !rank.Valid {
			continue
		}
		book, exists := byID[id]
		if !exists {
			var coverURL *string
			if cover.Valid && cover.String != "" {
				ms := updatedAt * 1000
				u := storage.BuildBookCoverURL(id, &ms, "thumb")
				coverURL = &u
			}
			book = &tbrBook{
				ID:                id,
				Title:             title,
				Description:       nullStringPtr(desc),
				CoverThumbnailURL: coverURL,
				Rank:              rank.Int64,
				Rationale:         rationale.String,
				Authors:           make([]namedRef, 0),
			}
			byID[id] = book
			order = append(order, id)
		}
		if authorID.Valid && authorID.String != "" && authorNm.Valid && authorNm.String != "" {
			book.Authors = append(book.Authors, namedRef{ID: authorID.String, Name: authorNm.String})
		}
	}
	if err := rows.Err(); err != nil {
		s.writeErr(w, "GET /api/tbr rows err", err)
		return
	}

	queue := make([]tbrBook, len(order))
	for i, id := range order {
		queue[i] = *byID[id]
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"books": queue,
			"count": len(queue),
		},
	})
}

// GET /api/dashboard
func (s *Service) handleGetDashboard(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")

	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.writeErr(w, "GET /api/dashboard auth failed", err)
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	userID := swu.User.ID

	q := r.URL.Query()
	shelf := q.Get("shelf")
	if shelf == "" {
		shelf = "reading"
	}
	if shelf != "reading" && shelf != "finished" && shelf != "tbr" {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid dashboard shelf")
		return
	}
	collectionID := q.Get("collectionId")
	rawOffset := q.Get("offset")
	if rawOffset == "" {
		rawOffset = "0"
	}
	if !nonNegIntStrRe.MatchString(rawOffset) {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid shelf offset")
		return
	}
	offset, err := strconv.ParseInt(rawOffset, 10, 64)
	if err != nil || offset < 0 || offset > 9007199254740991 {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid shelf offset")
		return
	}

	visClause := `EXISTS (
		SELECT 1 FROM collection_books cb
		INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id
		WHERE cb.book_id = b.id AND cm.user_id = ?`
	visArgs := []any{userID}
	if collectionID != "" {
		visClause += ` AND cb.collection_id = ?`
		visArgs = append(visArgs, collectionID)
	}
	visClause += `)`

	var cTotal, cNone, cTbr, cReading, cFinished, cDnf int
	countArgs := append([]any{userID}, visArgs...)
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT
			COUNT(*),
			COUNT(CASE WHEN ubs.status IS NULL THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'to_be_read' THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'reading' THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'finished' THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'dnf' THEN 1 END)
		FROM books b
		LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		WHERE `+visClause, countArgs...).Scan(&cTotal, &cNone, &cTbr, &cReading, &cFinished, &cDnf); err != nil {
		s.writeErrWithFallback(w, "GET /api/dashboard counts failed", "Failed to load dashboard", err)
		return
	}

	var filterSQL, orderSQL string
	switch shelf {
	case "reading":
		filterSQL = `ubs.status = 'reading'`
		orderSQL = `pos.updated_at DESC, ubs.updated_at DESC, b.id ASC`
	case "finished":
		filterSQL = `ubs.status = 'finished' AND ubs.finished_at IS NOT NULL`
		orderSQL = `ubs.finished_at DESC, b.id ASC`
	case "tbr":
		filterSQL = `ubs.status = 'to_be_read'`
		orderSQL = `(ubs.tbr_rank IS NULL) ASC, ubs.tbr_rank ASC, b.id ASC`
	}

	const pageSize = 12
	shelfArgs := []any{userID, userID, userID, userID}
	shelfArgs = append(shelfArgs, visArgs...)
	shelfArgs = append(shelfArgs, pageSize+1, offset)

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			b.id, b.title, b.cover_image_path, b.has_physical_copy, b.has_audiobook_copy, b.updated_at,
			pos.progress, pos.updated_at,
			pl.progress_percent, pl.page_number, pl.source, pl.occurred_at, pl.created_at,
			ubs.finished_at
		FROM books b
		LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		LEFT JOIN user_book_reading_position pos ON pos.book_id = b.id AND pos.user_id = ?
		LEFT JOIN user_book_progress_log pl ON pl.user_id = ? AND pl.id = (
			SELECT id FROM user_book_progress_log
			WHERE user_id = ? AND book_id = b.id
			ORDER BY `+progressHistoryOrderSQL+`
			LIMIT 1
		)
		WHERE `+visClause+` AND `+filterSQL+`
		ORDER BY `+orderSQL+`
		LIMIT ? OFFSET ?
	`, shelfArgs...)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/dashboard shelf query failed", "Failed to load dashboard", err)
		return
	}
	defer func() { _ = rows.Close() }()

	type dashBook struct {
		ID               string   `json:"id"`
		Title            string   `json:"title"`
		CoverImagePath   *string  `json:"coverImagePath"`
		HasPhysicalCopy  bool     `json:"hasPhysicalCopy"`
		HasAudiobookCopy bool     `json:"hasAudiobookCopy"`
		UpdatedAt        string   `json:"updatedAt"`
		Progress         *float64 `json:"progress"`
		FinishedDate     *string  `json:"finishedDate"`
	}

	found := make([]dashBook, 0, pageSize+1)
	for rows.Next() {
		var (
			id               string
			title            string
			cover            sql.NullString
			hasPhys          int64
			hasAudio         int64
			updatedAt        int64
			posProg          sql.NullFloat64
			posUpd           sql.NullInt64
			logProg          sql.NullFloat64
			logPage          sql.NullInt64
			logSource        sql.NullString
			logOccurred      sql.NullInt64
			logCreated       sql.NullInt64
			finishedAt       sql.NullInt64
		)
		if err := rows.Scan(
			&id, &title, &cover, &hasPhys, &hasAudio, &updatedAt,
			&posProg, &posUpd,
			&logProg, &logPage, &logSource, &logOccurred, &logCreated,
			&finishedAt,
		); err != nil {
			s.writeErrWithFallback(w, "GET /api/dashboard shelf scan failed", "Failed to load dashboard", err)
			return
		}
		var logRow *progressLogRow
		if logProg.Valid && logSource.Valid && logOccurred.Valid && logCreated.Valid {
			logRow = &progressLogRow{
				progressPercent: logProg.Float64,
				pageNumber:      nullInt64Ptr(logPage),
				source:          logSource.String,
				occurredAtSec:   logOccurred.Int64,
				createdAtSec:    logCreated.Int64,
			}
		}
		latest := computeLatestReadingProgress(logRow, nullFloat64Ptr(posProg), nullInt64Ptr(posUpd))
		var progOut *float64
		if latest != nil {
			p := latest.ProgressPercent
			progOut = &p
		}
		var finDate *string
		if finishedAt.Valid {
			fd := calendarDateLocal(finishedAt.Int64)
			finDate = &fd
		}
		found = append(found, dashBook{
			ID:               id,
			Title:            title,
			CoverImagePath:   nullStringPtr(cover),
			HasPhysicalCopy:  hasPhys != 0,
			HasAudiobookCopy: hasAudio != 0,
			UpdatedAt:        formatUnixSecISO(updatedAt),
			Progress:         progOut,
			FinishedDate:     finDate,
		})
	}
	if err := rows.Err(); err != nil {
		s.writeErrWithFallback(w, "GET /api/dashboard shelf rows err", "Failed to load dashboard", err)
		return
	}

	var nextOffset *int64
	booksOut := found
	if len(found) > pageSize {
		booksOut = found[:pageSize]
		next := offset + pageSize
		nextOffset = &next
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"counts": map[string]int{
				"total":      cTotal,
				"none":       cNone,
				"to_be_read": cTbr,
				"reading":    cReading,
				"finished":   cFinished,
				"dnf":        cDnf,
			},
			"shelf": map[string]any{
				"kind":       shelf,
				"books":      booksOut,
				"nextOffset": nextOffset,
			},
		},
	})
}
