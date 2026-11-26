package books_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
)

func (e *readingEnv) jsonStatus(method, path string, body any) int {
	e.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Origin", e.srv.URL)
	req.Header.Set("Content-Type", "application/json")
	resp, err := e.client.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

func TestReaderIsReadOnlyOnTheCatalog(t *testing.T) {
	owner := newReadingEnv(t)
	bookID := owner.book("Shared Catalog Entry")
	reader := owner.newReader("Reader", "catalog-reader@example.invalid")

	// Readers see the shared library.
	if titles := reader.listTitles(url.Values{}); len(titles) != 1 || titles[0] != "Shared Catalog Entry" {
		t.Fatalf("reader titles = %v", titles)
	}

	// Readers cannot add, edit, or delete catalog entries.
	for _, tc := range []struct {
		method, path string
		body         any
	}{
		{http.MethodPost, "/api/books", map[string]any{"title": "Nope", "authors": []string{"Someone"}}},
		{http.MethodPut, "/api/books/" + bookID, map[string]any{"title": "Renamed"}},
		{http.MethodDelete, "/api/books/" + bookID, map[string]any{}},
		{http.MethodPost, "/api/books/bulk/copies", map[string]any{"bookIds": []string{bookID}, "physical": true}},
		{http.MethodPost, "/api/books/metadata-import/create", map[string]any{"title": "Nope", "authors": []string{"Someone"}}},
	} {
		if code := reader.jsonStatus(tc.method, tc.path, tc.body); code != http.StatusForbidden {
			t.Fatalf("reader %s %s = %d, want 403", tc.method, tc.path, code)
		}
	}

	// Readers keep their own reading data.
	got := reader.setStatus(bookID, map[string]any{"status": "reading", "startedAt": "2026-03-01"})
	if got.Status == nil || *got.Status != "reading" {
		t.Fatalf("reader status = %+v", got)
	}

	// Editors can change the catalog.
	if _, err := owner.db.Exec(`UPDATE users SET role = 'editor' WHERE email = 'catalog-reader@example.invalid'`); err != nil {
		t.Fatalf("promote reader: %v", err)
	}
	if code := reader.jsonStatus(http.MethodPost, "/api/books", map[string]any{"title": "Editor Entry", "authors": []string{"Someone"}}); code != http.StatusOK {
		t.Fatalf("editor create book = %d, want 200", code)
	}
}

func TestHiddenQueuedBooksNeverShareARank(t *testing.T) {
	owner := newReadingEnv(t)
	ids := []string{owner.book("Queued One"), owner.book("Queued Two"), owner.book("Queued Three")}
	reader := owner.newReader("Queue Reader", "queue-reader@example.invalid")
	for _, id := range ids {
		reader.setStatus(id, map[string]any{"status": "to_be_read"})
	}
	for _, stmt := range []string{
		`INSERT INTO tags (id, name, created_at, updated_at) VALUES ('t-later', 'later', 0, 0)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES ('` + ids[0] + `', 't-later')`,
		`INSERT INTO user_tag_rules (user_id, tag_id, mode, created_at)
		 SELECT id, 't-later', 'block', 0 FROM users WHERE email = 'queue-reader@example.invalid'`,
	} {
		if _, err := owner.db.Exec(stmt); err != nil {
			t.Fatalf("seed rule: %v", err)
		}
	}

	// Move the last visible book to the front while the first book is hidden.
	reader.setStatus(ids[2], map[string]any{"status": "to_be_read", "tbrRank": 1})

	if _, err := owner.db.Exec(`DELETE FROM user_tag_rules`); err != nil {
		t.Fatalf("clear rules: %v", err)
	}
	rows, err := owner.db.Query(`
		SELECT ubs.book_id, ubs.tbr_rank FROM user_book_status ubs
		INNER JOIN users u ON u.id = ubs.user_id AND u.email = 'queue-reader@example.invalid'
		ORDER BY ubs.tbr_rank`)
	if err != nil {
		t.Fatalf("query ranks: %v", err)
	}
	defer rows.Close()
	var order []string
	var ranks []int64
	for rows.Next() {
		var id string
		var rank int64
		if err := rows.Scan(&id, &rank); err != nil {
			t.Fatal(err)
		}
		order = append(order, id)
		ranks = append(ranks, rank)
	}
	want := []string{ids[2], ids[1], ids[0]}
	if len(order) != 3 || order[0] != want[0] || order[1] != want[1] || order[2] != want[2] {
		t.Fatalf("queue order = %v, want %v (hidden book rejoins at the end)", order, want)
	}
	if ranks[0] != 1 || ranks[1] != 2 || ranks[2] != 3 {
		t.Fatalf("ranks = %v, want [1 2 3]", ranks)
	}
}
