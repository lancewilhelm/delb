package goodreads_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/goodreads"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type env struct {
	t   *testing.T
	db  *sql.DB
	srv *httptest.Server
}

type user struct {
	ID     string
	Cookie string
}

func newEnv(t *testing.T) *env {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	secret := "goodreads-test-secret-0123456789abcdef0123"
	authSvc := auth.NewService(auth.ServiceOptions{DB: opened.DB, Secret: secret, Logger: discard})
	colSvc := collections.NewService(collections.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	booksSvc := books.NewService(books.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	shelfSvc := bookshelf.NewService(bookshelf.ServiceOptions{DB: opened.DB, AuthService: authSvc, TokenSecret: secret, Logger: discard})
	grSvc := goodreads.NewService(goodreads.ServiceOptions{DB: opened.DB, AuthService: authSvc, BooksService: booksSvc, BookshelfService: shelfSvc, Logger: discard})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{colSvc, booksSvc, shelfSvc, grSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &env{t: t, db: opened.DB, srv: srv}
}

func (e *env) signUp(email string) user {
	e.t.Helper()
	b, _ := json.Marshal(map[string]any{"name": "Reader", "email": email, "password": "secret-password-12345"})
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/api/auth/sign-up/email", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.srv.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		e.t.Fatalf("signup: %d %s", resp.StatusCode, raw)
	}
	var out struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	var cookies []string
	for _, c := range resp.Cookies() {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	return user{ID: out.User.ID, Cookie: strings.Join(cookies, "; ")}
}

func (e *env) do(u user, method, path, contentType string, body io.Reader) (int, []byte) {
	e.t.Helper()
	req, _ := http.NewRequest(method, e.srv.URL+path, body)
	req.Header.Set("Origin", e.srv.URL)
	req.Header.Set("Cookie", u.Cookie)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

func (e *env) json(u user, method, path string, body any, out any) {
	e.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	status, raw := e.do(u, method, path, "application/json", rdr)
	if status != 200 {
		e.t.Fatalf("%s %s: %d %s", method, path, status, raw)
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			e.t.Fatalf("decode %s: %v (%s)", path, err, raw)
		}
	}
}

func (e *env) preview(u user, csv string) goodreads.Preview {
	e.t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "goodreads_library_export.csv")
	_, _ = fw.Write([]byte(csv))
	_ = mw.Close()
	status, raw := e.do(u, http.MethodPost, "/api/import/goodreads/preview", mw.FormDataContentType(), &buf)
	if status != 200 {
		e.t.Fatalf("preview: %d %s", status, raw)
	}
	var out struct {
		Data goodreads.Preview `json:"data"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		e.t.Fatal(err)
	}
	return out.Data
}

func (e *env) createBook(u user, collectionID, title, author, identifiers string) string {
	e.t.Helper()
	body := map[string]any{"title": title, "authors": []string{author}, "collectionIds": []string{collectionID}}
	if identifiers != "" {
		body["identifiers"] = identifiers
	}
	var out struct {
		Data struct {
			Book struct {
				ID string `json:"id"`
			} `json:"book"`
		} `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/books", body, &out)
	return out.Data.Book.ID
}

const exportHeader = "Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies\n"

const exportCSV = exportHeader +
	`7235533,"The Way of Kings (The Stormlight Archive, #1)",Brandon Sanderson,"Sanderson, Brandon",,"=""0765326353""","=""9780765326355""",5,4.65,Tor Books,Hardcover,1007,2010,2010,2023/05/14,2021/01/02,"fantasy, favorites","fantasy (#4), favorites (#1)",read,"Loved it.<br/>Really.",,Lent to Sam,1,0` + "\n" +
	`44767458,Dune (Dune #1),Frank Herbert,"Herbert, Frank",,"=""""","=""""",0,4.25,Ace,Paperback,,1990,1965,,2020/03/04,"to-read, sci-fi","to-read (#2), sci-fi (#1)",to-read,,,,0,0` + "\n" +
	`54493401,Project Hail Mary,Andy Weir,"Weir, Andy",,"=""""","=""9780593135204""",0,4.5,Ballantine,Hardcover,476,2021,2021,,2021/06/01,to-read,to-read (#1),to-read,,,,0,1` + "\n" +
	`999001,Some Abandoned Book,A. Writer,"Writer, A.",,,,2,,,,,,,2022/01/03,2021/12/01,did-not-finish,did-not-finish (#1),did-not-finish,,,,0,0` + "\n" +
	`999002,Currently Book,B. Writer,"Writer, B.",,,,0,,,,,,,,2024/01/01,currently-reading,currently-reading (#1),currently-reading,,,,0,0` + "\n"

func findRow(p goodreads.Preview, gid string) goodreads.PreviewRow {
	for _, r := range p.Rows {
		if r.GoodreadsID == gid {
			return r
		}
	}
	return goodreads.PreviewRow{}
}

type applyResponse struct {
	Data goodreads.ApplyResult `json:"data"`
}

func applyItems(p goodreads.Preview, bookIDs map[string]string, overwrite bool) []map[string]any {
	items := make([]map[string]any, 0, len(p.Rows))
	for _, r := range p.Rows {
		items = append(items, map[string]any{
			"index":          r.Index,
			"bookId":         bookIDs[r.GoodreadsID],
			"goodreadsId":    r.GoodreadsID,
			"exclusiveShelf": r.ExclusiveShelf,
			"dateRead":       r.DateRead,
			"dateAdded":      r.DateAdded,
			"tbrPosition":    r.TbrPosition,
			"rating":         r.Rating,
			"review":         r.Review,
			"spoiler":        r.Spoiler,
			"privateNotes":   r.PrivateNotes,
			"shelves":        r.Shelves,
			"overwrite":      overwrite,
		})
	}
	return items
}

func applyBody(items []map[string]any) map[string]any {
	return map[string]any{
		"items": items,
		"statusMap": map[string]any{
			"read": "finished", "to-read": "to_be_read", "currently-reading": "reading", "did-not-finish": "dnf",
		},
		"include": map[string]bool{"statuses": true, "ratings": true, "reviews": true, "notes": true, "shelves": true},
		"shelves": []string{"fantasy", "favorites", "sci-fi"},
	}
}

func localMidnight(t *testing.T, ymd string) int64 {
	tm, err := time.ParseInLocation("2006-01-02", ymd, time.Local)
	if err != nil {
		t.Fatal(err)
	}
	return tm.Unix()
}

func TestGoodreadsImportEndToEnd(t *testing.T) {
	e := newEnv(t)
	u := e.signUp("reader@example.com")

	var col struct {
		Data struct {
			Collection struct {
				ID string `json:"id"`
			} `json:"collection"`
		} `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/collections", map[string]any{"name": "Mine"}, &col)
	colID := col.Data.Collection.ID

	wokID := e.createBook(u, colID, "The Way of Kings", "Brandon Sanderson", "isbn13:9780765326355")
	duneID := e.createBook(u, colID, "Dune", "Frank Herbert", "")
	queuedID := e.createBook(u, colID, "Already Queued", "C. Writer", "")

	// Existing Delb data that conflicts with the export.
	e.json(u, http.MethodPost, "/api/books/"+wokID+"/status", map[string]any{"status": "finished", "finishedAt": "2021-02-02"}, nil)
	e.json(u, http.MethodPost, "/api/books/"+wokID+"/rating", map[string]any{"rating": 6}, nil)
	e.json(u, http.MethodPost, "/api/books/"+queuedID+"/status", map[string]any{"status": "to_be_read"}, nil)

	p := e.preview(u, exportCSV)
	if len(p.Rows) != 5 {
		t.Fatalf("rows = %d", len(p.Rows))
	}
	if m := findRow(p, "7235533").Match; m.Kind != goodreads.MatchISBN || m.BookID != wokID {
		t.Fatalf("way of kings match = %+v", m)
	}
	if m := findRow(p, "44767458").Match; m.Kind != goodreads.MatchTitle || m.BookID != duneID {
		t.Fatalf("dune match = %+v", m)
	}
	if m := findRow(p, "54493401").Match; m.Kind != goodreads.MatchNone {
		t.Fatalf("hail mary match = %+v", m)
	}
	if ex := p.Existing[wokID]; ex == nil || ex.Status == nil || *ex.Status != "finished" || ex.Rating == nil || *ex.Rating != 6 {
		t.Fatalf("existing = %+v", ex)
	}
	shelfNames := []string{}
	for _, s := range p.Shelves {
		shelfNames = append(shelfNames, s.Name)
	}
	if strings.Join(shelfNames, ",") != "fantasy,favorites,sci-fi" {
		t.Fatalf("shelves = %v", shelfNames)
	}

	// Create reference entries for the unmatched rows.
	var unmatched []goodreads.Row
	for _, r := range p.Rows {
		if r.Match.Kind == goodreads.MatchNone {
			unmatched = append(unmatched, r.Row)
		}
	}
	var created struct {
		Data struct {
			Results []goodreads.CreatedBook `json:"results"`
		} `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/import/goodreads/books", map[string]any{"collectionId": colID, "rows": unmatched}, &created)
	if len(created.Data.Results) != 3 {
		t.Fatalf("created = %+v", created.Data.Results)
	}
	bookIDs := map[string]string{"7235533": wokID, "44767458": duneID}
	for i, res := range created.Data.Results {
		if res.Error != "" || res.BookID == "" {
			t.Fatalf("create result = %+v", res)
		}
		bookIDs[unmatched[i].GoodreadsID] = res.BookID
	}
	var physical int
	_ = e.db.QueryRow(`SELECT has_physical_copy FROM books WHERE id = ?`, bookIDs["54493401"]).Scan(&physical)
	if physical != 1 {
		t.Fatalf("owned copy should mark a physical copy")
	}

	// Retrying the same batch reuses the entries.
	var retry struct {
		Data struct {
			Results []goodreads.CreatedBook `json:"results"`
		} `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/import/goodreads/books", map[string]any{"collectionId": colID, "rows": unmatched[:1]}, &retry)
	if !retry.Data.Results[0].Reused || retry.Data.Results[0].BookID != bookIDs[unmatched[0].GoodreadsID] {
		t.Fatalf("retry = %+v", retry.Data.Results)
	}

	var applied applyResponse
	e.json(u, http.MethodPost, "/api/import/goodreads/apply", applyBody(applyItems(p, bookIDs, false)), &applied)
	r := applied.Data.Reading
	if r.StatusesKept != 1 || r.StatusesSet != 4 || r.RatingsKept != 1 || r.RatingsSet != 1 || r.ReviewsSet != 1 || r.NotesAdded != 1 {
		t.Fatalf("reading result = %+v", r)
	}
	if applied.Data.ShelvesCreated != 3 || applied.Data.ShelfBooksAdded != 3 || applied.Data.IdentifiersLinked != 2 {
		t.Fatalf("apply result = %+v", applied.Data)
	}

	var finishedAt int64
	var rating int
	_ = e.db.QueryRow(`SELECT finished_at FROM user_book_status WHERE user_id = ? AND book_id = ?`, u.ID, wokID).Scan(&finishedAt)
	_ = e.db.QueryRow(`SELECT rating FROM book_ratings WHERE user_id = ? AND book_id = ?`, u.ID, wokID).Scan(&rating)
	if finishedAt != localMidnight(t, "2021-02-02") || rating != 6 {
		t.Fatalf("kept values changed: finished=%d rating=%d", finishedAt, rating)
	}

	order := []string{}
	rows, err := e.db.Query(`SELECT book_id FROM user_book_status WHERE user_id = ? AND status = 'to_be_read' ORDER BY tbr_rank`, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		order = append(order, id)
	}
	_ = rows.Close()
	if strings.Join(order, ",") != strings.Join([]string{queuedID, bookIDs["54493401"], duneID}, ",") {
		t.Fatalf("tbr order = %v", order)
	}

	var started sql.NullInt64
	var dnfAt sql.NullInt64
	_ = e.db.QueryRow(`SELECT started_at FROM user_book_status WHERE user_id = ? AND book_id = ?`, u.ID, bookIDs["999002"]).Scan(&started)
	if started.Valid {
		t.Fatalf("currently reading should leave started_at empty, got %d", started.Int64)
	}
	_ = e.db.QueryRow(`SELECT started_at, dnf_at FROM user_book_status WHERE user_id = ? AND book_id = ?`, u.ID, bookIDs["999001"]).Scan(&started, &dnfAt)
	if started.Valid || !dnfAt.Valid || dnfAt.Int64 != localMidnight(t, "2022-01-03") {
		t.Fatalf("dnf dates: started=%v dnf=%v", started, dnfAt)
	}

	var review struct {
		Data books.ReviewDTO `json:"data"`
	}
	e.json(u, http.MethodGet, "/api/books/"+wokID+"/review", nil, &review)
	if review.Data.Text != "Loved it.\nReally." {
		t.Fatalf("review = %+v", review.Data)
	}

	// A second import matches every row by Goodreads ID. Choosing the
	// Goodreads values replaces the kept ones without duplicating notes.
	p2 := e.preview(u, exportCSV)
	for _, row := range p2.Rows {
		if row.Match.Kind != goodreads.MatchGoodreads || row.Match.BookID != bookIDs[row.GoodreadsID] {
			t.Fatalf("second preview match for %s = %+v", row.GoodreadsID, row.Match)
		}
	}
	var applied2 applyResponse
	e.json(u, http.MethodPost, "/api/import/goodreads/apply", applyBody(applyItems(p2, bookIDs, true)), &applied2)
	if applied2.Data.Reading.StatusesSet != 1 || applied2.Data.Reading.RatingsSet != 1 || applied2.Data.Reading.NotesAdded != 0 || applied2.Data.ShelfBooksAdded != 0 {
		t.Fatalf("second apply = %+v", applied2.Data)
	}
	_ = e.db.QueryRow(`SELECT finished_at FROM user_book_status WHERE user_id = ? AND book_id = ?`, u.ID, wokID).Scan(&finishedAt)
	_ = e.db.QueryRow(`SELECT rating FROM book_ratings WHERE user_id = ? AND book_id = ?`, u.ID, wokID).Scan(&rating)
	if finishedAt != localMidnight(t, "2023-05-14") || rating != 10 {
		t.Fatalf("overwrite: finished=%d rating=%d", finishedAt, rating)
	}
	var startedWok sql.NullInt64
	_ = e.db.QueryRow(`SELECT started_at FROM user_book_status WHERE user_id = ? AND book_id = ?`, u.ID, wokID).Scan(&startedWok)
	if !startedWok.Valid || startedWok.Int64 != localMidnight(t, "2021-02-02") {
		t.Fatalf("overwrite should keep the earlier start date, got %v", startedWok)
	}
}

func TestGoodreadsImportIsolation(t *testing.T) {
	e := newEnv(t)
	owner := e.signUp("owner@example.com")
	other := e.signUp("other@example.com")
	var col struct {
		Data struct {
			Collection struct {
				ID string `json:"id"`
			} `json:"collection"`
		} `json:"data"`
	}
	e.json(owner, http.MethodPost, "/api/collections", map[string]any{"name": "Private"}, &col)
	hidden := e.createBook(owner, col.Data.Collection.ID, "The Way of Kings", "Brandon Sanderson", "isbn13:9780765326355")

	p := e.preview(other, exportCSV)
	for _, r := range p.Rows {
		if r.Match.BookID == hidden || len(p.Existing) != 0 {
			t.Fatalf("hidden book leaked into another reader's preview: %+v", r.Match)
		}
	}

	status, raw := e.do(other, http.MethodPost, "/api/import/goodreads/books", "application/json",
		strings.NewReader(`{"collectionId":"`+col.Data.Collection.ID+`","rows":[{"index":0,"title":"X","authors":["Y"]}]}`))
	if status == 200 {
		t.Fatalf("creating in another reader's collection should fail: %s", raw)
	}

	var applied applyResponse
	e.json(other, http.MethodPost, "/api/import/goodreads/apply", map[string]any{
		"items":     []map[string]any{{"index": 0, "bookId": hidden, "exclusiveShelf": "read", "rating": 5, "goodreadsId": "1"}},
		"statusMap": map[string]any{"read": "finished"},
		"include":   map[string]bool{"statuses": true, "ratings": true},
	}, &applied)
	if len(applied.Data.Reading.Unavailable) != 1 || applied.Data.Reading.StatusesSet != 0 || applied.Data.IdentifiersLinked != 0 {
		t.Fatalf("hidden book should be unavailable: %+v", applied.Data)
	}
}

func TestReviewsAndNotes(t *testing.T) {
	e := newEnv(t)
	u := e.signUp("notes@example.com")
	other := e.signUp("notes-other@example.com")
	var col struct {
		Data struct {
			Collection struct {
				ID string `json:"id"`
			} `json:"collection"`
		} `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/collections", map[string]any{"name": "Mine"}, &col)
	bookID := e.createBook(u, col.Data.Collection.ID, "Book", "Author", "")

	var review struct {
		Data books.ReviewDTO `json:"data"`
	}
	e.json(u, http.MethodPut, "/api/books/"+bookID+"/review", map[string]any{"text": "  Great.  ", "containsSpoilers": true}, &review)
	if review.Data.Text != "Great." || !review.Data.ContainsSpoilers || review.Data.CreatedAt == nil {
		t.Fatalf("review = %+v", review.Data)
	}
	e.json(u, http.MethodPut, "/api/books/"+bookID+"/review", map[string]any{"text": ""}, &review)
	if review.Data.Text != "" || review.Data.CreatedAt != nil {
		t.Fatalf("cleared review = %+v", review.Data)
	}

	var note struct {
		Data books.NoteDTO `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/books/"+bookID+"/notes", map[string]any{"text": "First"}, &note)
	e.json(u, http.MethodPut, "/api/books/"+bookID+"/notes/"+note.Data.ID, map[string]any{"text": "Edited"}, nil)
	var notes struct {
		Data []books.NoteDTO `json:"data"`
	}
	e.json(u, http.MethodGet, "/api/books/"+bookID+"/notes", nil, &notes)
	if len(notes.Data) != 1 || notes.Data[0].Text != "Edited" {
		t.Fatalf("notes = %+v", notes.Data)
	}

	if status, _ := e.do(other, http.MethodGet, "/api/books/"+bookID+"/notes", "", nil); status != 404 {
		t.Fatalf("other reader notes status = %d", status)
	}
	if status, _ := e.do(u, http.MethodPost, "/api/books/"+bookID+"/notes", "application/json", strings.NewReader(`{"text":"   "}`)); status != 400 {
		t.Fatalf("blank note status = %d", status)
	}
	e.json(u, http.MethodDelete, "/api/books/"+bookID+"/notes/"+note.Data.ID, nil, nil)
	e.json(u, http.MethodGet, "/api/books/"+bookID+"/notes", nil, &notes)
	if len(notes.Data) != 0 {
		t.Fatalf("notes after delete = %+v", notes.Data)
	}
}

func TestImportClosesQueueGap(t *testing.T) {
	e := newEnv(t)
	u := e.signUp("queue@example.com")
	var col struct {
		Data struct {
			Collection struct {
				ID string `json:"id"`
			} `json:"collection"`
		} `json:"data"`
	}
	e.json(u, http.MethodPost, "/api/collections", map[string]any{"name": "Mine"}, &col)
	ids := []string{}
	for _, title := range []string{"First", "Second", "Third"} {
		id := e.createBook(u, col.Data.Collection.ID, title, "Author", "")
		e.json(u, http.MethodPost, "/api/books/"+id+"/status", map[string]any{"status": "to_be_read"}, nil)
		ids = append(ids, id)
	}

	var applied applyResponse
	e.json(u, http.MethodPost, "/api/import/goodreads/apply", map[string]any{
		"items":     []map[string]any{{"index": 0, "bookId": ids[1], "exclusiveShelf": "read", "dateRead": "2024-01-01", "overwrite": true}},
		"statusMap": map[string]any{"read": "finished"},
		"include":   map[string]bool{"statuses": true},
	}, &applied)
	if applied.Data.Reading.StatusesSet != 1 {
		t.Fatalf("apply = %+v", applied.Data)
	}
	got := map[string]int{}
	rows, err := e.db.Query(`SELECT book_id, tbr_rank FROM user_book_status WHERE user_id = ? AND status = 'to_be_read'`, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		var rank int
		_ = rows.Scan(&id, &rank)
		got[id] = rank
	}
	_ = rows.Close()
	if len(got) != 2 || got[ids[0]] != 1 || got[ids[2]] != 2 {
		t.Fatalf("ranks after a book left the queue = %v", got)
	}
}
