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
