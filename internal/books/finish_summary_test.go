package books_test

import (
	"net/http"
	"net/http/cookiejar"
	"testing"
)

type finishSummaryDTO struct {
	Book struct {
		ID             string   `json:"id"`
		Title          string   `json:"title"`
		Authors        []string `json:"authors"`
		Pages          *int64   `json:"pages"`
		CoverImagePath *string  `json:"coverImagePath"`
		UpdatedAt      string   `json:"updatedAt"`
	} `json:"book"`
	Status            *string  `json:"status"`
	StartedDate       *string  `json:"startedDate"`
	FinishedDate      *string  `json:"finishedDate"`
	DurationDays      *int     `json:"durationDays"`
	Pages             *int64   `json:"pages"`
	PagesPerDay       *float64 `json:"pagesPerDay"`
	Rating            *int64   `json:"rating"`
	FinishYear        *int     `json:"finishYear"`
	YearFinishOrdinal *int     `json:"yearFinishOrdinal"`
	Progress          struct {
		CheckpointCount int `json:"checkpointCount"`
		Days            []struct {
			Date          string  `json:"date"`
			Percent       float64 `json:"percent"`
			DeltaPercent  float64 `json:"deltaPercent"`
			Pages         *int64  `json:"pages"`
			PagesRead     *int64  `json:"pagesRead"`
			HasCheckpoint bool    `json:"hasCheckpoint"`
		} `json:"days"`
	} `json:"progress"`
	// Private fields that must never appear.
	Notes  any `json:"notes"`
	Review any `json:"review"`
}

func (e *readingEnv) finishSummary(bookID string) finishSummaryDTO {
	e.t.Helper()
	var out struct {
		Data finishSummaryDTO `json:"data"`
	}
	e.do(http.MethodGet, "/api/books/"+bookID+"/finish-summary", nil, &out)
	return out.Data
}

func (e *readingEnv) statusCode(method, path string) int {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, nil)
	req.Header.Set("Origin", e.srv.URL)
	resp, err := e.client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// newReader signs up another account on the same server.
func (e *readingEnv) newReader(name, email string) *readingEnv {
	e.t.Helper()
	jar, _ := cookiejar.New(nil)
	other := &readingEnv{t: e.t, srv: e.srv, client: &http.Client{Jar: jar}}
	other.do(http.MethodPost, "/api/auth/sign-up/email", map[string]any{
		"name": name, "email": email, "password": "StrongPassword123!",
	}, nil)
	return other
}

func (e *readingEnv) bookWithPages(title string, pages int) string {
	e.t.Helper()
	var out struct {
		Data struct {
			Book struct {
				ID string `json:"id"`
			} `json:"book"`
		} `json:"data"`
	}
	e.do(http.MethodPost, "/api/books", map[string]any{
		"title": title, "authors": []string{"Ada Example", "Ben Sample"}, "pages": pages,
		"collectionIds": []string{e.collectionID},
	}, &out)
	return out.Data.Book.ID
}

func (e *readingEnv) logProgress(bookID, date string, percent float64) {
	e.t.Helper()
	e.do(http.MethodPost, "/api/books/"+bookID+"/progress-logs", map[string]any{
		"progressPercent": percent, "occurredAt": date,
	}, nil)
}

func TestFinishSummaryStatsAndSeries(t *testing.T) {
	e := newReadingEnv(t)
	id := e.bookWithPages("Synthetic Almanac", 400)

	e.setStatus(id, map[string]any{"status": "reading", "startedAt": "2026-03-01"})
	e.logProgress(id, "2026-03-02", 20)
	e.logProgress(id, "2026-03-04", 55)
	e.logProgress(id, "2026-03-04", 50) // lower entry on the same day
	e.logProgress(id, "2026-02-20", 90) // before the start: outside the window
	e.setStatus(id, map[string]any{"status": "finished", "finishedAt": "2026-03-08"})
	e.do(http.MethodPost, "/api/books/"+id+"/rating", map[string]any{"rating": 9}, nil)
	e.do(http.MethodPut, "/api/books/"+id+"/review", map[string]any{"text": "Private review text", "containsSpoilers": true}, nil)
	e.do(http.MethodPost, "/api/books/"+id+"/notes", map[string]any{"text": "Private note text"}, nil)

	got := e.finishSummary(id)
	if got.Book.Title != "Synthetic Almanac" || len(got.Book.Authors) != 2 || got.Book.Authors[0] != "Ada Example" {
		t.Fatalf("book = %+v", got.Book)
	}
	if got.Status == nil || *got.Status != "finished" {
		t.Fatalf("status = %v", got.Status)
	}
	if got.StartedDate == nil || *got.StartedDate != "2026-03-01" || got.FinishedDate == nil || *got.FinishedDate != "2026-03-08" {
		t.Fatalf("dates = %v / %v", got.StartedDate, got.FinishedDate)
	}
	if got.DurationDays == nil || *got.DurationDays != 8 {
		t.Fatalf("durationDays = %v, want 8", got.DurationDays)
	}
	if got.Pages == nil || *got.Pages != 400 || got.PagesPerDay == nil || *got.PagesPerDay != 50 {
		t.Fatalf("pages = %v, pagesPerDay = %v", got.Pages, got.PagesPerDay)
	}
	if got.Rating == nil || *got.Rating != 9 {
		t.Fatalf("rating = %v", got.Rating)
	}
	if got.FinishYear == nil || *got.FinishYear != 2026 || got.YearFinishOrdinal == nil || *got.YearFinishOrdinal != 1 {
		t.Fatalf("year ordinal = %v of %v", got.YearFinishOrdinal, got.FinishYear)
	}
	if got.Notes != nil || got.Review != nil {
		t.Fatalf("summary leaked private text: notes=%v review=%v", got.Notes, got.Review)
	}

	// Checkpoints on Mar 2, Mar 4, and the finish entry on Mar 8.
	if got.Progress.CheckpointCount != 3 || len(got.Progress.Days) != 8 {
		t.Fatalf("progress = %d checkpoints, %d days", got.Progress.CheckpointCount, len(got.Progress.Days))
	}
	wantPct := []float64{0, 20, 20, 55, 55, 55, 55, 100}
	for i, d := range got.Progress.Days {
		if d.Percent != wantPct[i] {
			t.Fatalf("day %d (%s) percent = %v, want %v", i, d.Date, d.Percent, wantPct[i])
		}
	}
	if d := got.Progress.Days[3]; d.PagesRead == nil || *d.PagesRead != 140 || d.Pages == nil || *d.Pages != 220 {
		t.Fatalf("Mar 4 pages = %v read %v", d.Pages, d.PagesRead)
	}
}

func TestFinishSummaryYearOrdinal(t *testing.T) {
	e := newReadingEnv(t)
	first := e.book("First of the Year")
	second := e.book("Second of the Year")
	lastYear := e.book("Last Year")
	e.setStatus(first, map[string]any{"status": "finished", "finishedAt": "2025-01-10"})
	e.setStatus(second, map[string]any{"status": "finished", "finishedAt": "2025-04-02"})
	e.setStatus(lastYear, map[string]any{"status": "finished", "finishedAt": "2024-12-31"})

	if got := e.finishSummary(second); got.YearFinishOrdinal == nil || *got.YearFinishOrdinal != 2 || *got.FinishYear != 2025 {
		t.Fatalf("second ordinal = %v of %v", got.YearFinishOrdinal, got.FinishYear)
	}
	if got := e.finishSummary(first); got.YearFinishOrdinal == nil || *got.YearFinishOrdinal != 1 {
		t.Fatalf("first ordinal = %v", got.YearFinishOrdinal)
	}
	if got := e.finishSummary(lastYear); got.YearFinishOrdinal == nil || *got.YearFinishOrdinal != 1 || *got.FinishYear != 2024 {
		t.Fatalf("last-year ordinal = %v of %v", got.YearFinishOrdinal, got.FinishYear)
	}
}

func TestFinishSummaryMissingDates(t *testing.T) {
	e := newReadingEnv(t)

	// Finished without a start date: no duration, pace, or series.
	noStart := e.bookWithPages("No Start", 250)
	e.setStatus(noStart, map[string]any{"status": "finished", "finishedAt": "2026-05-01"})
	got := e.finishSummary(noStart)
	if got.DurationDays != nil || got.PagesPerDay != nil || len(got.Progress.Days) != 0 {
		t.Fatalf("no start = duration %v, pace %v, days %d", got.DurationDays, got.PagesPerDay, len(got.Progress.Days))
	}
	if got.Pages == nil || *got.Pages != 250 || got.FinishedDate == nil {
		t.Fatalf("no start pages = %v, finished = %v", got.Pages, got.FinishedDate)
	}

	// No page count: duration but no page stats.
	noPages := e.book("No Pages")
	e.setStatus(noPages, map[string]any{"status": "finished", "startedAt": "2026-05-01", "finishedAt": "2026-05-01"})
	got = e.finishSummary(noPages)
	if got.DurationDays == nil || *got.DurationDays != 1 || got.Pages != nil || got.PagesPerDay != nil {
		t.Fatalf("no pages = duration %v, pages %v, pace %v", got.DurationDays, got.Pages, got.PagesPerDay)
	}
	if len(got.Progress.Days) != 1 || got.Progress.Days[0].Pages != nil {
		t.Fatalf("no pages series = %+v", got.Progress.Days)
	}

	// No status at all still returns the book.
	unread := e.book("Unread")
	got = e.finishSummary(unread)
	if got.Status != nil || got.FinishedDate != nil || got.YearFinishOrdinal != nil || got.Book.Title != "Unread" {
		t.Fatalf("unread = %+v", got)
	}
}

func TestFinishSummaryAccessAndOwnership(t *testing.T) {
	owner := newReadingEnv(t)
	id := owner.bookWithPages("Shared Synthetic", 300)
	owner.setStatus(id, map[string]any{"status": "finished", "startedAt": "2026-01-01", "finishedAt": "2026-01-10"})
	owner.do(http.MethodPost, "/api/books/"+id+"/rating", map[string]any{"rating": 10}, nil)

	stranger := owner.newReader("Stranger", "stranger@example.invalid")
	if code := stranger.statusCode(http.MethodGet, "/api/books/"+id+"/finish-summary"); code != http.StatusNotFound {
		t.Fatalf("stranger finish-summary = %d, want 404", code)
	}

	anon := &readingEnv{t: t, srv: owner.srv, client: &http.Client{}}
	if code := anon.statusCode(http.MethodGet, "/api/books/"+id+"/finish-summary"); code != http.StatusUnauthorized {
		t.Fatalf("anonymous finish-summary = %d, want 401", code)
	}

	// A collection member sees the book but only their own reading data.
	member := owner.newReader("Member", "member@example.invalid")
	owner.do(http.MethodPut, "/api/collections/"+owner.collectionID+"/members", map[string]any{
		"email": "member@example.invalid", "role": "viewer",
	}, nil)
	got := member.finishSummary(id)
	if got.Book.Title != "Shared Synthetic" {
		t.Fatalf("member book = %+v", got.Book)
	}
	if got.Status != nil || got.Rating != nil || got.DurationDays != nil || got.Progress.CheckpointCount != 0 {
		t.Fatalf("member saw the owner's reading data: %+v", got)
	}
	member.setStatus(id, map[string]any{"status": "finished", "finishedAt": "2026-02-01"})
	got = member.finishSummary(id)
	if got.FinishedDate == nil || *got.FinishedDate != "2026-02-01" || got.YearFinishOrdinal == nil || *got.YearFinishOrdinal != 1 {
		t.Fatalf("member summary = finished %v, ordinal %v", got.FinishedDate, got.YearFinishOrdinal)
	}
}
