package books_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type readingEnv struct {
	t            *testing.T
	srv          *httptest.Server
	client       *http.Client
	collectionID string
}

func newReadingEnv(t *testing.T) *readingEnv {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "dates.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{DB: opened.DB, Secret: "reading-dates-secret-0123456789abcdef012345", Logger: discard})
	colSvc := collections.NewService(collections.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	booksSvc := books.NewService(books.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	srv := httptest.NewServer(httpapi.NewHandler(httpapi.RouterOptions{
		DB: opened.DB, Logger: discard, AuthService: authSvc,
		Services: []httpapi.RouteRegistrar{colSvc, booksSvc},
	}))
	t.Cleanup(srv.Close)
	jar, _ := cookiejar.New(nil)
	e := &readingEnv{t: t, srv: srv, client: &http.Client{Jar: jar}}
	e.do(http.MethodPost, "/api/auth/sign-up/email", map[string]any{
		"name": "Reader", "email": "dates@example.test", "password": "StrongPassword123!",
	}, nil)
	var col struct {
		Data struct {
			Collection struct {
				ID string `json:"id"`
			} `json:"collection"`
		} `json:"data"`
	}
	e.do(http.MethodPost, "/api/collections", map[string]any{"name": "Mine"}, &col)
	e.collectionID = col.Data.Collection.ID
	return e
}

func (e *readingEnv) do(method, path string, body any, out any) {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, r)
	req.Header.Set("Origin", e.srv.URL)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := e.client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("%s %s: %d %s", method, path, resp.StatusCode, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			e.t.Fatalf("decode %s: %v", path, err)
		}
	}
}

func (e *readingEnv) book(title string) string {
	e.t.Helper()
	var out struct {
		Data struct {
			Book struct {
				ID string `json:"id"`
			} `json:"book"`
		} `json:"data"`
	}
	e.do(http.MethodPost, "/api/books", map[string]any{
		"title": title, "authors": []string{"Author"}, "collectionIds": []string{e.collectionID},
	}, &out)
	return out.Data.Book.ID
}

type statusDTO struct {
	Status     *string `json:"status"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	DnfAt      *string `json:"dnfAt"`
}

func (e *readingEnv) setStatus(bookID string, body map[string]any) statusDTO {
	e.t.Helper()
	var out struct {
		Data statusDTO `json:"data"`
	}
	e.do(http.MethodPost, "/api/books/"+bookID+"/status", body, &out)
	return out.Data
}

func (e *readingEnv) progressCount(bookID string) int {
	e.t.Helper()
	var out struct {
		Data struct {
			Logs []map[string]any `json:"logs"`
		} `json:"data"`
	}
	e.do(http.MethodGet, "/api/books/"+bookID+"/progress-logs", nil, &out)
	return len(out.Data.Logs)
}

func TestReadingDatesAreOptional(t *testing.T) {
	e := newReadingEnv(t)
	id := e.book("Optional Dates")

	// Finishing a book records today's finish date but invents no start date.
	st := e.setStatus(id, map[string]any{"status": "finished"})
	if st.Status == nil || *st.Status != "finished" || st.FinishedAt == nil || st.StartedAt != nil {
		t.Fatalf("finished = %+v", st)
	}
	if n := e.progressCount(id); n != 1 {
		t.Fatalf("finished progress entries = %d, want 1", n)
	}

	// Clearing the finish date keeps the status and removes the dated 100% entry.
	st = e.setStatus(id, map[string]any{"finishedAt": nil})
	if st.Status == nil || *st.Status != "finished" || st.FinishedAt != nil {
		t.Fatalf("cleared finish = %+v", st)
	}
	if n := e.progressCount(id); n != 0 {
		t.Fatalf("progress entries after clearing = %d, want 0", n)
	}

	// Choosing Finished again for a finished book does not refill the date.
	st = e.setStatus(id, map[string]any{"status": "finished"})
	if st.FinishedAt != nil {
		t.Fatalf("re-choosing finished filled a date: %+v", st)
	}

	// A status change can explicitly ask for no date.
	other := e.book("No Dates At All")
	st = e.setStatus(other, map[string]any{"status": "reading", "startedAt": nil})
	if st.Status == nil || *st.Status != "reading" || st.StartedAt != nil {
		t.Fatalf("reading without a start = %+v", st)
	}
	st = e.setStatus(other, map[string]any{"status": "dnf", "dnfAt": nil})
	if st.Status == nil || *st.Status != "dnf" || st.DnfAt != nil || st.StartedAt != nil {
		t.Fatalf("dnf without dates = %+v", st)
	}

	// Some dates: a start date can be cleared while the finish date stays.
	third := e.book("Some Dates")
	e.setStatus(third, map[string]any{"status": "finished", "startedAt": "2024-01-01", "finishedAt": "2024-02-01"})
	st = e.setStatus(third, map[string]any{"startedAt": nil})
	if st.Status == nil || *st.Status != "finished" || st.StartedAt != nil || st.FinishedAt == nil {
		t.Fatalf("cleared start = %+v", st)
	}
}

type listResponse struct {
	Data struct {
		Books []struct {
			ID    string `json:"id"`
			Title string `json:"title"`
		} `json:"books"`
		NextCursor *string `json:"nextCursor"`
	} `json:"data"`
}

func (e *readingEnv) listTitles(query url.Values) []string {
	e.t.Helper()
	var titles []string
	cursor := ""
	for page := 0; page < 10; page++ {
		q := url.Values{}
		for k, v := range query {
			q[k] = v
		}
		if cursor != "" {
			q.Set("cursor", cursor)
		}
		var out listResponse
		e.do(http.MethodGet, "/api/books?"+q.Encode(), nil, &out)
		for _, b := range out.Data.Books {
			titles = append(titles, b.Title)
		}
		if out.Data.NextCursor == nil {
			return titles
		}
		cursor = *out.Data.NextCursor
	}
	e.t.Fatal("pagination did not finish")
	return nil
}

func TestFinishDateFilterAndSort(t *testing.T) {
	e := newReadingEnv(t)
	for _, b := range []struct{ title, finished string }{
		{"Early 2023", "2023-03-01"},
		{"Late 2023", "2023-12-31"},
		{"Mid 2024", "2024-06-15"},
	} {
		id := e.book(b.title)
		e.setStatus(id, map[string]any{"status": "finished", "finishedAt": b.finished})
	}
	undated := e.book("Finished Undated")
	e.setStatus(undated, map[string]any{"status": "finished", "finishedAt": nil})
	dnf := e.book("Stopped")
	e.setStatus(dnf, map[string]any{"status": "dnf", "dnfAt": "2023-06-01"})
	e.book("Unread")

	got := e.listTitles(url.Values{"finishedStart": {"2023-01-01"}, "finishedEnd": {"2023-12-31"}, "sort": {"dateFinished"}, "sortDir": {"asc"}})
	if strings.Join(got, "|") != "Early 2023|Late 2023" {
		t.Fatalf("2023 filter = %v", got)
	}

	// Paging one book at a time exercises the cursor, including the books
	// without a finish date, which come last in both directions.
	desc := e.listTitles(url.Values{"sort": {"dateFinished"}, "limit": {"1"}})
	if len(desc) != 6 || strings.Join(desc[:3], "|") != "Mid 2024|Late 2023|Early 2023" {
		t.Fatalf("finish sort desc = %v", desc)
	}
	asc := e.listTitles(url.Values{"sort": {"dateFinished"}, "sortDir": {"asc"}, "limit": {"1"}})
	if len(asc) != 6 || strings.Join(asc[:3], "|") != "Early 2023|Late 2023|Mid 2024" {
		t.Fatalf("finish sort asc = %v", asc)
	}

	today := time.Now().Format("2006-01-02")
	if got := e.listTitles(url.Values{"finishedStart": {today}}); len(got) != 0 {
		t.Fatalf("future-only filter = %v", got)
	}
}
