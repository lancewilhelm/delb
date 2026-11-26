package bookshelf_test

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type testEnv struct {
	t      *testing.T
	db     *db.OpenResult
	server *httptest.Server
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	secret := "test-bookshelf-secret-0123456789abcdef0123456789"
	libDir := filepath.Join(tmp, "library")
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:     opened.DB,
		Secret: secret,
		Logger: discard,
	})
	colSvc := collections.NewService(collections.ServiceOptions{
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
	shelfSvc := bookshelf.NewService(bookshelf.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		TokenSecret: secret,
		Logger:      discard,
	})

	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{colSvc, booksSvc, shelfSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)

	return &testEnv{t: t, db: opened, server: srv}
}

type testUser struct {
	id     string
	email  string
	cookie string
}

func (e *testEnv) signUp(name, email string) testUser {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{
		"name":     name,
		"email":    email,
		"password": "very-strong-password-123456",
	})
	req, _ := http.NewRequest(http.MethodPost, e.server.URL+"/api/auth/sign-up/email", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.server.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("signUp %s: %v", email, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		e.t.Fatalf("signUp %s status %d: %s", email, resp.StatusCode, string(b))
	}
	var parsed struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&parsed)
	var cookies []string
	for _, c := range resp.Cookies() {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	return testUser{id: parsed.User.ID, email: email, cookie: strings.Join(cookies, "; ")}
}

func (e *testEnv) reqJSON(u *testUser, method, path string, payload any) (*http.Response, []byte) {
	e.t.Helper()
	var body io.Reader
	if payload != nil {
		b, _ := json.Marshal(payload)
		body = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.server.URL+path, body)
	req.Header.Set("Origin", e.server.URL)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if u != nil {
		req.Header.Set("Cookie", u.cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatalf("%s %s: %v", method, path, err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	return resp, raw
}

func makePNG(t *testing.T, w, h int, c color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func TestGeometryParseReconcileAndCompose(t *testing.T) {
	// Parse rejects empty bookcases, duplicate books, overlapping items, oversized height.
	if bookshelf.ParseBookshelfJSON([]byte(`{"bookcases":[]}`)) != nil {
		t.Fatal("expected empty bookcases to fail")
	}
	valid := bookshelf.EmptyBookshelf()
	valid.Bookcases[0].Shelves[0].Items = []bookshelf.ShelfItem{
		{
			X:          2,
			Horizontal: false,
			Books: []bookshelf.ShelfBook{
				{ID: "a", Width: 30, Height: 200, ManualWidth: false, ManualHeight: false},
			},
		},
		{
			X:          32,
			Horizontal: false,
			Books: []bookshelf.ShelfBook{
				{ID: "b", Width: 30, Height: 200, ManualWidth: false, ManualHeight: false},
			},
		},
	}
	if bookshelf.ParseBookshelfStruct(valid) == nil {
		t.Fatal("expected valid shelf to parse")
	}
	valid.Bookcases[0].Shelves[0].Items[1].X = 31
	if bookshelf.ParseBookshelfStruct(valid) != nil {
		t.Fatal("expected overlapping items to fail")
	}
	valid.Bookcases[0].Shelves[0].Items[1].X = 32
	valid.Bookcases[0].Shelves[0].Height = 150
	if bookshelf.ParseBookshelfStruct(valid) != nil {
		t.Fatal("expected book taller than shelf to fail")
	}

	// Reconcile preserves gaps, appends returning books, updates auto width only when fitting.
	bs := bookshelf.EmptyBookshelf()
	bs.Bookcases[0].Shelves[0].Items = []bookshelf.ShelfItem{
		{X: 2, Horizontal: false, Books: []bookshelf.ShelfBook{{ID: "a", Width: 30, Height: 200}}},
		{X: 32, Horizontal: false, Books: []bookshelf.ShelfBook{{ID: "b", Width: 30, Height: 200}}},
		{X: 180, Horizontal: false, Books: []bookshelf.ShelfBook{{ID: "c", Width: 30, Height: 200, ManualWidth: true}}},
	}
	pages800 := 800
	rec, needsAdj, _ := bookshelf.ReconcileBookshelf(bs, []bookshelf.ShelfCatalogBook{
		{ID: "a", Pages: &pages800},
		{ID: "b"},
		{ID: "c", Pages: &pages800},
	})
	if len(needsAdj) != 1 || needsAdj[0] != "a" {
		t.Fatalf("needsAdj = %v, want [a]", needsAdj)
	}
	if rec.Bookcases[0].Shelves[0].Items[0].Books[0].Width != 30 {
		t.Fatalf("expected non-fitting book a to keep width 30")
	}
	if rec.Bookcases[0].Shelves[0].Items[2].Books[0].Width != 30 {
		t.Fatalf("expected manual book c to keep width 30")
	}

	// Compose handles staggered stacks and dormant/resized books without displacing unchanged books.
	geomRaw := []byte(`{"bookcases":[{"id":"case","width":340,"shelves":[{"id":"row","height":245,"items":[]}]}]}`)
	bx20, bx35 := 20, 35
	members := []bookshelf.BookLayoutEntry{
		{
			Book: bookshelf.ShelfBook{ID: "a", Width: 40, Height: 200},
			Placement: &bookshelf.BookPlacementAnchor{
				CaseID: "case", ShelfID: "row", StackID: "stack", X: 20, BookX: &bx20, Horizontal: true, Order: 0,
			},
		},
		{
			Book: bookshelf.ShelfBook{ID: "b", Width: 40, Height: 200},
			Placement: &bookshelf.BookPlacementAnchor{
				CaseID: "case", ShelfID: "row", StackID: "stack", X: 20, BookX: &bx35, Horizontal: true, Order: 1,
			},
		},
	}
	onlyB, _, err := bookshelf.ComposeBookshelfLayout(geomRaw, []bookshelf.BookLayoutEntry{members[1]}, "shelf")
	if err != nil {
		t.Fatalf("compose single: %v", err)
	}
	if onlyB.Bookcases[0].Shelves[0].Items[0].X != 35 {
		t.Fatalf("expected single visible stacked book at x=35, got %d", onlyB.Bookcases[0].Shelves[0].Items[0].X)
	}
	restored, _, err := bookshelf.ComposeBookshelfLayout(geomRaw, members, "shelf")
	if err != nil {
		t.Fatalf("compose restored: %v", err)
	}
	st := restored.Bookcases[0].Shelves[0].Items[0]
	if st.X != 20 || len(st.Books) != 2 || *st.Books[0].OffsetX != 0 || *st.Books[1].OffsetX != 15 {
		t.Fatalf("unexpected restored stack: %+v", st)
	}
}

func TestUserBookshelfAndConcurrency(t *testing.T) {
	env := newTestEnv(t)
	a := env.signUp("Alice", "alice@example.invalid")
	b := env.signUp("Bob", "bob@example.invalid")

	resp, raw := env.reqJSON(&a, http.MethodGet, "/api/bookshelf", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"revision":0`) {
		t.Fatalf("initial GET /api/bookshelf = %d %s", resp.StatusCode, string(raw))
	}

	arr := map[string]any{
		"bookcases": []any{
			map[string]any{
				"id":    "case",
				"width": 480,
				"shelves": []any{
					map[string]any{"id": "shelf", "height": 245, "items": []any{}},
				},
			},
		},
	}
	resp, raw = env.reqJSON(&a, http.MethodPut, "/api/bookshelf", map[string]any{"revision": 0, "arrangement": arr})
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"revision":1`) {
		t.Fatalf("PUT rev 0 = %d %s", resp.StatusCode, string(raw))
	}
	// Stale revision -> 409
	resp, _ = env.reqJSON(&a, http.MethodPut, "/api/bookshelf", map[string]any{"revision": 0, "arrangement": arr})
	if resp.StatusCode != 409 {
		t.Fatalf("stale PUT = %d, want 409", resp.StatusCode)
	}
	// Bob sees empty shelf
	resp, raw = env.reqJSON(&b, http.MethodGet, "/api/bookshelf", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"arrangement":null`) {
		t.Fatalf("bob GET = %d %s", resp.StatusCode, string(raw))
	}

	// Concurrent writes at rev 1 -> exactly one 200 and one 409
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			r, _ := env.reqJSON(&a, http.MethodPut, "/api/bookshelf", map[string]any{"revision": 1, "arrangement": arr})
			codes[idx] = r.StatusCode
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 200)) {
		t.Fatalf("concurrent codes = %v, want [200,409]", codes)
	}
}

func TestCollectionBookshelfPicturesAndPersonalShelves(t *testing.T) {
	env := newTestEnv(t)
	owner := env.signUp("Owner", "owner@example.invalid")
	viewer := env.signUp("Viewer", "viewer@example.invalid")
	outsider := env.signUp("Outsider", "outsider@example.invalid")

	// Create collection & add viewer
	resp, raw := env.reqJSON(&owner, http.MethodPost, "/api/collections", map[string]any{"name": "Shared"})
	if resp.StatusCode != 200 {
		t.Fatalf("create collection: %d %s", resp.StatusCode, string(raw))
	}
	var colRes struct {
		Data struct {
			Collection struct {
				ID string `json:"id"`
			} `json:"collection"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &colRes)
	colID := colRes.Data.Collection.ID

	resp, _ = env.reqJSON(&owner, http.MethodPut, "/api/collections/"+colID+"/members", map[string]any{
		"email": viewer.email,
		"role":  "viewer",
	})
	if resp.StatusCode != 200 {
		t.Fatalf("add viewer: %d", resp.StatusCode)
	}

	// Create book
	resp, raw = env.reqJSON(&owner, http.MethodPost, "/api/books", map[string]any{
		"title":         "Dune",
		"authors":       []string{"Frank Herbert"},
		"pages":         500,
		"collectionIds": []string{colID},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("create book: %d %s", resp.StatusCode, string(raw))
	}
	var bookRes struct {
		Data struct {
			Book struct {
				ID string `json:"id"`
			} `json:"book"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &bookRes)
	bookID := bookRes.Data.Book.ID

	// Collection bookshelf: owner can edit, viewer read-only, outsider 404
	resp, raw = env.reqJSON(&owner, http.MethodGet, "/api/collections/"+colID+"/bookshelf", nil)
	if resp.StatusCode != 200 {
		t.Fatalf("GET collection bookshelf: %d %s", resp.StatusCode, string(raw))
	}
	var snap map[string]any
	_ = json.Unmarshal(raw, &snap)
	if snap["canEdit"] != true {
		t.Fatalf("owner canEdit = %v", snap["canEdit"])
	}
	resp, _ = env.reqJSON(&outsider, http.MethodGet, "/api/collections/"+colID+"/bookshelf", nil)
	if resp.StatusCode != 404 {
		t.Fatalf("outsider GET = %d, want 404", resp.StatusCode)
	}
	resp, _ = env.reqJSON(&viewer, http.MethodPut, "/api/collections/"+colID+"/bookshelf", map[string]any{
		"revision":    snap["revision"],
		"token":       snap["token"],
		"arrangement": snap["arrangement"],
	})
	if resp.StatusCode != 403 {
		t.Fatalf("viewer PUT = %d, want 403", resp.StatusCode)
	}

	// Upload picture to collection bookshelf
	uploadPic := func(u *testUser, path string, img []byte) (*http.Response, []byte) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", "pic.png")
		_, _ = fw.Write(img)
		_ = mw.Close()
		req, _ := http.NewRequest(http.MethodPost, env.server.URL+path, &buf)
		req.Header.Set("Origin", env.server.URL)
		req.Header.Set("Cookie", u.cookie)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("uploadPic: %v", err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		return r, b
	}

	pngBytes := makePNG(t, 40, 20, color.RGBA{R: 180, G: 100, B: 50, A: 255})
	picPath := "/api/bookshelf-pictures/collection/" + colID
	resp, _ = uploadPic(&viewer, picPath, pngBytes)
	if resp.StatusCode != 403 {
		t.Fatalf("viewer upload picture = %d, want 403", resp.StatusCode)
	}
	resp, raw = uploadPic(&owner, picPath, pngBytes)
	if resp.StatusCode != 200 {
		t.Fatalf("owner upload picture = %d %s", resp.StatusCode, string(raw))
	}
	var picRes struct {
		ID     string `json:"id"`
		Width  int    `json:"width"`
		Height int    `json:"height"`
	}
	_ = json.Unmarshal(raw, &picRes)
	if picRes.ID == "" || picRes.Width != 40 || picRes.Height != 20 {
		t.Fatalf("unexpected picture result: %+v", picRes)
	}
	// Viewer cannot see unreferenced picture yet
	resp, _ = env.reqJSON(&viewer, http.MethodGet, picPath+"?asset="+picRes.ID, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("viewer unreferenced picture = %d, want 404", resp.StatusCode)
	}

	// Attach picture & save collection bookshelf
	arrMap := snap["arrangement"].(map[string]any)
	arrMap["pictures"] = []any{
		map[string]any{
			"id": "p1", "assetId": picRes.ID, "x": 10, "y": 20, "width": 80, "height": 40, "rotation": 15,
		},
	}
	resp, raw = env.reqJSON(&owner, http.MethodPut, "/api/collections/"+colID+"/bookshelf", map[string]any{
		"revision":    snap["revision"],
		"token":       snap["token"],
		"arrangement": arrMap,
	})
	if resp.StatusCode != 200 {
		t.Fatalf("save collection bookshelf with picture = %d %s", resp.StatusCode, string(raw))
	}
	// Now viewer CAN read picture as image/webp with private caching + ETag + 304 support
	resp, _ = env.reqJSON(&viewer, http.MethodGet, picPath+"?asset="+picRes.ID, nil)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "image/webp") {
		t.Fatalf("viewer referenced picture = %d ct=%s", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	if resp.Header.Get("Cache-Control") != "private, max-age=300, stale-while-revalidate=3600" ||
		resp.Header.Get("ETag") == "" ||
		resp.Header.Get("Vary") != "Cookie" {
		t.Fatalf("unexpected picture cache headers: cc=%q etag=%q vary=%q",
			resp.Header.Get("Cache-Control"), resp.Header.Get("ETag"), resp.Header.Get("Vary"))
	}
	inmReq, _ := http.NewRequest(http.MethodGet, env.server.URL+picPath+"?asset="+picRes.ID, nil)
	inmReq.Header.Set("Cookie", viewer.cookie)
	inmReq.Header.Set("If-None-Match", resp.Header.Get("ETag"))
	inmResp, err := http.DefaultClient.Do(inmReq)
	if err != nil {
		t.Fatalf("picture 304: %v", err)
	}
	inmResp.Body.Close()
	if inmResp.StatusCode != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified for picture ETag, got %d", inmResp.StatusCode)
	}

	// Personal shelf lifecycle & viewer resize protection
	resp, raw = env.reqJSON(&viewer, http.MethodPost, "/api/shelves", map[string]any{"name": "My Favs"})
	if resp.StatusCode != 200 {
		t.Fatalf("create personal shelf: %d %s", resp.StatusCode, string(raw))
	}
	var shelfCreate struct {
		Data struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &shelfCreate)
	shelfID := shelfCreate.Data.ID

	// Add book to personal shelf
	resp, raw = env.reqJSON(&viewer, http.MethodPost, "/api/shelves/"+shelfID+"/books", map[string]any{
		"action":  "add",
		"bookIds": []string{bookID},
	})
	if resp.StatusCode != 200 {
		t.Fatalf("add book to shelf: %d %s", resp.StatusCode, string(raw))
	}

	// Check GET /api/books/{id}/shelves
	resp, raw = env.reqJSON(&viewer, http.MethodGet, "/api/books/"+bookID+"/shelves", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"containsBook":true`) {
		t.Fatalf("GET book shelves = %d %s", resp.StatusCode, string(raw))
	}

	// Rename & delete shelf
	resp, _ = env.reqJSON(&viewer, http.MethodPatch, "/api/shelves/"+shelfID, map[string]any{"name": "Renamed"})
	if resp.StatusCode != 200 {
		t.Fatalf("PATCH shelf = %d", resp.StatusCode)
	}
	resp, raw = env.reqJSON(&viewer, http.MethodGet, "/api/shelves", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"Renamed"`) {
		t.Fatalf("GET /api/shelves = %d %s", resp.StatusCode, string(raw))
	}
	resp, raw = env.reqJSON(&viewer, http.MethodGet, "/api/shelves?previews=25", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), bookID) || !strings.Contains(string(raw), `"spineRevision"`) {
		t.Fatalf("GET /api/shelves?previews=25 = %d %s", resp.StatusCode, string(raw))
	}
	for _, bad := range []string{"0", "26", "x"} {
		resp, _ = env.reqJSON(&viewer, http.MethodGet, "/api/shelves?previews="+bad, nil)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("GET /api/shelves?previews=%s = %d, want 400", bad, resp.StatusCode)
		}
	}
	for _, bad := range []string{"0", "251", "x"} {
		resp, _ = env.reqJSON(&viewer, http.MethodGet, "/api/shelves?pile="+bad, nil)
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("GET /api/shelves?pile=%s = %d, want 400", bad, resp.StatusCode)
		}
	}
	// A pile sample comes only when asked for, and holds the shelf's visible books.
	if strings.Contains(string(raw), `"pile"`) {
		t.Fatalf("GET /api/shelves?previews=25 includes a pile: %s", string(raw))
	}
	resp, raw = env.reqJSON(&viewer, http.MethodGet, "/api/shelves?previews=25&pile=100", nil)
	var withPile struct {
		Data struct {
			Shelves []struct {
				ID   string `json:"id"`
				Pile []struct {
					ID string `json:"id"`
				} `json:"pile"`
			} `json:"shelves"`
		} `json:"data"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(raw, &withPile) != nil {
		t.Fatalf("GET /api/shelves?pile=10 = %d %s", resp.StatusCode, string(raw))
	}
	for _, shelf := range withPile.Data.Shelves {
		if shelf.ID == shelfID && (len(shelf.Pile) != 1 || shelf.Pile[0].ID != bookID) {
			t.Fatalf("shelf pile = %+v, want only %s", shelf.Pile, bookID)
		}
	}
	resp, _ = env.reqJSON(&viewer, http.MethodDelete, "/api/shelves/"+shelfID, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("DELETE shelf = %d", resp.StatusCode)
	}
	resp, _ = env.reqJSON(&viewer, http.MethodGet, "/api/shelves/"+shelfID, nil)
	if resp.StatusCode != 404 {
		t.Fatalf("GET deleted shelf = %d, want 404", resp.StatusCode)
	}
}
