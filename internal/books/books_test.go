package books_test

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

func TestSortKeysAndPublishedDates(t *testing.T) {
	if got := books.MakeTitleSortKey("The Great Gatsby"); got != "Great Gatsby" {
		t.Fatalf("MakeTitleSortKey = %q", got)
	}
	if got := books.MakeTitleSortKey("the   hobbit"); got != "hobbit" {
		t.Fatalf("MakeTitleSortKey lower = %q", got)
	}
	if got := books.MakeAuthorSortKey("Ursula K. Le Guin"); got != "Guin, Ursula K. Le" {
		t.Fatalf("MakeAuthorSortKey = %q", got)
	}
	if got := books.MakeAuthorSortKey("Herbert, Frank"); got != "Herbert, Frank" {
		t.Fatalf("MakeAuthorSortKey already comma = %q", got)
	}

	if dt := books.ParsePublishedDate("1965"); dt == nil || dt.Year() != 1965 || dt.Month() != 1 || dt.Day() != 1 {
		t.Fatalf("ParsePublishedDate(1965) = %v", dt)
	}
	if dt := books.ParsePublishedDate("1965-08"); dt == nil || dt.Year() != 1965 || dt.Month() != 8 || dt.Day() != 1 {
		t.Fatalf("ParsePublishedDate(1965-08) = %v", dt)
	}
	if dt := books.ParsePublishedDate("2020-02-29"); dt == nil || dt.Day() != 29 {
		t.Fatalf("ParsePublishedDate(leap) = %v", dt)
	}
	if dt := books.ParsePublishedDate("2021-02-29"); dt != nil {
		t.Fatalf("ParsePublishedDate(non-leap) should be nil, got %v", dt)
	}
}

func TestExternalImageSSRFProtection(t *testing.T) {
	for _, tc := range []struct {
		ip   string
		want bool
	}{
		{"93.184.216.34", true},
		{"1.1.1.1", true},
		{"2606:2800:220:1:248:1893:25c8:1946", true},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"172.16.0.1", false},
		{"192.168.1.1", false},
		{"100.64.0.1", false},
		{"169.254.169.254", false},
		{"0.0.0.0", false},
		{"::1", false},
		{"::ffff:127.0.0.1", false},
		{"fe80::1", false},
		{"fc00::1", false},
		{"2001:db8::1", false},
		{"2002:7f00:1::", false},
	} {
		addr := netip.MustParseAddr(tc.ip)
		if got := books.IsPublicIP(addr); got != tc.want {
			t.Fatalf("IsPublicIP(%s) = %v, want %v", tc.ip, got, tc.want)
		}
	}

	// Test fetcher blocks userinfo, localhost, SVG, private redirects, and accepts valid PNG via pinned dial.
	var pngBuf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 10, 10))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	_ = png.Encode(&pngBuf, img)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok.png":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(pngBuf.Bytes())
		case "/evil.svg":
			w.Header().Set("Content-Type", "image/svg+xml")
			_, _ = w.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`))
		case "/redirect-private":
			http.Redirect(w, r, "http://127.0.0.1/secret", http.StatusFound)
		}
	}))
	defer srv.Close()

	srvAddr := srv.Listener.Addr().String()
	fetcher := &books.ExternalImageFetcher{
		LookupIPAddr: func(ctx context.Context, host string) ([]netip.Addr, error) {
			if host == "covers.example.com" {
				return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
			}
			return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
		},
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "tcp", srvAddr)
		},
	}

	ctx := context.Background()
	// Blocked: userinfo
	if _, _, err := fetcher.Fetch(ctx, "https://user:pass@covers.example.com/ok.png"); err == nil {
		t.Fatalf("expected userinfo rejection")
	}
	// Blocked: localhost
	if _, _, err := fetcher.Fetch(ctx, "http://localhost/ok.png"); err == nil {
		t.Fatalf("expected localhost rejection")
	}
	// Blocked: SVG
	if _, _, err := fetcher.Fetch(ctx, "http://covers.example.com/evil.svg"); err == nil {
		t.Fatalf("expected SVG rejection")
	}
	// Blocked: redirect to private IP
	if _, _, err := fetcher.Fetch(ctx, "http://covers.example.com/redirect-private"); err == nil {
		t.Fatalf("expected private redirect rejection")
	}
	// Allowed: valid PNG re-encoded cleanly
	buf, ct, err := fetcher.Fetch(ctx, "http://covers.example.com/ok.png")
	if err != nil {
		t.Fatalf("expected valid PNG fetch, got %v", err)
	}
	if ct != "image/png" || len(buf) == 0 {
		t.Fatalf("unexpected fetched image result: %q len=%d", ct, len(buf))
	}
}

func makeTestEPUBBytes(t *testing.T, title, author string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	mh := &zip.FileHeader{Name: "mimetype", Method: zip.Store}
	mw, _ := zw.CreateHeader(mh)
	_, _ = mw.Write([]byte("application/epub+zip"))
	cw, _ := zw.Create("META-INF/container.xml")
	_, _ = cw.Write([]byte(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`))
	opf, _ := zw.Create("content.opf")
	_, _ = opf.Write([]byte(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:1111</dc:identifier><dc:title>` + title + `</dc:title><dc:creator>` + author + `</dc:creator></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`))
	ch, _ := zw.Create("c1.xhtml")
	_, _ = ch.Write([]byte(`<html xmlns="http://www.w3.org/1999/xhtml"><body>hi</body></html>`))
	_ = zw.Close()
	return buf.Bytes()
}

func TestBooksEndToEndHTTP(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "books.db")
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
		Secret: "books-test-secret-0123456789abcdef0123456789",
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

	// Sign up owner user.
	resp, _ := doJSON(http.MethodPost, "/api/auth/sign-up/email", map[string]any{
		"name":     "Owner",
		"email":    "owner@example.test",
		"password": "StrongPassword123!",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sign-up status = %d", resp.StatusCode)
	}

	// Upload an EPUB book.
	var mp bytes.Buffer
	mw := multipart.NewWriter(&mp)
	fw, _ := mw.CreateFormFile("file", "dune.epub")
	_, _ = fw.Write(makeTestEPUBBytes(t, "Dune", "Frank Herbert"))
	_ = mw.Close()

	upReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/books/upload", &mp)
	upReq.Header.Set("Origin", srv.URL)
	upReq.Header.Set("Content-Type", mw.FormDataContentType())
	upResp, err := client.Do(upReq)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	var upBody struct {
		Success bool `json:"success"`
		Data    struct {
			Uploaded []struct {
				ID string `json:"id"`
			} `json:"uploaded"`
			Results []struct {
				Success bool `json:"success"`
				Book    struct {
					ID string `json:"id"`
				} `json:"book"`
				Error string `json:"error"`
			} `json:"results"`
		} `json:"data"`
	}
	_ = json.NewDecoder(upResp.Body).Decode(&upBody)
	upResp.Body.Close()
	if upResp.StatusCode != http.StatusOK || len(upBody.Data.Uploaded) != 1 || upBody.Data.Uploaded[0].ID == "" {
		t.Fatalf("unexpected upload response: status=%d body=%+v", upResp.StatusCode, upBody)
	}
	bookID := upBody.Data.Uploaded[0].ID

	// Update metadata with tags (including literal % / _ characters), pages, and series.
	resp, _ = doJSON(http.MethodPut, "/api/books/"+bookID, map[string]any{
		"title":       "Dune",
		"pages":       412,
		"published":   "1965-08-01",
		"series":      "Dune Chronicles",
		"seriesIndex": 1,
		"publisher":   "Chilton Books",
		"tags":        []string{"sci-fi", "100%_classic"},
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("PUT /api/books/{id} = %d", resp.StatusCode)
	}

	// Download book & check headers.
	dlResp, err := client.Get(srv.URL + "/api/books/" + bookID + "/download")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	dlBytes, _ := io.ReadAll(dlResp.Body)
	dlResp.Body.Close()
	if dlResp.StatusCode != http.StatusOK || len(dlBytes) == 0 || !strings.Contains(dlResp.Header.Get("Content-Disposition"), "Dune.epub") {
		t.Fatalf("download failed: status=%d len=%d cd=%q", dlResp.StatusCode, len(dlBytes), dlResp.Header.Get("Content-Disposition"))
	}

	// Upload a cover and verify smart private caching headers for versioned vs unversioned URLs.
	var coverPNG bytes.Buffer
	coverImg := image.NewRGBA(image.Rect(0, 0, 20, 30))
	coverImg.Set(0, 0, color.RGBA{R: 40, G: 80, B: 160, A: 255})
	if err := png.Encode(&coverPNG, coverImg); err != nil {
		t.Fatalf("encode cover png: %v", err)
	}
	var coverBody bytes.Buffer
	cmw := multipart.NewWriter(&coverBody)
	cfw, _ := cmw.CreateFormFile("file", "cover.png")
	_, _ = cfw.Write(coverPNG.Bytes())
	_ = cmw.Close()
	cUpReq, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/books/"+bookID+"/cover", &coverBody)
	cUpReq.Header.Set("Origin", srv.URL)
	cUpReq.Header.Set("Content-Type", cmw.FormDataContentType())
	cUpResp, err := client.Do(cUpReq)
	if err != nil {
		t.Fatalf("cover upload: %v", err)
	}
	cUpResp.Body.Close()
	if cUpResp.StatusCode != http.StatusOK {
		t.Fatalf("cover upload = %d", cUpResp.StatusCode)
	}

	// Unversioned cover keeps strict must-revalidate.
	unvResp, err := client.Get(srv.URL + "/api/books/" + bookID + "/cover?variant=thumb")
	if err != nil {
		t.Fatalf("unversioned cover: %v", err)
	}
	_, _ = io.ReadAll(unvResp.Body)
	unvResp.Body.Close()
	if unvResp.StatusCode != http.StatusOK ||
		unvResp.Header.Get("Cache-Control") != "private, max-age=0, must-revalidate" ||
		unvResp.Header.Get("Vary") != "Cookie" ||
		unvResp.Header.Get("ETag") == "" {
		t.Fatalf("unexpected unversioned cover headers: status=%d cc=%q vary=%q etag=%q",
			unvResp.StatusCode, unvResp.Header.Get("Cache-Control"), unvResp.Header.Get("Vary"), unvResp.Header.Get("ETag"))
	}

	// Versioned cover (?v=...) gets private browser caching + SWR and still honors ETag 304.
	verResp, err := client.Get(srv.URL + "/api/books/" + bookID + "/cover?variant=thumb&v=123456789")
	if err != nil {
		t.Fatalf("versioned cover: %v", err)
	}
	_, _ = io.ReadAll(verResp.Body)
	verResp.Body.Close()
	if verResp.StatusCode != http.StatusOK ||
		verResp.Header.Get("Cache-Control") != "private, max-age=300, stale-while-revalidate=3600" ||
		verResp.Header.Get("Vary") != "Cookie" ||
		verResp.Header.Get("ETag") == "" {
		t.Fatalf("unexpected versioned cover headers: status=%d cc=%q vary=%q etag=%q",
			verResp.StatusCode, verResp.Header.Get("Cache-Control"), verResp.Header.Get("Vary"), verResp.Header.Get("ETag"))
	}
	inmReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/books/"+bookID+"/cover?variant=thumb&v=123456789", nil)
	inmReq.Header.Set("If-None-Match", verResp.Header.Get("ETag"))
	inmResp, err := client.Do(inmReq)
	if err != nil {
		t.Fatalf("cover 304: %v", err)
	}
	inmResp.Body.Close()
	if inmResp.StatusCode != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified on matching ETag, got %d", inmResp.StatusCode)
	}

	// Rating, Status (reading + TBR), Rationale, Reading position & progress sync, Dashboard.
	if r, _ := doJSON(http.MethodPost, "/api/books/"+bookID+"/rating", map[string]any{"rating": 5}); r.StatusCode != http.StatusOK {
		t.Fatalf("rating = %d", r.StatusCode)
	}
	if r, _ := doJSON(http.MethodPost, "/api/books/"+bookID+"/status", map[string]any{"status": "reading"}); r.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", r.StatusCode)
	}
	if r, _ := doJSON(http.MethodPut, "/api/books/"+bookID+"/rationale", map[string]any{"rationale": "Masterpiece"}); r.StatusCode != http.StatusOK {
		t.Fatalf("rationale = %d", r.StatusCode)
	}

	// Reading position with clientSessionId/clientSequence monotonic guard.
	r1, pos1 := doJSON(http.MethodPut, "/api/books/"+bookID+"/reading-position", map[string]any{
		"location":        "epubcfi(/6/4!/4/2)",
		"progress":        0.5,
		"clientSessionId": "11111111-1111-4111-8111-111111111111",
		"clientSequence":  5,
	})
	if r1.StatusCode != http.StatusOK || pos1["success"] != true {
		t.Fatalf("reading-position 1 = %d %v", r1.StatusCode, pos1)
	}
	// Stale sequence (3 < 5) should be ignored cleanly.
	r2, pos2 := doJSON(http.MethodPut, "/api/books/"+bookID+"/reading-position", map[string]any{
		"location":        "epubcfi(/6/2!/4/2)",
		"progress":        0.1,
		"clientSessionId": "11111111-1111-4111-8111-111111111111",
		"clientSequence":  3,
	})
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("reading-position 2 = %d", r2.StatusCode)
	}
	if dataMap, ok := pos2["data"].(map[string]any); !ok || dataMap["location"] != "epubcfi(/6/4!/4/2)" || dataMap["progress"] != 0.5 {
		t.Fatalf("expected stale reading-position to preserve previous location/progress, got %v", pos2)
	}

	// Dashboard returns 200 with Cache-Control: private, no-store.
	dashResp, _ := doJSON(http.MethodGet, "/api/dashboard", nil)
	if dashResp.StatusCode != http.StatusOK || dashResp.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("dashboard status=%d cc=%q", dashResp.StatusCode, dashResp.Header.Get("Cache-Control"))
	}

	// Literal %/_ tag search & global search.
	tagResp, tagBody := doJSON(http.MethodGet, "/api/tags/search?q=100%25_", nil)
	if tagResp.StatusCode != http.StatusOK {
		t.Fatalf("tags/search = %d", tagResp.StatusCode)
	}
	if dataMap, ok := tagBody["data"].(map[string]any); !ok {
		t.Fatalf("unexpected tags/search body: %v", tagBody)
	} else if tagsArr, ok := dataMap["results"].([]any); !ok || len(tagsArr) != 1 {
		t.Fatalf("expected exactly 1 literal match for 100%%_, got %v", dataMap["results"])
	}

	searchResp, searchBody := doJSON(http.MethodGet, "/api/search?q=Dune", nil)
	if searchResp.StatusCode != http.StatusOK {
		t.Fatalf("search = %d", searchResp.StatusCode)
	}
	dataMap, ok := searchBody["data"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected /api/search body: %v", searchBody)
	}
	buckets, ok := dataMap["buckets"].(map[string]any)
	if !ok {
		t.Fatalf("unexpected /api/search buckets: %v", searchBody)
	}
	if booksBucket, ok := buckets["books"].([]any); !ok || len(booksBucket) != 1 {
		t.Fatalf("unexpected /api/search books bucket: %v", buckets["books"])
	}

	// Duplicate detection on metadata-import/create with a Google Books item returns 409 possible_duplicate.
	dupResp, dupBody := doJSON(http.MethodPost, "/api/books/metadata-import/create", map[string]any{
		"item": map[string]any{
			"id": "gb-dune-1",
			"volumeInfo": map[string]any{
				"title":   "Dune",
				"authors": []string{"Frank Herbert"},
			},
		},
	})
	if dupResp.StatusCode != http.StatusConflict {
		t.Fatalf("expected 409 duplicate conflict, got %d body=%v", dupResp.StatusCode, dupBody)
	}
}

func TestDashboardTBRCountFollowsCollectionScope(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	dbPath := filepath.Join(tmp, "dashboard-tbr.db")
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
		Secret: "dashboard-tbr-secret-0123456789abcdef0123456789",
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

	// Sign up user.
	resp, _ := doJSON(http.MethodPost, "/api/auth/sign-up/email", map[string]any{
		"name":     "Reader",
		"email":    "reader@example.test",
		"password": "StrongPassword123!",
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("sign-up status = %d", resp.StatusCode)
	}

	createCollection := func(name string) string {
		t.Helper()
		r, body := doJSON(http.MethodPost, "/api/collections", map[string]any{"name": name})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("create collection %q status = %d body = %v", name, r.StatusCode, body)
		}
		data := body["data"].(map[string]any)
		col := data["collection"].(map[string]any)
		return col["id"].(string)
	}

	createBook := func(title, collectionID, status string) string {
		t.Helper()
		r, body := doJSON(http.MethodPost, "/api/books", map[string]any{
			"title":         title,
			"authors":       []string{"Test Author"},
			"collectionIds": []string{collectionID},
		})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("create book %q status = %d body = %v", title, r.StatusCode, body)
		}
		data := body["data"].(map[string]any)
		book := data["book"].(map[string]any)
		id := book["id"].(string)
		if status != "" {
			sr, sbody := doJSON(http.MethodPost, "/api/books/"+id+"/status", map[string]any{"status": status})
			if sr.StatusCode != http.StatusOK {
				t.Fatalf("set status %q for %q status = %d body = %v", status, title, sr.StatusCode, sbody)
			}
		}
		return id
	}

	colA := createCollection("Collection A")
	colB := createCollection("Collection B")

	createBook("A TBR 1", colA, "to_be_read")
	createBook("A TBR 2", colA, "to_be_read")
	readingID := createBook("A Reading", colA, "reading")
	createBook("B TBR 1", colB, "to_be_read")
	createBook("B Finished", colB, "finished")

	assertDashboard := func(path string, wantTotal, wantTbr, wantReading, wantFinished, wantShelfLen int) {
		t.Helper()
		r, body := doJSON(http.MethodGet, path, nil)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d body = %v", path, r.StatusCode, body)
		}
		data := body["data"].(map[string]any)
		counts := data["counts"].(map[string]any)
		if got := int(counts["total"].(float64)); got != wantTotal {
			t.Fatalf("GET %s total = %d, want %d", path, got, wantTotal)
		}
		if got := int(counts["to_be_read"].(float64)); got != wantTbr {
			t.Fatalf("GET %s to_be_read = %d, want %d", path, got, wantTbr)
		}
		if got := int(counts["reading"].(float64)); got != wantReading {
			t.Fatalf("GET %s reading = %d, want %d", path, got, wantReading)
		}
		if got := int(counts["finished"].(float64)); got != wantFinished {
			t.Fatalf("GET %s finished = %d, want %d", path, got, wantFinished)
		}
		shelf := data["shelf"].(map[string]any)
		booksArr := shelf["books"].([]any)
		if len(booksArr) != wantShelfLen {
			t.Fatalf("GET %s shelf books len = %d, want %d", path, len(booksArr), wantShelfLen)
		}
	}

	// All accessible collections (no collectionId): TBR count spans all accessible collections.
	assertDashboard("/api/dashboard?shelf=tbr", 5, 3, 1, 1, 3)

	// Collection A: TBR count matches Collection A only (2), not global (3).
	assertDashboard("/api/dashboard?shelf=tbr&collectionId="+colA, 3, 2, 1, 0, 2)

	// Collection B: TBR count matches Collection B only (1), not global (3).
	assertDashboard("/api/dashboard?shelf=tbr&collectionId="+colB, 2, 1, 0, 1, 1)

	// Unknown / inaccessible collection returns 0 for all counts including to_be_read.
	assertDashboard("/api/dashboard?shelf=tbr&collectionId=nonexistent-collection", 0, 0, 0, 0, 0)

	// Overview: counts, the recent-cover wall and every status preview share one scope.
	assertOverview := func(path string, wantTotal, wantRecent int, wantLists map[string][]string) {
		t.Helper()
		r, body := doJSON(http.MethodGet, path, nil)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d body = %v", path, r.StatusCode, body)
		}
		if cc := r.Header.Get("Cache-Control"); cc != "private, no-store" {
			t.Fatalf("GET %s Cache-Control = %q", path, cc)
		}
		data := body["data"].(map[string]any)
		if got := int(data["counts"].(map[string]any)["total"].(float64)); got != wantTotal {
			t.Fatalf("GET %s total = %d, want %d", path, got, wantTotal)
		}
		if got := len(data["recent"].([]any)); got != wantRecent {
			t.Fatalf("GET %s recent len = %d, want %d", path, got, wantRecent)
		}
		lists := data["lists"].(map[string]any)
		for _, key := range []string{"reading", "to_be_read", "finished", "dnf", "none"} {
			raw, ok := lists[key].([]any)
			if !ok {
				t.Fatalf("GET %s lists.%s missing or not an array: %v", path, key, lists[key])
			}
			got := map[string]bool{}
			for _, entry := range raw {
				got[entry.(map[string]any)["title"].(string)] = true
			}
			want := wantLists[key]
			if len(got) != len(want) {
				t.Fatalf("GET %s lists.%s = %v, want %v", path, key, got, want)
			}
			for _, title := range want {
				if !got[title] {
					t.Fatalf("GET %s lists.%s missing %q (got %v)", path, key, title, got)
				}
			}
		}
		// Each pile is a random sample of its list (every book, while lists are this small).
		piles := data["piles"].(map[string]any)
		for _, key := range []string{"all", "reading", "to_be_read", "finished", "dnf", "none"} {
			raw, ok := piles[key].([]any)
			if !ok {
				t.Fatalf("GET %s piles.%s missing or not an array: %v", path, key, piles[key])
			}
			want := len(wantLists[key])
			if key == "all" {
				want = wantTotal
			}
			if len(raw) != want {
				t.Fatalf("GET %s piles.%s len = %d, want %d", path, key, len(raw), want)
			}
			for _, entry := range raw {
				title := entry.(map[string]any)["title"].(string)
				if key != "all" && !slices.Contains(wantLists[key], title) {
					t.Fatalf("GET %s piles.%s has %q, not in its list", path, key, title)
				}
			}
		}
	}
	assertOverview("/api/dashboard/overview", 5, 5, map[string][]string{
		"reading":    {"A Reading"},
		"to_be_read": {"A TBR 1", "A TBR 2", "B TBR 1"},
		"finished":   {"B Finished"},
	})
	assertOverview("/api/dashboard/overview?collectionId="+colA, 3, 3, map[string][]string{
		"reading":    {"A Reading"},
		"to_be_read": {"A TBR 1", "A TBR 2"},
	})
	assertOverview("/api/dashboard/overview?collectionId=nonexistent-collection", 0, 0, map[string][]string{})

	// The reader's pile size sets every sample's size.
	_, sized := doJSON(http.MethodGet, "/api/dashboard/overview?pile=2", nil)
	sizedPiles := sized["data"].(map[string]any)["piles"].(map[string]any)
	if got := len(sizedPiles["all"].([]any)); got != 2 {
		t.Fatalf("overview pile=2 all len = %d, want 2", got)
	}
	if got := len(sizedPiles["to_be_read"].([]any)); got != 2 {
		t.Fatalf("overview pile=2 to_be_read len = %d, want 2", got)
	}
	for _, bad := range []string{"0", "101", "x"} {
		if r, _ := doJSON(http.MethodGet, "/api/dashboard/overview?pile="+bad, nil); r.StatusCode != http.StatusBadRequest {
			t.Fatalf("overview pile=%s status = %d, want 400", bad, r.StatusCode)
		}
	}

	// The cover wall pages past the overview, newest first, in the same scope.
	recentPage := func(path string) ([]string, any) {
		t.Helper()
		r, body := doJSON(http.MethodGet, path, nil)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("GET %s status = %d body = %v", path, r.StatusCode, body)
		}
		data := body["data"].(map[string]any)
		titles := []string{}
		for _, entry := range data["books"].([]any) {
			titles = append(titles, entry.(map[string]any)["title"].(string))
		}
		return titles, data["nextOffset"]
	}
	if titles, next := recentPage("/api/dashboard/recent?offset=3"); len(titles) != 2 || next != nil {
		t.Fatalf("recent offset=3 = %v next=%v, want 2 books and no next page", titles, next)
	}
	if titles, _ := recentPage("/api/dashboard/recent?offset=0&collectionId=" + colB); len(titles) != 2 {
		t.Fatalf("recent in collection B = %v, want 2 books", titles)
	}
	for _, bad := range []string{"-1", "x", "01"} {
		if r, _ := doJSON(http.MethodGet, "/api/dashboard/recent?offset="+bad, nil); r.StatusCode != http.StatusBadRequest {
			t.Fatalf("recent offset=%s status = %d, want 400", bad, r.StatusCode)
		}
	}

	// Spine artwork revisions reach the overview so Shelf card art can show real spines.
	if _, err := opened.DB.ExecContext(ctx, `
		INSERT INTO book_spines (book_id, original_base64, original_type, image_base64, edits, revision)
		VALUES (?, '', 'image/png', '', '{}', 'spine-rev-1')`, readingID); err != nil {
		t.Fatalf("insert spine: %v", err)
	}
	_, spineBody := doJSON(http.MethodGet, "/api/dashboard/overview", nil)
	spineLists := spineBody["data"].(map[string]any)["lists"].(map[string]any)
	if got := spineLists["reading"].([]any)[0].(map[string]any)["spineRevision"]; got != "spine-rev-1" {
		t.Fatalf("reading spineRevision = %v, want spine-rev-1", got)
	}
	if got := spineLists["to_be_read"].([]any)[0].(map[string]any)["spineRevision"]; got != nil {
		t.Fatalf("to_be_read spineRevision = %v, want null", got)
	}
	// Shelf art sizes spines from the page count and any stored bookshelf size.
	readingEntry := spineLists["reading"].([]any)[0].(map[string]any)
	for _, key := range []string{"pages", "shelfWidth", "shelfHeight"} {
		if _, ok := readingEntry[key]; !ok {
			t.Fatalf("overview book missing %q: %v", key, readingEntry)
		}
	}
	if _, err := opened.DB.ExecContext(ctx, `
		UPDATE book_shelf_dimensions SET width = 41, height = 199 WHERE book_id = ?`, readingID); err != nil {
		t.Fatalf("update shelf dimensions: %v", err)
	}
	// spines=1 lists only books with spine artwork, with their stored size.
	_, spineOnly := doJSON(http.MethodGet, "/api/dashboard/recent?spines=1", nil)
	spineBooks := spineOnly["data"].(map[string]any)["books"].([]any)
	if len(spineBooks) != 1 {
		t.Fatalf("recent spines=1 = %v, want only the book with spine art", spineBooks)
	}
	spineBook := spineBooks[0].(map[string]any)
	if spineBook["id"] != readingID || spineBook["shelfWidth"] != float64(41) || spineBook["shelfHeight"] != float64(199) {
		t.Fatalf("recent spines=1 book = %v, want %s at 41×199", spineBook, readingID)
	}
	if r, _ := doJSON(http.MethodGet, "/api/dashboard/recent?spines=yes", nil); r.StatusCode != http.StatusBadRequest {
		t.Fatalf("recent spines=yes status = %d, want 400", r.StatusCode)
	}
	anonReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/dashboard/overview", nil)
	anonResp, err := http.DefaultClient.Do(anonReq)
	if err != nil {
		t.Fatalf("anonymous overview: %v", err)
	}
	anonResp.Body.Close()
	if anonResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("anonymous overview status = %d, want 401", anonResp.StatusCode)
	}

	// Global ranked TBR queue endpoint (/api/tbr) still returns all 3 accessible TBR books.
	tbrResp, tbrBody := doJSON(http.MethodGet, "/api/tbr", nil)
	if tbrResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /api/tbr status = %d body = %v", tbrResp.StatusCode, tbrBody)
	}
	tbrData := tbrBody["data"].(map[string]any)
	if got := int(tbrData["count"].(float64)); got != 3 {
		t.Fatalf("GET /api/tbr count = %d, want 3", got)
	}
}
