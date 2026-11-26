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
	"path/filepath"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

func TestGenresCRUDMergeDeleteAndMetadataImport(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "genres.db")
	libDir := filepath.Join(tmp, "library")

	opened, err := db.Open(ctx, "file:"+dbPath)
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer opened.DB.Close()
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:     opened.DB,
		Secret: "genres-test-secret-0123456789abcdef0123456789",
		Logger: discard,
	})
	collectionsSvc := collections.NewService(collections.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		Logger:      discard,
	})
	booksSvc := books.NewService(books.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		LibraryDir:  libDir,
		Logger:      discard,
	})

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{collectionsSvc, booksSvc},
	})
	srv := httptest.NewServer(handler)
	defer srv.Close()

	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar}

	doJSON := func(method, path string, body any) (*http.Response, map[string]any) {
		t.Helper()
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+path, r)
		req.Header.Set("Origin", srv.URL)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var parsed map[string]any
		_ = json.Unmarshal(raw, &parsed)
		return resp, parsed
	}

	// Sign up owner account.
	resp, _ := doJSON(http.MethodPost, "/api/auth/sign-up/email", map[string]any{
		"name":     "Owner",
		"email":    "owner@example.invalid",
		"password": "StrongPassword123!",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sign-up status = %d", resp.StatusCode)
	}

	// 1. Metadata import routes provider categories into genres (NOT tags).
	resp, impBody := doJSON(http.MethodPost, "/api/books/metadata-import/create", map[string]any{
		"provider": "googleBooks",
		"item": map[string]any{
			"id": "gb-1",
			"volumeInfo": map[string]any{
				"title":      "The Cartographer's Almanac",
				"authors":    []string{"Maren Vance"},
				"categories": []string{"Speculative Fiction", "Fantasy"},
				"industryIdentifiers": []map[string]any{
					{"type": "ISBN_13", "identifier": "9780000000001"},
				},
			},
		},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("metadata import status = %d, body = %v", resp.StatusCode, impBody)
	}
	bookID := impBody["data"].(map[string]any)["book"].(map[string]any)["id"].(string)

	// Verify book detail has genres populated and tags empty.
	resp, getBody := doJSON(http.MethodGet, "/api/books/"+bookID, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET book status = %d", resp.StatusCode)
	}
	bookObj := getBody["data"].(map[string]any)["book"].(map[string]any)
	genres := bookObj["genres"].([]any)
	tags := bookObj["tags"].([]any)
	if len(genres) != 2 {
		t.Fatalf("expected 2 imported genres, got %v", genres)
	}
	if len(tags) != 0 {
		t.Fatalf("expected 0 imported tags, got %v", tags)
	}

	// 2. Add a manual tag and verify metadata replace_existing preserves manual tags while updating genres.
	resp, _ = doJSON(http.MethodPut, "/api/books/"+bookID, map[string]any{
		"tags": []string{"household-favorite"},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT book tags status = %d", resp.StatusCode)
	}

	resp, repBody := doJSON(http.MethodPost, "/api/books/metadata-import/create", map[string]any{
		"provider":        "googleBooks",
		"duplicateAction": "replace_existing",
		"existingBookId":  bookID,
		"item": map[string]any{
			"id": "gb-1",
			"volumeInfo": map[string]any{
				"title":      "The Cartographer's Almanac",
				"authors":    []string{"Maren Vance"},
				"categories": []string{"Science Fiction"},
				"industryIdentifiers": []map[string]any{
					{"type": "ISBN_13", "identifier": "9780000000001"},
				},
			},
		},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("metadata replace status = %d, body = %v", resp.StatusCode, repBody)
	}
	_, getBody = doJSON(http.MethodGet, "/api/books/"+bookID, nil)
	bookObj = getBody["data"].(map[string]any)["book"].(map[string]any)
	genres = bookObj["genres"].([]any)
	tags = bookObj["tags"].([]any)
	if len(genres) != 1 || genres[0].(map[string]any)["name"] != "Science Fiction" {
		t.Fatalf("expected genres [Science Fiction], got %v", genres)
	}
	if len(tags) != 1 || tags[0].(map[string]any)["name"] != "household-favorite" {
		t.Fatalf("expected manual tag preserved, got %v", tags)
	}

	// 3. Create a second book via POST /api/books with genres and test list/search/merge/delete.
	resp, createBody := doJSON(http.MethodPost, "/api/books", map[string]any{
		"title":   "Tidewater Hours",
		"authors": []string{"Isolde Brennan"},
		"genres":  []string{"Sci-Fi", "Literary Fiction"},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/books status = %d, body = %v", resp.StatusCode, createBody)
	}

	// List genres & global search genres bucket.
	resp, listGenres := doJSON(http.MethodGet, "/api/genres", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/genres status = %d", resp.StatusCode)
	}
	genreRows := listGenres["data"].(map[string]any)["genres"].([]any)
	genreIDByName := map[string]string{}
	for _, raw := range genreRows {
		m := raw.(map[string]any)
		genreIDByName[m["name"].(string)] = m["id"].(string)
	}
	if genreIDByName["Science Fiction"] == "" || genreIDByName["Sci-Fi"] == "" || genreIDByName["Literary Fiction"] == "" {
		t.Fatalf("unexpected genres list: %v", genreIDByName)
	}

	resp, searchBody := doJSON(http.MethodGet, "/api/search?q=Literary", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/search status = %d", resp.StatusCode)
	}
	gBucket := searchBody["data"].(map[string]any)["buckets"].(map[string]any)["genres"].([]any)
	if len(gBucket) != 1 || gBucket[0].(map[string]any)["name"] != "Literary Fiction" {
		t.Fatalf("expected Literary Fiction in search genres bucket, got %v", gBucket)
	}

	// Merge Sci-Fi -> Science Fiction.
	resp, mergeBody := doJSON(http.MethodPost, "/api/genres/"+genreIDByName["Sci-Fi"]+"/merge", map[string]any{
		"targetId": genreIDByName["Science Fiction"],
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST /api/genres/{id}/merge status = %d, body = %v", resp.StatusCode, mergeBody)
	}

	// Check Science Fiction now lists 2 books.
	resp, genreBooks := doJSON(http.MethodGet, "/api/genres/"+genreIDByName["Science Fiction"]+"/books", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/genres/{id}/books status = %d", resp.StatusCode)
	}
	if len(genreBooks["data"].(map[string]any)["books"].([]any)) != 2 {
		t.Fatalf("expected 2 books under merged Science Fiction genre, got %v", genreBooks)
	}

	// Delete Literary Fiction genre.
	resp, _ = doJSON(http.MethodDelete, "/api/genres/"+genreIDByName["Literary Fiction"], nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("DELETE /api/genres/{id} status = %d", resp.StatusCode)
	}
	resp, _ = doJSON(http.MethodGet, "/api/genres/"+genreIDByName["Literary Fiction"]+"/books", nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 after deleting genre, got %d", resp.StatusCode)
	}
}
