package spines_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"image/color"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/spines"
	"github.com/lancewilhelm/delb/internal/storage"
)

func setupSpineTestEnv(t *testing.T) (*db.OpenResult, string, http.Handler, *http.Cookie, *http.Cookie, string) {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "delb.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{DB: opened.DB, Secret: "test-secret", Logger: logger})
	booksSvc := books.NewService(books.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: logger})
	spinesSvc := spines.NewService(spines.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		AuthSecret:  "test-secret",
		LibraryDir:  libDir,
		Logger:      logger,
	})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      logger,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{booksSvc, spinesSvc},
	})

	signUp := func(name, email string) *http.Cookie {
		body, _ := json.Marshal(map[string]string{"name": name, "email": email, "password": "password-123456"})
		req := httptest.NewRequest(http.MethodPost, "http://example.invalid/api/auth/sign-up/email", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "http://example.invalid")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("signup %s: %d %s", email, rec.Code, rec.Body.String())
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == auth.SessionCookieBaseName {
				return c
			}
		}
		t.Fatalf("missing session cookie for %s", email)
		return nil
	}

	ownerCookie := signUp("Owner", "owner@example.invalid")
	readerCookie := signUp("Reader", "reader@example.invalid")

	// Create a book with a cover placed in its canonical folder.
	createBody, _ := json.Marshal(map[string]any{
		"title":   "File Spine Book",
		"authors": []string{"Ada Writer"},
	})
	req := httptest.NewRequest(http.MethodPost, "http://example.invalid/api/books", bytes.NewReader(createBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://example.invalid")
	req.AddCookie(ownerCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("create book: %d %s", rec.Code, rec.Body.String())
	}
	var created struct {
		Data struct {
			Book struct {
				ID string `json:"id"`
			} `json:"book"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create book: %v", err)
	}
	bookID := created.Data.Book.ID

	// Place a cover file in the canonical book folder so spines sit right next to cover.webp.
	canonical := storage.GetCanonicalBookPaths([]string{"Ada Writer"}, "File Spine Book", bookID)
	coverAbs, err := storage.ResolveUnderLibrary(libDir, canonical.CoverPath)
	if err != nil {
		t.Fatalf("resolve cover: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(coverAbs), 0o755); err != nil {
		t.Fatalf("mkdir cover dir: %v", err)
	}
	if err := os.WriteFile(coverAbs, makeSolidPNG(t, 40, 60, color.RGBA{R: 50, G: 70, B: 90, A: 255}), 0o644); err != nil {
		t.Fatalf("write cover: %v", err)
	}
	if _, err := opened.DB.ExecContext(ctx, `UPDATE books SET cover_image_path = ? WHERE id = ?`, canonical.CoverPath, bookID); err != nil {
		t.Fatalf("update cover_image_path: %v", err)
	}

	return opened, libDir, handler, ownerCookie, readerCookie, bookID
}

func TestSpineStoredOnDiskNextToCoverAndMovesWithBook(t *testing.T) {
	ctx := context.Background()
	opened, libDir, handler, ownerCookie, readerCookie, bookID := setupSpineTestEnv(t)

	spinePNG := makeSolidPNG(t, 120, 360, color.RGBA{R: 120, G: 60, B: 40, A: 255})
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "spine.png")
	_, _ = fw.Write(spinePNG)
	_ = mw.WriteField("revision", "")
	_ = mw.WriteField("edits", `{"left":0,"right":0,"top":0,"bottom":0,"stretch":false}`)
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "http://example.invalid/api/books/"+bookID+"/spine", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Origin", "http://example.invalid")
	req.AddCookie(ownerCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST spine: %d %s", rec.Code, rec.Body.String())
	}
	var saved struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &saved)

	// Verify DB holds file paths and empty base64 columns.
	var imgPath, origPath, imgB64, origB64, coverPath string
	if err := opened.DB.QueryRowContext(ctx, `
		SELECT bs.image_path, bs.original_path, bs.image_base64, bs.original_base64, b.cover_image_path
		FROM book_spines bs
		INNER JOIN books b ON b.id = bs.book_id
		WHERE bs.book_id = ?
	`, bookID).Scan(&imgPath, &origPath, &imgB64, &origB64, &coverPath); err != nil {
		t.Fatalf("query book_spines: %v", err)
	}
	if imgB64 != "" || origB64 != "" {
		t.Fatalf("expected empty base64 columns, got lengths img=%d orig=%d", len(imgB64), len(origB64))
	}
	if filepath.Dir(imgPath) != filepath.Dir(coverPath) || filepath.Base(imgPath) != "spine.webp" {
		t.Fatalf("spine path %q not next to cover %q", imgPath, coverPath)
	}
	if filepath.Dir(origPath) != filepath.Dir(coverPath) || filepath.Base(origPath) != "spine.source.png" {
		t.Fatalf("spine source path %q not next to cover %q", origPath, coverPath)
	}

	// Verify files exist on disk.
	imgAbs, _ := storage.ResolveUnderLibrary(libDir, imgPath)
	origAbs, _ := storage.ResolveUnderLibrary(libDir, origPath)
	if _, err := os.Stat(imgAbs); err != nil {
		t.Fatalf("spine.webp missing on disk: %v", err)
	}
	if _, err := os.Stat(origAbs); err != nil {
		t.Fatalf("spine.source.png missing on disk: %v", err)
	}

	// Reader can fetch rendered spine from disk.
	getReq := httptest.NewRequest(http.MethodGet, "/api/books/"+bookID+"/spine?v="+saved.Revision, nil)
	getReq.AddCookie(readerCookie)
	getRec := httptest.NewRecorder()
	handler.ServeHTTP(getRec, getReq)
	if getRec.Code != http.StatusOK || getRec.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("GET spine: %d ct=%s", getRec.Code, getRec.Header().Get("Content-Type"))
	}

	// Rename the book and move storage to canonical -> spine paths must move too!
	if _, err := opened.DB.ExecContext(ctx, `UPDATE books SET title = ? WHERE id = ?`, "Renamed Spine Book", bookID); err != nil {
		t.Fatalf("rename book: %v", err)
	}
	if err := storage.WithBookStorageLock(ctx, libDir, bookID, func() error {
		res, merr := storage.MoveBookStorageToCanonical(ctx, opened.DB, libDir, bookID, nil)
		if merr != nil {
			return merr
		}
		if !res.Moved {
			t.Fatalf("expected MoveBookStorageToCanonical to move files, got %+v", res)
		}
		return nil
	}); err != nil {
		t.Fatalf("move book storage: %v", err)
	}

	var movedImgPath, movedOrigPath string
	if err := opened.DB.QueryRowContext(ctx, `SELECT image_path, original_path FROM book_spines WHERE book_id = ?`, bookID).Scan(&movedImgPath, &movedOrigPath); err != nil {
		t.Fatalf("query moved book_spines: %v", err)
	}
	if !strings.Contains(movedImgPath, "Renamed Spine Book") || !strings.Contains(movedOrigPath, "Renamed Spine Book") {
		t.Fatalf("expected moved paths to reference renamed folder, got img=%q orig=%q", movedImgPath, movedOrigPath)
	}
	movedImgAbs, _ := storage.ResolveUnderLibrary(libDir, movedImgPath)
	if _, err := os.Stat(movedImgAbs); err != nil {
		t.Fatalf("moved spine.webp missing: %v", err)
	}

	// Deleting the spine removes the disk files as well.
	delBody, _ := json.Marshal(map[string]string{"revision": saved.Revision})
	delReq := httptest.NewRequest(http.MethodDelete, "http://example.invalid/api/books/"+bookID+"/spine", bytes.NewReader(delBody))
	delReq.Header.Set("Content-Type", "application/json")
	delReq.Header.Set("Origin", "http://example.invalid")
	delReq.AddCookie(ownerCookie)
	delRec := httptest.NewRecorder()
	handler.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusOK {
		t.Fatalf("DELETE spine: %d %s", delRec.Code, delRec.Body.String())
	}
	if _, err := os.Stat(movedImgAbs); !os.IsNotExist(err) {
		t.Fatalf("expected deleted spine.webp to be removed, stat err=%v", err)
	}
}

func TestMigrateDBSpinesToFiles(t *testing.T) {
	ctx := context.Background()
	opened, libDir, handler, ownerCookie, _, bookID := setupSpineTestEnv(t)

	rawPNG := makeSolidPNG(t, 80, 240, color.RGBA{R: 30, G: 110, B: 80, A: 255})
	renderedWebP, ct, err := spines.RenderSpine(rawPNG, spines.DefaultSpineEdits())
	if err != nil {
		t.Fatalf("RenderSpine: %v", err)
	}

	// Seed a legacy DB-backed row with base64 blobs and empty paths.
	if _, err := opened.DB.ExecContext(ctx, `
		INSERT INTO book_spines (book_id, original_base64, original_type, image_base64, edits, revision, image_path, original_path)
		VALUES (?, ?, ?, ?, '{"left":0,"right":0,"top":0,"bottom":0,"stretch":false}', 'legacy-rev', '', '')
	`, bookID, base64.StdEncoding.EncodeToString(rawPNG), ct, base64.StdEncoding.EncodeToString(renderedWebP)); err != nil {
		t.Fatalf("seed legacy spine: %v", err)
	}

	migrated, err := spines.MigrateDBSpinesToFiles(ctx, opened.DB, libDir, false, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatalf("MigrateDBSpinesToFiles: %v", err)
	}
	if migrated != 1 {
		t.Fatalf("migrated = %d, want 1", migrated)
	}

	// Running a second time is a no-op.
	migrated2, err := spines.MigrateDBSpinesToFiles(ctx, opened.DB, libDir, false, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil || migrated2 != 0 {
		t.Fatalf("second MigrateDBSpinesToFiles = (%d, %v), want (0, nil)", migrated2, err)
	}

	var imgPath, origPath, imgB64, origB64 string
	if err := opened.DB.QueryRowContext(ctx, `SELECT image_path, original_path, image_base64, original_base64 FROM book_spines WHERE book_id = ?`, bookID).Scan(&imgPath, &origPath, &imgB64, &origB64); err != nil {
		t.Fatalf("query migrated row: %v", err)
	}
	if imgPath == "" || origPath == "" || imgB64 != "" || origB64 != "" {
		t.Fatalf("unexpected migrated row state: imgPath=%q origPath=%q len(imgB64)=%d len(origB64)=%d", imgPath, origPath, len(imgB64), len(origB64))
	}

	// Migrated spine serves cleanly via HTTP.
	req := httptest.NewRequest(http.MethodGet, "/api/books/"+bookID+"/spine?variant=source", nil)
	req.AddCookie(ownerCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), rawPNG) {
		t.Fatalf("GET migrated source: %d len=%d want %d", rec.Code, rec.Body.Len(), len(rawPNG))
	}
}

func TestMiniCoverSeparateSpineAndSettings(t *testing.T) {
	ctx := context.Background()
	opened, libDir, handler, ownerCookie, readerCookie, bookID := setupSpineTestEnv(t)

	// 1. Upload a regular bookshelf spine first.
	bookSpinePNG := makeSolidPNG(t, 120, 300, color.RGBA{R: 10, G: 20, B: 30, A: 255})
	{
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		fw, _ := mw.CreateFormFile("file", "book-spine.png")
		_, _ = fw.Write(bookSpinePNG)
		_ = mw.WriteField("revision", "")
		_ = mw.WriteField("edits", `{"left":0,"right":0,"top":0,"bottom":0,"stretch":false}`)
		_ = mw.Close()
		req := httptest.NewRequest(http.MethodPost, "http://example.invalid/api/books/"+bookID+"/spine", &buf)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Origin", "http://example.invalid")
		req.AddCookie(ownerCookie)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("upload book spine: %d %s", rec.Code, rec.Body.String())
		}
	}
	var bookSpineRevBefore string
	_ = opened.DB.QueryRowContext(ctx, `SELECT revision FROM book_spines WHERE book_id = ?`, bookID).Scan(&bookSpineRevBefore)

	// 2. Reader cannot save mini cover settings or mini cover spine.
	putReader := httptest.NewRequest(http.MethodPut, "http://example.invalid/api/books/"+bookID+"/mini-cover", strings.NewReader(`{"settings":{"backStyle":"solid"}}`))
	putReader.Header.Set("Content-Type", "application/json")
	putReader.Header.Set("Origin", "http://example.invalid")
	putReader.AddCookie(readerCookie)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, putReader)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("reader PUT mini-cover = %d, want 403", rec.Code)
	}

	// 3. Editor saves a dedicated 1:3 mini-cover spine + settings in one request.
	miniSpinePNG := makeSolidPNG(t, 150, 450, color.RGBA{R: 200, G: 140, B: 40, A: 255})
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "mini.png")
	_, _ = fw.Write(miniSpinePNG)
	_ = mw.WriteField("revision", "")
	_ = mw.WriteField("edits", `{"left":0,"right":0,"top":0,"bottom":0,"stretch":true}`)
	_ = mw.WriteField("settings", `{"spineSource":"mini","spineFit":"crop","spineOffset":0,"backStyle":"solid","orientation":"rtl","resolution":"standard","bleedMm":1,"foldMarks":true,"trimMarks":true}`)
	_ = mw.Close()

	postMini := httptest.NewRequest(http.MethodPost, "http://example.invalid/api/books/"+bookID+"/mini-cover/spine", &buf)
	postMini.Header.Set("Content-Type", mw.FormDataContentType())
	postMini.Header.Set("Origin", "http://example.invalid")
	postMini.AddCookie(ownerCookie)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, postMini)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST mini-cover/spine: %d %s", rec.Code, rec.Body.String())
	}
	var miniSaved struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &miniSaved)
	if miniSaved.Revision == "" {
		t.Fatal("expected non-empty mini cover spine revision")
	}

	// Bookshelf spine must remain completely untouched!
	var bookSpineRevAfter string
	_ = opened.DB.QueryRowContext(ctx, `SELECT revision FROM book_spines WHERE book_id = ?`, bookID).Scan(&bookSpineRevAfter)
	if bookSpineRevAfter != bookSpineRevBefore {
		t.Fatalf("bookshelf spine changed: %q -> %q", bookSpineRevBefore, bookSpineRevAfter)
	}

	// Verify mini-spine.webp sits right next to cover.webp and spine.webp.
	var miniImgPath, miniSrcPath, coverPath string
	if err := opened.DB.QueryRowContext(ctx, `
		SELECT mc.spine_image_path, mc.spine_source_path, b.cover_image_path
		FROM book_mini_covers mc
		INNER JOIN books b ON b.id = mc.book_id
		WHERE mc.book_id = ?
	`, bookID).Scan(&miniImgPath, &miniSrcPath, &coverPath); err != nil {
		t.Fatalf("query book_mini_covers: %v", err)
	}
	if filepath.Dir(miniImgPath) != filepath.Dir(coverPath) || filepath.Base(miniImgPath) != "mini-spine.webp" {
		t.Fatalf("mini-spine path %q not next to cover %q", miniImgPath, coverPath)
	}
	miniImgAbs, _ := storage.ResolveUnderLibrary(libDir, miniImgPath)
	if _, err := os.Stat(miniImgAbs); err != nil {
		t.Fatalf("mini-spine.webp missing on disk: %v", err)
	}

	// 4. Reader can read saved mini cover settings and mini cover spine image.
	getMeta := httptest.NewRequest(http.MethodGet, "/api/books/"+bookID+"/mini-cover", nil)
	getMeta.AddCookie(readerCookie)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, getMeta)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET mini-cover: %d %s", rec.Code, rec.Body.String())
	}
	var metaResp struct {
		HasSpine      bool                      `json:"hasSpine"`
		SpineRevision string                    `json:"spineRevision"`
		Settings      *spines.MiniCoverSettings `json:"settings"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &metaResp)
	if !metaResp.HasSpine || metaResp.SpineRevision != miniSaved.Revision || metaResp.Settings == nil || metaResp.Settings.BackStyle != "solid" || metaResp.Settings.BleedMm != 1 || metaResp.Settings.Orientation != "rtl" {
		t.Fatalf("unexpected GET mini-cover response: %+v", metaResp)
	}

	getImg := httptest.NewRequest(http.MethodGet, "/api/books/"+bookID+"/mini-cover/spine?v="+miniSaved.Revision, nil)
	getImg.AddCookie(readerCookie)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, getImg)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/webp" {
		t.Fatalf("GET mini-cover/spine: %d ct=%s", rec.Code, rec.Header().Get("Content-Type"))
	}

	// 5. Stale revision returns 409 on delete, current revision deletes mini-spine files while keeping bookshelf spine.
	staleDel := httptest.NewRequest(http.MethodDelete, "http://example.invalid/api/books/"+bookID+"/mini-cover/spine", strings.NewReader(`{"revision":"wrong"}`))
	staleDel.Header.Set("Content-Type", "application/json")
	staleDel.Header.Set("Origin", "http://example.invalid")
	staleDel.AddCookie(ownerCookie)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, staleDel)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale DELETE mini-cover/spine = %d, want 409", rec.Code)
	}

	okDelBody, _ := json.Marshal(map[string]string{"revision": miniSaved.Revision})
	okDel := httptest.NewRequest(http.MethodDelete, "http://example.invalid/api/books/"+bookID+"/mini-cover/spine", bytes.NewReader(okDelBody))
	okDel.Header.Set("Content-Type", "application/json")
	okDel.Header.Set("Origin", "http://example.invalid")
	okDel.AddCookie(ownerCookie)
	rec = httptest.NewRecorder()
	handler.ServeHTTP(rec, okDel)
	if rec.Code != http.StatusOK {
		t.Fatalf("DELETE mini-cover/spine = %d %s", rec.Code, rec.Body.String())
	}
	if _, err := os.Stat(miniImgAbs); !os.IsNotExist(err) {
		t.Fatalf("expected mini-spine.webp removed after delete, err=%v", err)
	}
	// Ensure timestamp / updated_at still valid and settings preserved.
	var updatedAt int64
	if err := opened.DB.QueryRowContext(ctx, `SELECT updated_at FROM book_mini_covers WHERE book_id = ?`, bookID).Scan(&updatedAt); err != nil || updatedAt < time.Now().Unix()-60 {
		t.Fatalf("unexpected updated_at=%d err=%v", updatedAt, err)
	}
}
