package spines_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/spines"
)

func makeSolidPNG(t *testing.T, w, h int, c color.RGBA) []byte {
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

func makeJPEGWithOrientation(t *testing.T, w, h int, orientation uint16) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	var rawBuf bytes.Buffer
	if err := jpeg.Encode(&rawBuf, img, &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("jpeg.Encode: %v", err)
	}
	jb := rawBuf.Bytes()

	// Build minimal APP1 Exif segment with single IFD entry 0x0112 (Orientation).
	var tiff bytes.Buffer
	tiff.WriteString("MM")                              // Big-endian
	_ = binary.Write(&tiff, binary.BigEndian, uint16(42))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(8)) // IFD0 offset
	_ = binary.Write(&tiff, binary.BigEndian, uint16(1)) // 1 entry
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0x0112))
	_ = binary.Write(&tiff, binary.BigEndian, uint16(3)) // SHORT
	_ = binary.Write(&tiff, binary.BigEndian, uint32(1))
	_ = binary.Write(&tiff, binary.BigEndian, orientation)
	_ = binary.Write(&tiff, binary.BigEndian, uint16(0))
	_ = binary.Write(&tiff, binary.BigEndian, uint32(0)) // next IFD

	payload := append([]byte("Exif\x00\x00"), tiff.Bytes()...)
	var seg bytes.Buffer
	seg.Write([]byte{0xFF, 0xE1})
	_ = binary.Write(&seg, binary.BigEndian, uint16(len(payload)+2))
	seg.Write(payload)

	var out bytes.Buffer
	out.Write(jb[:2]) // SOI
	out.Write(seg.Bytes())
	out.Write(jb[2:])
	return out.Bytes()
}

func TestRenderSpineCropStretchOrientationAndValidation(t *testing.T) {
	// Two-tone 100x300 PNG: top half red, bottom half green.
	img := image.NewRGBA(image.Rect(0, 0, 100, 300))
	for y := 0; y < 300; y++ {
		c := color.RGBA{R: 255, A: 255}
		if y >= 150 {
			c = color.RGBA{G: 255, A: 255}
		}
		for x := 0; x < 100; x++ {
			img.SetRGBA(x, y, c)
		}
	}
	var srcBuf bytes.Buffer
	if err := png.Encode(&srcBuf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	src := srcBuf.Bytes()

	// Crop top 50% -> 100x150 green WebP
	edits := spines.DefaultSpineEdits()
	edits.Top = 50
	out, ct, err := spines.RenderSpine(src, edits)
	if err != nil {
		t.Fatalf("RenderSpine crop: %v", err)
	}
	if ct != "image/png" {
		t.Fatalf("contentType = %q, want image/png", ct)
	}
	meta, err := books.SniffImageMeta(out)
	if err != nil || meta.Format != "webp" || meta.Width != 100 || meta.Height != 150 {
		t.Fatalf("cropped meta = %+v err=%v", meta, err)
	}

	// Fractional crop 50.5% -> 100x149
	edits.Top = 50.5
	out, _, err = spines.RenderSpine(src, edits)
	if err != nil {
		t.Fatalf("RenderSpine fractional: %v", err)
	}
	meta, _ = books.SniffImageMeta(out)
	if meta.Height != 149 {
		t.Fatalf("fractional height = %d, want 149", meta.Height)
	}

	// Stretch -> 256x768
	edits.Top = 50
	edits.Stretch = true
	out, _, err = spines.RenderSpine(src, edits)
	if err != nil {
		t.Fatalf("RenderSpine stretch: %v", err)
	}
	meta, _ = books.SniffImageMeta(out)
	if meta.Width != 256 || meta.Height != 768 {
		t.Fatalf("stretched dims = %dx%d, want 256x768", meta.Width, meta.Height)
	}

	// EXIF orientation 6 (90 CW): 40x120 becomes 120x40; left 50% -> 60x40
	orientJPG := makeJPEGWithOrientation(t, 40, 120, 6)
	orientEdits := spines.DefaultSpineEdits()
	orientEdits.Left = 50
	out, ct, err = spines.RenderSpine(orientJPG, orientEdits)
	if err != nil {
		t.Fatalf("RenderSpine EXIF: %v", err)
	}
	if ct != "image/jpeg" {
		t.Fatalf("jpeg contentType = %q", ct)
	}
	meta, _ = books.SniffImageMeta(out)
	if meta.Width != 60 || meta.Height != 40 {
		t.Fatalf("EXIF cropped dims = %dx%d, want 60x40", meta.Width, meta.Height)
	}

	// Rejects SVG & oversized
	if _, _, err := spines.RenderSpine([]byte("<svg xmlns='http://www.w3.org/2000/svg'/>"), spines.DefaultSpineEdits()); err == nil {
		t.Fatal("expected SVG to be rejected")
	}
	if _, _, err := spines.RenderSpine(make([]byte, spines.SpineMaxBytes+1), spines.DefaultSpineEdits()); err == nil {
		t.Fatal("expected >10MB to be rejected")
	}

	// ParseSpineEdits validation
	if _, ok := spines.ParseSpineEdits(map[string]any{"left": 50.0, "right": 50.0, "top": 0.0, "bottom": 0.0, "stretch": false}); ok {
		t.Fatal("expected left+right>95 to fail")
	}
	if _, ok := spines.ParseSpineEdits(map[string]any{"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0, "stretch": "yes"}); ok {
		t.Fatal("expected non-bool stretch to fail")
	}
}

func TestSpineAndSpineGenerationEndToEnd(t *testing.T) {
	ctx := context.Background()
	tmp := t.TempDir()
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "spines.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	defer opened.DB.Close()
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	var refreshCount atomic.Int32
	var imageCallCount atomic.Int32
	genPNG := makeSolidPNG(t, 180, 100, color.RGBA{R: 103, G: 62, B: 138, A: 255})

	fakeProvider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/usercode"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"device_auth_id": "dev-1",
				"user_code":      "CODE-123",
				"interval":       3,
			})
		case strings.HasSuffix(r.URL.Path, "/deviceauth/token"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"authorization_code": "auth-code-1",
				"code_verifier":      "verifier-1",
			})
		case r.URL.Path == "/oauth/token":
			body, _ := io.ReadAll(r.Body)
			if strings.Contains(string(body), "grant_type=refresh_token") {
				refreshCount.Add(1)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"access_token":  "tok-access",
				"refresh_token": "tok-refresh",
				"expires_in":    1, // forces refresh on first getConnection
			})
		case strings.HasSuffix(r.URL.Path, "/images/edits"):
			var reqBody struct {
				Prompt string `json:"prompt"`
				Images []any  `json:"images"`
			}
			_ = json.NewDecoder(r.Body).Decode(&reqBody)
			imageCallCount.Add(1)
			if strings.Contains(reqBody.Prompt, "FAIL_429") {
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]string{
					{"b64_json": base64.StdEncoding.EncodeToString(genPNG)},
				},
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer fakeProvider.Close()

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	secret := "spines-test-secret-0123456789abcdef0123456789"
	libDir := filepath.Join(tmp, "library")
	authSvc := auth.NewService(auth.ServiceOptions{DB: opened.DB, Secret: secret, Logger: discard})
	colSvc := collections.NewService(collections.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	booksSvc := books.NewService(books.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	spinesSvc := spines.NewService(spines.ServiceOptions{
		DB:           opened.DB,
		AuthService:  authSvc,
		AuthSecret:   secret,
		LibraryDir:   libDir,
		CodexAuthURL: fakeProvider.URL,
		CodexAPIURL:  fakeProvider.URL,
		Logger:       discard,
	})

	srv := httptest.NewServer(httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{colSvc, booksSvc, spinesSvc},
	}))
	defer srv.Close()

	signUp := func(name, email string) (string, string) {
		body, _ := json.Marshal(map[string]string{
			"name": name, "email": email, "password": "very-strong-password-123456",
		})
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/sign-up/email", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", srv.URL)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("signUp: %v", err)
		}
		defer resp.Body.Close()
		var parsed struct {
			User struct{ ID string } `json:"user"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&parsed)
		var cs []string
		for _, c := range resp.Cookies() {
			cs = append(cs, c.Name+"="+c.Value)
		}
		return parsed.User.ID, strings.Join(cs, "; ")
	}

	reqJSON := func(cookie, method, path string, payload any) (*http.Response, []byte) {
		var r io.Reader
		if payload != nil {
			b, _ := json.Marshal(payload)
			r = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+path, r)
		req.Header.Set("Origin", srv.URL)
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, b
	}

	_, ownerCookie := signUp("Owner", "owner@example.invalid")
	_, viewerCookie := signUp("Viewer", "viewer@example.invalid")

	resp, raw := reqJSON(ownerCookie, http.MethodPost, "/api/collections", map[string]any{"name": "Col"})
	var colRes struct {
		Data struct {
			Collection struct{ ID string } `json:"collection"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &colRes)
	colID := colRes.Data.Collection.ID
	if resp.StatusCode != 200 {
		t.Fatalf("create col: %d", resp.StatusCode)
	}
	reqJSON(ownerCookie, http.MethodPut, "/api/collections/"+colID+"/members", map[string]any{
		"email": "viewer@example.invalid", "role": "viewer",
	})

	resp, raw = reqJSON(ownerCookie, http.MethodPost, "/api/books", map[string]any{
		"title": "Book 1", "authors": []string{"Author A"}, "seriesName": "Saga", "seriesIndex": 1, "collectionIds": []string{colID},
	})
	var bRes struct {
		Data struct {
			Book struct{ ID string } `json:"book"`
		} `json:"data"`
	}
	_ = json.Unmarshal(raw, &bRes)
	bookID := bRes.Data.Book.ID
	if resp.StatusCode != 200 {
		t.Fatalf("create book: %d", resp.StatusCode)
	}

	// Upload spine artwork + concurrent edit + delete
	uploadSpine := func(cookie, rev string, edits spines.SpineEdits, img []byte) (*http.Response, []byte) {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		if img != nil {
			fw, _ := mw.CreateFormFile("file", "spine.png")
			_, _ = fw.Write(img)
		}
		_ = mw.WriteField("revision", rev)
		eb, _ := json.Marshal(edits)
		_ = mw.WriteField("edits", string(eb))
		_ = mw.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/books/"+bookID+"/spine", &buf)
		req.Header.Set("Origin", srv.URL)
		req.Header.Set("Cookie", cookie)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		r, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("uploadSpine: %v", err)
		}
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		return r, b
	}

	spinePNG := makeSolidPNG(t, 60, 180, color.RGBA{R: 36, G: 126, B: 91, A: 255})
	resp, _ = uploadSpine(viewerCookie, "", spines.DefaultSpineEdits(), spinePNG)
	if resp.StatusCode != 403 {
		t.Fatalf("viewer spine POST = %d, want 403", resp.StatusCode)
	}
	resp, raw = uploadSpine(ownerCookie, "", spines.DefaultSpineEdits(), spinePNG)
	if resp.StatusCode != 200 {
		t.Fatalf("owner spine POST = %d %s", resp.StatusCode, string(raw))
	}
	var spRes struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(raw, &spRes)

	// Concurrent edits at same revision -> one 200, one 409
	var wg sync.WaitGroup
	codes := make([]int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			ed := spines.DefaultSpineEdits()
			ed.Left = float64(5 + idx)
			r, _ := uploadSpine(ownerCookie, spRes.Revision, ed, nil)
			codes[idx] = r.StatusCode
		}(i)
	}
	wg.Wait()
	if !((codes[0] == 200 && codes[1] == 409) || (codes[0] == 409 && codes[1] == 200)) {
		t.Fatalf("concurrent spine edits = %v, want [200,409]", codes)
	}

	// Upload cover so spine generation can proceed
	{
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", "cover.png")
		_, _ = fw.Write(makeSolidPNG(t, 100, 180, color.RGBA{R: 200, G: 50, B: 60, A: 255}))
		_ = mw.Close()
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/books/"+bookID+"/cover", &buf)
		req.Header.Set("Origin", srv.URL)
		req.Header.Set("Cookie", ownerCookie)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		r, err := http.DefaultClient.Do(req)
		if err != nil || r.StatusCode != 200 {
			t.Fatalf("upload cover: err=%v status=%d", err, r.StatusCode)
		}
		r.Body.Close()
	}

	// Admin ChatGPT connection start -> wait -> poll -> encrypted tokens stored
	resp, raw = reqJSON(ownerCookie, http.MethodPost, "/api/settings/admin/chatgpt-image", map[string]any{"action": "start"})
	if resp.StatusCode != 200 {
		t.Fatalf("chatgpt start = %d %s", resp.StatusCode, string(raw))
	}
	var startRes struct {
		AttemptID string `json:"attemptId"`
		Code      string `json:"code"`
	}
	_ = json.Unmarshal(raw, &startRes)
	if startRes.Code != "CODE-123" {
		t.Fatalf("unexpected code: %q", startRes.Code)
	}
	time.Sleep(3100 * time.Millisecond)
	resp, raw = reqJSON(ownerCookie, http.MethodPost, "/api/settings/admin/chatgpt-image", map[string]any{
		"action": "poll", "attemptId": startRes.AttemptID,
	})
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"connected":true`) {
		t.Fatalf("chatgpt poll = %d %s", resp.StatusCode, string(raw))
	}

	// Generate spine -> triggers refresh & returns 180x100 PNG
	var genBuf bytes.Buffer
	mw := multipart.NewWriter(&genBuf)
	_ = mw.WriteField("prompt", "Gold foil lettering")
	_ = mw.Close()
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/books/"+bookID+"/spine-generate", &genBuf)
	req.Header.Set("Origin", srv.URL)
	req.Header.Set("Cookie", ownerCookie)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	genResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("spine-generate: %v", err)
	}
	genBytes, _ := io.ReadAll(genResp.Body)
	genResp.Body.Close()
	if genResp.StatusCode != 200 {
		t.Fatalf("spine-generate = %d %s", genResp.StatusCode, string(genBytes))
	}
	meta, err := books.SniffImageMeta(genBytes)
	if err != nil || meta.Width != 180 || meta.Height != 100 {
		t.Fatalf("generated image meta = %+v err=%v", meta, err)
	}
	if refreshCount.Load() < 1 || imageCallCount.Load() != 1 {
		t.Fatalf("refreshCount=%d imageCallCount=%d", refreshCount.Load(), imageCallCount.Load())
	}

	// Provider 429 -> 502 with usage limit message
	var failBuf bytes.Buffer
	mw2 := multipart.NewWriter(&failBuf)
	_ = mw2.WriteField("prompt", "FAIL_429")
	_ = mw2.Close()
	req2, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/books/"+bookID+"/spine-generate", &failBuf)
	req2.Header.Set("Origin", srv.URL)
	req2.Header.Set("Cookie", ownerCookie)
	req2.Header.Set("Content-Type", mw2.FormDataContentType())
	failResp, _ := http.DefaultClient.Do(req2)
	failBody, _ := io.ReadAll(failResp.Body)
	failResp.Body.Close()
	if failResp.StatusCode != 502 || !strings.Contains(string(failBody), "usage limit") {
		t.Fatalf("429 provider -> %d %s", failResp.StatusCode, string(failBody))
	}

	// Disconnect
	resp, raw = reqJSON(ownerCookie, http.MethodDelete, "/api/settings/admin/chatgpt-image", nil)
	if resp.StatusCode != 200 || !strings.Contains(string(raw), `"connected":false`) {
		t.Fatalf("DELETE chatgpt-image = %d %s", resp.StatusCode, string(raw))
	}
}
