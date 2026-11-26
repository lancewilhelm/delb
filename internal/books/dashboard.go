package books

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// dashboardBook is one book on a dashboard shelf, list preview, or cover wall.
type dashboardBook struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	CoverImagePath   *string  `json:"coverImagePath"`
	HasPhysicalCopy  bool     `json:"hasPhysicalCopy"`
	HasAudiobookCopy bool     `json:"hasAudiobookCopy"`
	UpdatedAt        string   `json:"updatedAt"`
	Progress         *float64 `json:"progress"`
	FinishedDate     *string  `json:"finishedDate"`
	// SpineRevision is set when the book has spine artwork (GET /api/books/{id}/spine?v=).
	SpineRevision *string `json:"spineRevision"`
}

// Dashboard overview limits. The All books wall needs enough distinct covers
// to fill its 9×5 grid; list previews feed the card-art styles, and the Wall
// tile's 5×5 grid uses the most. Piles get their own random samples: up to
// 24 books on the All books card and 10 on a tile.
const (
	dashboardRecentLimit   = 45
	dashboardPreviewLimit  = 25
	dashboardLibraryPile   = 24
	dashboardListPileLimit = 10
)

// dashboardRecentOrder is the newest-first order of the All books cover wall.
const dashboardRecentOrder = `b.created_at DESC, b.id ASC`

// dashboardStatusLists defines each overview list: its status filter and order.
var dashboardStatusLists = []struct {
	key     string
	filter  string
	orderBy string
}{
	{"reading", `ubs.status = 'reading'`, `pos.updated_at DESC, ubs.updated_at DESC, b.id ASC`},
	{"to_be_read", `ubs.status = 'to_be_read'`, `(ubs.tbr_rank IS NULL) ASC, ubs.tbr_rank ASC, b.id ASC`},
	{"finished", `ubs.status = 'finished'`, `(ubs.finished_at IS NULL) ASC, ubs.finished_at DESC, ubs.updated_at DESC, b.id ASC`},
	{"dnf", `ubs.status = 'dnf'`, `ubs.updated_at DESC, b.id ASC`},
	{"none", `ubs.status IS NULL`, `b.created_at DESC, b.id ASC`},
}

// dashboardVisibility returns the SQL clause limiting books to the reader's
// accessible collections, optionally narrowed to one collection.
func dashboardVisibility(userID, collectionID string) (string, []any) {
	clause := `EXISTS (
		SELECT 1 FROM collection_books cb
		INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id
		WHERE cb.book_id = b.id AND cm.user_id = ?`
	args := []any{userID}
	if collectionID != "" {
		clause += ` AND cb.collection_id = ?`
		args = append(args, collectionID)
	}
	return clause + `)`, args
}

func (s *Service) dashboardCounts(ctx context.Context, userID, visClause string, visArgs []any) (map[string]int, error) {
	var cTotal, cNone, cTbr, cReading, cFinished, cDnf int
	args := append([]any{userID}, visArgs...)
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			COUNT(CASE WHEN ubs.status IS NULL THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'to_be_read' THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'reading' THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'finished' THEN 1 END),
			COUNT(CASE WHEN ubs.status = 'dnf' THEN 1 END)
		FROM books b
		LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		WHERE `+visClause, args...).Scan(&cTotal, &cNone, &cTbr, &cReading, &cFinished, &cDnf); err != nil {
		return nil, err
	}
	return map[string]int{
		"total":      cTotal,
		"none":       cNone,
		"to_be_read": cTbr,
		"reading":    cReading,
		"finished":   cFinished,
		"dnf":        cDnf,
	}, nil
}

// dashboardSampleFilter limits a query to a random sample of up to limit
// visible books that match filterSQL. Picking IDs first keeps the per-book
// progress lookups off the books that are not chosen.
func dashboardSampleFilter(userID, visClause string, visArgs []any, filterSQL string, limit int) (string, []any) {
	args := append([]any{userID}, visArgs...)
	args = append(args, limit)
	return `b.id IN (
		SELECT b.id FROM books b
		LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		WHERE ` + visClause + ` AND ` + filterSQL + `
		ORDER BY RANDOM()
		LIMIT ?
	)`, args
}

// queryDashboardBooks lists visible books matching filterSQL (with its
// placeholder values in filterArgs) in orderSQL order, with the reader's
// latest progress and finish date.
func (s *Service) queryDashboardBooks(
	ctx context.Context,
	userID, visClause string,
	visArgs []any,
	filterSQL string,
	filterArgs []any,
	orderSQL string,
	limit int,
	offset int64,
) ([]dashboardBook, error) {
	args := []any{userID, userID, userID, userID}
	args = append(args, visArgs...)
	args = append(args, filterArgs...)
	args = append(args, limit, offset)

	rows, err := s.db.QueryContext(ctx, `
		SELECT
			b.id, b.title, b.cover_image_path, b.has_physical_copy, b.has_audiobook_copy, b.updated_at,
			pos.progress, pos.updated_at,
			pl.progress_percent, pl.page_number, pl.source, pl.occurred_at, pl.created_at,
			ubs.finished_at,
			(SELECT revision FROM book_spines WHERE book_id = b.id)
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
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	found := make([]dashboardBook, 0, limit)
	for rows.Next() {
		var (
			id          string
			title       string
			cover       sql.NullString
			hasPhys     int64
			hasAudio    int64
			updatedAt   int64
			posProg     sql.NullFloat64
			posUpd      sql.NullInt64
			logProg     sql.NullFloat64
			logPage     sql.NullInt64
			logSource   sql.NullString
			logOccurred sql.NullInt64
			logCreated  sql.NullInt64
			finishedAt  sql.NullInt64
			spineRev    sql.NullString
		)
		if err := rows.Scan(
			&id, &title, &cover, &hasPhys, &hasAudio, &updatedAt,
			&posProg, &posUpd,
			&logProg, &logPage, &logSource, &logOccurred, &logCreated,
			&finishedAt, &spineRev,
		); err != nil {
			return nil, err
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
		found = append(found, dashboardBook{
			ID:               id,
			Title:            title,
			CoverImagePath:   nullStringPtr(cover),
			HasPhysicalCopy:  hasPhys != 0,
			HasAudiobookCopy: hasAudio != 0,
			UpdatedAt:        formatUnixSecISO(updatedAt),
			Progress:         progOut,
			FinishedDate:     finDate,
			SpineRevision:    nullStringPtr(spineRev),
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return found, nil
}

// GET /api/dashboard/overview?collectionId=
//
// One request for the whole dashboard: counts, the most recently added books
// for the All books cover wall, a short preview of every status list, and a
// random sample of each for Pile art.
func (s *Service) handleGetDashboardOverview(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")

	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.writeErr(w, "GET /api/dashboard/overview auth failed", err)
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	userID := swu.User.ID
	visClause, visArgs := dashboardVisibility(userID, r.URL.Query().Get("collectionId"))
	ctx := r.Context()
	const failMsg = "Failed to load dashboard"

	counts, err := s.dashboardCounts(ctx, userID, visClause, visArgs)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/dashboard/overview counts failed", failMsg, err)
		return
	}
	recent, err := s.queryDashboardBooks(ctx, userID, visClause, visArgs, `1 = 1`, nil, dashboardRecentOrder, dashboardRecentLimit, 0)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/dashboard/overview recent failed", failMsg, err)
		return
	}
	// sample returns a random selection of the books matching filter, in random order.
	sample := func(filter string, limit int) ([]dashboardBook, error) {
		sampleSQL, sampleArgs := dashboardSampleFilter(userID, visClause, visArgs, filter, limit)
		return s.queryDashboardBooks(ctx, userID, visClause, visArgs, sampleSQL, sampleArgs, `RANDOM()`, limit, 0)
	}
	piles := make(map[string][]dashboardBook, len(dashboardStatusLists)+1)
	piles["all"] = []dashboardBook{}
	if counts["total"] > 0 {
		if piles["all"], err = sample(`1 = 1`, dashboardLibraryPile); err != nil {
			s.writeErrWithFallback(w, "GET /api/dashboard/overview pile failed", failMsg, err)
			return
		}
	}
	lists := make(map[string][]dashboardBook, len(dashboardStatusLists))
	for _, list := range dashboardStatusLists {
		books, pile := []dashboardBook{}, []dashboardBook{}
		if counts[list.key] > 0 {
			books, err = s.queryDashboardBooks(ctx, userID, visClause, visArgs, list.filter, nil, list.orderBy, dashboardPreviewLimit, 0)
			if err == nil {
				pile, err = sample(list.filter, dashboardListPileLimit)
			}
			if err != nil {
				s.writeErrWithFallback(w, "GET /api/dashboard/overview "+list.key+" failed", failMsg, err)
				return
			}
		}
		lists[list.key] = books
		piles[list.key] = pile
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"counts": counts,
			"recent": recent,
			"lists":  lists,
			"piles":  piles,
		},
	})
}

// GET /api/dashboard/recent?collectionId=&offset=
//
// Pages through the All books cover wall's books (newest first) after the
// overview's first page, so a drifting wall can keep showing new covers.
func (s *Service) handleGetDashboardRecent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")

	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.writeErr(w, "GET /api/dashboard/recent auth failed", err)
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	q := r.URL.Query()
	rawOffset := q.Get("offset")
	if rawOffset == "" {
		rawOffset = "0"
	}
	offset, err := strconv.ParseInt(rawOffset, 10, 64)
	if !nonNegIntStrRe.MatchString(rawOffset) || err != nil || offset > 9007199254740991 {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid offset")
		return
	}
	userID := swu.User.ID
	visClause, visArgs := dashboardVisibility(userID, q.Get("collectionId"))

	found, err := s.queryDashboardBooks(r.Context(), userID, visClause, visArgs, `1 = 1`, nil, dashboardRecentOrder, dashboardRecentLimit+1, offset)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/dashboard/recent failed", "Failed to load covers", err)
		return
	}
	var nextOffset *int64
	if len(found) > dashboardRecentLimit {
		found = found[:dashboardRecentLimit]
		next := offset + dashboardRecentLimit
		nextOffset = &next
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"books":      found,
			"nextOffset": nextOffset,
		},
	})
}
