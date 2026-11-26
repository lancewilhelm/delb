package books

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// maxFinishSeriesDays bounds the daily progress series. A reading span longer
// than this (about ten years) returns no series instead of thousands of empty
// days; the summary stats are still returned.
const maxFinishSeriesDays = 3660

// finishLog is one progress checkpoint inside the reading window.
type finishLog struct {
	Date    string // local calendar date, YYYY-MM-DD
	Percent float64
}

// FinishProgressDay is one calendar day of the daily progress series.
type FinishProgressDay struct {
	Date string `json:"date"`
	// Percent is the cumulative progress at the end of the day. It never
	// decreases: a day without a checkpoint, or with a lower checkpoint than an
	// earlier day, carries the previous value forward.
	Percent float64 `json:"percent"`
	// DeltaPercent is the progress gained on this day.
	DeltaPercent float64 `json:"deltaPercent"`
	// Pages and PagesRead are derived from the percentages when the book has a
	// page count; otherwise they are null.
	Pages     *int64 `json:"pages"`
	PagesRead *int64 `json:"pagesRead"`
	// HasCheckpoint reports whether the reader logged progress on this day.
	HasCheckpoint bool `json:"hasCheckpoint"`
}

// FinishProgressSeries is the daily progress series across the reading window.
type FinishProgressSeries struct {
	CheckpointCount int                 `json:"checkpointCount"`
	Days            []FinishProgressDay `json:"days"`
}

func parseLocalYMD(s string) (time.Time, bool) {
	t, err := time.Parse("2006-01-02", s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// inclusiveDaySpan returns the number of calendar days from start to finish,
// counting both ends. A book started and finished on the same day spans 1 day.
// It returns 0 when either date is invalid or finish is before start.
func inclusiveDaySpan(startDate, finishDate string) int {
	start, ok1 := parseLocalYMD(startDate)
	finish, ok2 := parseLocalYMD(finishDate)
	if !ok1 || !ok2 || finish.Before(start) {
		return 0
	}
	return int(finish.Sub(start).Hours()/24) + 1
}

func pagesAt(percent float64, pages *int64) *int64 {
	if pages == nil || *pages <= 0 {
		return nil
	}
	v := int64(math.Round(percent / 100.0 * float64(*pages)))
	return &v
}

// buildFinishProgressSeries buckets the checkpoints into one entry per
// calendar day from startDate to finishDate, inclusive. Progress starts at 0
// at the beginning of startDate. Checkpoints outside the window are ignored.
func buildFinishProgressSeries(startDate, finishDate string, logs []finishLog, pages *int64) FinishProgressSeries {
	out := FinishProgressSeries{Days: []FinishProgressDay{}}
	span := inclusiveDaySpan(startDate, finishDate)
	if span <= 0 || span > maxFinishSeriesDays {
		return out
	}

	best := make(map[string]float64, len(logs))
	for _, l := range logs {
		if l.Date < startDate || l.Date > finishDate {
			continue
		}
		pct := math.Max(0, math.Min(100, l.Percent))
		if prev, ok := best[l.Date]; !ok || pct > prev {
			best[l.Date] = pct
		}
	}
	out.CheckpointCount = len(best)

	start, _ := parseLocalYMD(startDate)
	cumulative := 0.0
	prevPages := int64(0)
	for i := 0; i < span; i++ {
		date := start.AddDate(0, 0, i).Format("2006-01-02")
		pct, has := best[date]
		before := cumulative
		if has && pct > cumulative {
			cumulative = pct
		}
		day := FinishProgressDay{
			Date:          date,
			Percent:       roundTo(cumulative, 2),
			DeltaPercent:  roundTo(cumulative-before, 2),
			HasCheckpoint: has,
		}
		if p := pagesAt(cumulative, pages); p != nil {
			read := *p - prevPages
			day.Pages = p
			day.PagesRead = &read
			prevPages = *p
		}
		out.Days = append(out.Days, day)
	}
	return out
}

func roundTo(v float64, places int) float64 {
	f := math.Pow(10, float64(places))
	return math.Round(v*f) / f
}

// FinishSummary is the reader's personal summary of one finished book.
type FinishSummary struct {
	Book              finishSummaryBook    `json:"book"`
	Status            *string              `json:"status"`
	StartedAt         *string              `json:"startedAt"`
	FinishedAt        *string              `json:"finishedAt"`
	StartedDate       *string              `json:"startedDate"`
	FinishedDate      *string              `json:"finishedDate"`
	DurationDays      *int                 `json:"durationDays"`
	Pages             *int64               `json:"pages"`
	PagesPerDay       *float64             `json:"pagesPerDay"`
	Rating            *int64               `json:"rating"`
	FinishYear        *int                 `json:"finishYear"`
	YearFinishOrdinal *int                 `json:"yearFinishOrdinal"`
	Progress          FinishProgressSeries `json:"progress"`
}

type finishSummaryBook struct {
	ID             string               `json:"id"`
	Title          string               `json:"title"`
	Authors        []string             `json:"authors"`
	Series         *finishSummarySeries `json:"series"`
	Pages          *int64               `json:"pages"`
	CoverImagePath *string              `json:"coverImagePath"`
	UpdatedAt      string               `json:"updatedAt"`
}

type finishSummarySeries struct {
	Name  string   `json:"name"`
	Index *float64 `json:"index"`
}

// ReadFinishSummary returns the finish summary for a book that userID can see.
// It returns sql.ErrNoRows when the book does not exist or is not visible.
// Only the reader's own status, rating, and progress logs are read; reviews
// and notes are never included.
func ReadFinishSummary(ctx context.Context, db *sql.DB, userID, bookID string) (*FinishSummary, error) {
	var (
		title      string
		pages      sql.NullInt64
		cover      sql.NullString
		updatedAt  int64
		seriesName sql.NullString
		seriesIdx  sql.NullFloat64
	)
	err := db.QueryRowContext(ctx, `
		SELECT b.title, b.pages, b.cover_image_path, b.updated_at, s.name, b.series_index
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		LEFT JOIN series s ON s.id = b.series_id
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&title, &pages, &cover, &updatedAt, &seriesName, &seriesIdx)
	if err != nil {
		return nil, err
	}

	summary := &FinishSummary{
		Book: finishSummaryBook{
			ID:             bookID,
			Title:          title,
			Authors:        []string{},
			Pages:          nullInt64Ptr(pages),
			CoverImagePath: nullStringPtr(cover),
			UpdatedAt:      formatUnixSecISO(updatedAt),
		},
		Progress: FinishProgressSeries{Days: []FinishProgressDay{}},
	}
	if seriesName.Valid && strings.TrimSpace(seriesName.String) != "" {
		summary.Book.Series = &finishSummarySeries{Name: seriesName.String, Index: nullFloat64Ptr(seriesIdx)}
	}
	if summary.Book.Pages != nil && *summary.Book.Pages <= 0 {
		summary.Book.Pages = nil
	}
	summary.Pages = summary.Book.Pages

	aRows, err := db.QueryContext(ctx, `
		SELECT a.name
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id = ?
		ORDER BY ba.position ASC, a.name ASC
	`, bookID)
	if err != nil {
		return nil, err
	}
	for aRows.Next() {
		var name string
		if err := aRows.Scan(&name); err != nil {
			_ = aRows.Close()
			return nil, err
		}
		summary.Book.Authors = append(summary.Book.Authors, name)
	}
	if err := aRows.Close(); err != nil {
		return nil, err
	}

	var rating sql.NullInt64
	err = db.QueryRowContext(ctx, `
		SELECT rating FROM book_ratings WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&rating)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	summary.Rating = nullInt64Ptr(rating)

	var (
		statusRaw  string
		startedAt  sql.NullInt64
		finishedAt sql.NullInt64
	)
	err = db.QueryRowContext(ctx, `
		SELECT status, started_at, finished_at
		FROM user_book_status
		WHERE user_id = ? AND book_id = ?
		LIMIT 1
	`, userID, bookID).Scan(&statusRaw, &startedAt, &finishedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return summary, nil
	}
	if err != nil {
		return nil, err
	}
	if isValidBookStatus(statusRaw) {
		st := statusRaw
		summary.Status = &st
	}
	summary.StartedAt = formatNullUnixSecISO(startedAt)
	summary.FinishedAt = formatNullUnixSecISO(finishedAt)
	if startedAt.Valid {
		d := calendarDateLocal(startedAt.Int64)
		summary.StartedDate = &d
	}
	if finishedAt.Valid {
		d := calendarDateLocal(finishedAt.Int64)
		summary.FinishedDate = &d

		year := time.Unix(finishedAt.Int64, 0).In(time.Local).Year()
		summary.FinishYear = &year
		ordinal, err := yearFinishOrdinal(ctx, db, userID, bookID, finishedAt.Int64, year)
		if err != nil {
			return nil, err
		}
		if ordinal > 0 {
			summary.YearFinishOrdinal = &ordinal
		}
	}

	if summary.StartedDate == nil || summary.FinishedDate == nil {
		return summary, nil
	}
	span := inclusiveDaySpan(*summary.StartedDate, *summary.FinishedDate)
	if span <= 0 {
		return summary, nil
	}
	summary.DurationDays = &span
	if summary.Pages != nil {
		ppd := roundTo(float64(*summary.Pages)/float64(span), 1)
		summary.PagesPerDay = &ppd
	}

	logs, err := readFinishWindowLogs(ctx, db, userID, bookID, *summary.StartedDate, *summary.FinishedDate)
	if err != nil {
		return nil, err
	}
	summary.Progress = buildFinishProgressSeries(*summary.StartedDate, *summary.FinishedDate, logs, summary.Pages)
	return summary, nil
}

// yearFinishOrdinal counts the visible books that the reader finished in the
// same calendar year up to and including this one. Books finished at the same
// instant are ordered by ID so that every book gets a distinct position.
func yearFinishOrdinal(ctx context.Context, db *sql.DB, userID, bookID string, finishedAt int64, year int) (int, error) {
	var n int
	err := db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM user_book_status ubs
		INNER JOIN books b ON b.id = ubs.book_id
		WHERE ubs.user_id = ?
		  AND ubs.status = 'finished'
		  AND ubs.finished_at IS NOT NULL
		  AND CAST(strftime('%Y', ubs.finished_at, 'unixepoch', 'localtime') AS INTEGER) = ?
		  AND (ubs.finished_at < ? OR (ubs.finished_at = ? AND ubs.book_id <= ?))
		  AND EXISTS (
			SELECT 1 FROM collection_members cm
			WHERE cm.collection_id = b.collection_id AND cm.user_id = ubs.user_id
		  )
	`, userID, year, finishedAt, finishedAt, bookID).Scan(&n)
	return n, err
}

func readFinishWindowLogs(ctx context.Context, db *sql.DB, userID, bookID, startDate, finishDate string) ([]finishLog, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT date(occurred_at, 'unixepoch', 'localtime') AS d, progress_percent
		FROM user_book_progress_log
		WHERE user_id = ? AND book_id = ?
		  AND date(occurred_at, 'unixepoch', 'localtime') BETWEEN ? AND ?
		ORDER BY occurred_at ASC, created_at ASC, id ASC
	`, userID, bookID, startDate, finishDate)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	logs := make([]finishLog, 0)
	for rows.Next() {
		var l finishLog
		if err := rows.Scan(&l.Date, &l.Percent); err != nil {
			return nil, err
		}
		logs = append(logs, l)
	}
	return logs, rows.Err()
}

// GET /api/books/{id}/finish-summary
func (s *Service) handleGetFinishSummary(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	summary, err := ReadFinishSummary(r.Context(), s.db, userID, bookID)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id}/finish-summary failed", "Failed to fetch finish summary", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    summary,
	})
}
