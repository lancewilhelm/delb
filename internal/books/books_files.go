package books

import (
	"bytes"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/epub"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

const (
	maxBookUploadBytes  = 100 * 1024 * 1024
	maxCoverUploadBytes = 25 * 1024 * 1024
	maxCoverBodyBytes   = 26 * 1024 * 1024
	maxCoverPixels      = 100_000_000
)

var (
	supportedBookFormats = []string{"epub", "pdf", "mobi", "azw3"}
	preferredDownloadOrd = []string{"epub", "pdf", "azw3", "mobi"}
	downloadMimeByFormat = map[string]string{
		"epub": "application/epub+zip",
		"pdf":  "application/pdf",
		"mobi": "application/x-mobipocket-ebook",
		"azw3": "application/vnd.amazon.ebook",
	}
	coverSourceCandidates = []string{
		"cover.jpg", "cover.jpeg", "cover.png", "cover.webp", "cover.gif",
		"cover.svg", "cover.avif", "cover.tif", "cover.tiff",
		"cover.source.jpg", "cover.source.jpeg", "cover.source.png", "cover.source.webp",
		"source.jpg", "source.jpeg", "source.png", "source.webp",
		"thumb.webp",
	}
	oldCoverSourceRe = regexp.MustCompile(`(?i)^(cover|source)(\.(source))?\.(jpg|jpeg|png|webp|gif|avif|tif|tiff)$`)
)

type multipartPart struct {
	Name        string
	Filename    string
	ContentType string
	Data        []byte
}

func readBoundedMultipart(r *http.Request, maxBytes int64) ([]multipartPart, error) {
	if r.ContentLength > maxBytes {
		return nil, httpapi.NewError(http.StatusRequestEntityTooLarge, "Upload exceeds size limit")
	}
	ct := r.Header.Get("Content-Type")
	mediaType, params, err := mime.ParseMediaType(ct)
	if err != nil || !strings.HasPrefix(strings.ToLower(mediaType), "multipart/") {
		return nil, httpapi.NewError(http.StatusBadRequest, "Missing form data")
	}
	boundary := params["boundary"]
	if boundary == "" {
		return nil, httpapi.NewError(http.StatusBadRequest, "Missing form data")
	}

	raw, err := httpapi.ReadBodyBounded(r, maxBytes)
	if err != nil {
		return nil, err
	}
	mr := multipart.NewReader(bytes.NewReader(raw), boundary)
	var parts []multipartPart
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid multipart form data")
		}
		data, rerr := io.ReadAll(p)
		_ = p.Close()
		if rerr != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Failed to read multipart part")
		}
		parts = append(parts, multipartPart{
			Name:        p.FormName(),
			Filename:    p.FileName(),
			ContentType: p.Header.Get("Content-Type"),
			Data:        data,
		})
	}
	return parts, nil
}

func isSupportedBookFormat(ext string) bool {
	for _, f := range supportedBookFormats {
		if f == ext {
			return true
		}
	}
	return false
}

// POST /api/books/upload
func (s *Service) handleUploadBooks(w http.ResponseWriter, r *http.Request) {
	user := httpapi.SessionFromContext(r.Context()).User
	parts, err := readBoundedMultipart(r, maxBookUploadBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if len(parts) == 0 {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing form data")
		return
	}

	var incomingTargets []string
	var fileParts []multipartPart
	allowDuplicate := false
	var replaceBookID string

	for _, p := range parts {
		if p.Filename != "" {
			fileParts = append(fileParts, p)
			continue
		}
		switch p.Name {
		case "collectionId":
			incomingTargets = append(incomingTargets, string(p.Data))
		case "allowDuplicate":
			v := strings.ToLower(strings.TrimSpace(string(p.Data)))
			if v == "1" || v == "true" || v == "yes" || v == "on" {
				allowDuplicate = true
			}
		case "replaceBookId":
			if replaceBookID == "" {
				if v := strings.TrimSpace(string(p.Data)); v != "" {
					replaceBookID = v
				}
			}
		}
	}

	collectionID, err := collections.ResolveBookTarget(r.Context(), s.db, user.ID, len(incomingTargets) > 0, incomingTargets)
	if err != nil {
		s.writeErr(w, "POST /api/books/upload target failed", err)
		return
	}
	if len(fileParts) == 0 {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book file(s)")
		return
	}
	if replaceBookID != "" && !allowDuplicate {
		httpapi.WriteError(w, http.StatusBadRequest, "replaceBookId requires allowDuplicate=1")
		return
	}
	if replaceBookID != "" && len(fileParts) != 1 {
		httpapi.WriteError(w, http.StatusBadRequest, "replaceBookId is only supported for single-file uploads")
		return
	}

	type uploadResult struct {
		Success  bool   `json:"success"`
		Book     any    `json:"book,omitempty"`
		Filename string `json:"filename,omitempty"`
		Error    string `json:"error,omitempty"`
		Code     string `json:"code,omitempty"`
		Details  any    `json:"details,omitempty"`
	}

	results := make([]uploadResult, 0, len(fileParts))
	uploaded := make([]any, 0, len(fileParts))

	for _, fp := range fileParts {
		bookRes, perr := s.processOneBookUpload(r.Context(), fp, user.ID, collectionID, allowDuplicate, replaceBookID)
		if perr != nil {
			s.logger.Error("POST /api/books/upload: failed to process one upload", "filename", fp.Filename, "error", perr)
			res := uploadResult{
				Success:  false,
				Filename: fp.Filename,
				Error:    perr.Error(),
			}
			var httpErr *httpapi.HTTPError
			if errors.As(perr, &httpErr) {
				res.Error = httpErr.Message
				if httpErr.Data != nil {
					res.Details = httpErr.Data
					if dm, ok := httpErr.Data.(map[string]any); ok {
						if code, ok := dm["code"].(string); ok {
							res.Code = code
						}
					}
				}
			}
			results = append(results, res)
			continue
		}
		uploaded = append(uploaded, bookRes)
		results = append(results, uploadResult{
			Success:  true,
			Book:     bookRes,
			Filename: fp.Filename,
		})
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"uploaded": uploaded,
			"results":  results,
		},
	})
}

func (s *Service) processOneBookUpload(
	ctx context.Context,
	part multipartPart,
	userID string,
	collectionID string,
	allowDuplicate bool,
	replaceBookID string,
) (map[string]any, error) {
	if part.Filename == "" || part.Data == nil {
		return nil, httpapi.NewError(http.StatusBadRequest, "Missing book file")
	}
	bookID := replaceBookID
	if bookID == "" {
		bookID = uuid.NewString()
	}

	var out map[string]any
	err := storage.WithBookStorageLock(ctx, s.libraryDir, bookID, func() error {
		ext := strings.TrimPrefix(strings.ToLower(path.Ext(part.Filename)), ".")
		if ext == "" || !isSupportedBookFormat(ext) {
			return httpapi.NewError(http.StatusBadRequest, "Unsupported upload format. Supported: .epub, .pdf, .mobi, .azw3")
		}

		fallbackTitle := strings.TrimSuffix(path.Base(part.Filename), path.Ext(part.Filename))
		if fallbackTitle == "" {
			fallbackTitle = "Untitled"
		}

		title := fallbackTitle
		authorName := "Unknown Author"
		var description, language, published string
		var identifiers []IdentifierInput

		if ext == "epub" {
			meta, err := epub.ParseMetadataFromBytes(part.Data, fallbackTitle)
			if err != nil {
				return err
			}
			if meta.Title != "" {
				title = meta.Title
			}
			if meta.Author != "" {
				authorName = meta.Author
			}
			description = meta.Description
			language = meta.Language
			published = meta.Published
			if meta.ISBN != "" {
				identifiers = append(identifiers, IdentifierInput{Type: "isbn", Value: meta.ISBN})
			}
			if meta.UUID != "" {
				identifiers = append(identifiers, IdentifierInput{Type: "uuid", Value: meta.UUID})
			}
		}

		var existingCoverImagePath *string
		if replaceBookID != "" {
			if !allowDuplicate {
				return httpapi.NewError(http.StatusBadRequest, "Missing allowDuplicate for replace")
			}
			var existingCover sql.NullString
			err := s.db.QueryRowContext(ctx, `SELECT cover_image_path FROM books WHERE id = ? LIMIT 1`, replaceBookID).Scan(&existingCover)
			if errors.Is(err, sql.ErrNoRows) {
				return httpapi.NewError(http.StatusNotFound, "Book not found")
			}
			if err != nil {
				return err
			}
			sourceCol, err := collections.AssertBookEditor(ctx, s.db, userID, replaceBookID)
			if err != nil {
				return err
			}
			if sourceCol != collectionID {
				return httpapi.NewError(http.StatusConflict, "Replacement must stay in the existing collection. Create an independent entry instead.")
			}
			existingCoverImagePath = nullStringPtr(existingCover)
		}

		if !allowDuplicate {
			candidates, err := FindPossibleDuplicates(ctx, s.db, userID, title, authorName, identifiers, 8)
			if err != nil {
				return err
			}
			if len(candidates) > 0 {
				identsOut := identifiers
				if identsOut == nil {
					identsOut = make([]IdentifierInput, 0)
				}
				return httpapi.NewErrorWithData(http.StatusConflict, "Possible duplicate", map[string]any{
					"code": "possible_duplicate",
					"incoming": map[string]any{
						"title":       title,
						"author":      authorName,
						"identifiers": identsOut,
						"filename":    part.Filename,
					},
					"candidates": candidates,
				})
			}
		}

		safeTitle := storage.ToSafePathSegment(title, "Untitled", 80)
		relativePath := storage.BuildBookStorageRelativePath(
			[]string{authorName},
			title,
			bookID,
			safeTitle+"-"+uuid.NewString()+"."+ext,
		)
		absolutePath, err := storage.ResolveUnderLibrary(s.libraryDir, relativePath)
		if err != nil {
			return err
		}
		bookDirAbs := filepath.Dir(absolutePath)

		var creation *storage.StoredCreateHandle
		if replaceBookID != "" {
			if err := os.MkdirAll(bookDirAbs, 0o755); err != nil {
				return err
			}
		} else {
			creation, err = storage.BeginStoredCreate(s.libraryDir, bookID, bookDirAbs, absolutePath, storage.DBCreateDecision(s.db))
			if err != nil {
				return err
			}
		}

		finalizing := false
		defer func() {
			if creation != nil && !finalizing {
				_ = creation.Finish(ctx)
			}
		}()

		if err := storage.WriteFileSyncExclusive(absolutePath, part.Data); err != nil {
			return err
		}
		readBack, err := os.ReadFile(absolutePath)
		if err != nil || !bytes.Equal(readBack, part.Data) {
			return errors.New("Uploaded file failed verification")
		}

		coverImagePath := existingCoverImagePath
		if ext == "epub" && replaceBookID == "" {
			if covBytes, covMime, ok, cerr := epub.ExtractCoverFromBytes(part.Data); cerr == nil && ok && len(covBytes) > 0 {
				srcExt := "bin"
				if e := extFromMime(covMime); e != "" {
					srcExt = e
				} else if meta, serr := SniffImageMeta(covBytes); serr == nil && meta.Format != "" {
					if meta.Format == "jpeg" {
						srcExt = "jpg"
					} else {
						srcExt = meta.Format
					}
				}
				srcAbs := filepath.Join(bookDirAbs, "cover."+srcExt)
				_ = os.WriteFile(srcAbs, covBytes, 0o644)

				thumbBytes, terr := GenerateCoverThumbWebP(covBytes, 320)
				if terr != nil {
					thumbBytes = covBytes
				}
				thumbRel := storage.BuildBookStorageRelativePath([]string{authorName}, title, bookID, "thumb.webp")
				thumbAbs := filepath.Join(bookDirAbs, "thumb.webp")
				if werr := os.WriteFile(thumbAbs, thumbBytes, 0o644); werr == nil {
					coverImagePath = &thumbRel
				}
			}
		}

		now := time.Now().UTC().Unix()
		var descPtr, langPtr, pubPtr *string
		var pubAtPtr *int64
		if description != "" {
			d := description
			descPtr = &d
		}
		if language != "" {
			l := language
			langPtr = &l
		}
		if published != "" {
			p := published
			pubPtr = &p
			pubAtPtr = NormalizePublishedAtUnix(published)
		}

		persist := func(operationID string) error {
			tx, err := s.db.BeginTx(ctx, nil)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback() }()

			if err := collections.LockCollectionChanges(ctx, tx); err != nil {
				return err
			}
			targetCol, err := collections.ResolveBookTarget(ctx, tx, userID, true, []string{collectionID})
			if err != nil {
				return err
			}
			if replaceBookID != "" {
				curCol, err := collections.AssertBookEditor(ctx, tx, userID, bookID)
				if err != nil {
					return err
				}
				if curCol != targetCol {
					return httpapi.NewError(http.StatusConflict, "The source collection changed. Review the import again.")
				}
			}
			if operationID != "" {
				kind := "create"
				if replaceBookID != "" {
					kind = "replace"
				}
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO storage_operations (id, book_id, kind, created_at) VALUES (?, ?, ?, ?)
				`, operationID, bookID, kind, now); err != nil {
					return err
				}
			}

			if replaceBookID != "" {
				if _, err := tx.ExecContext(ctx, `
					UPDATE books
					SET title = ?, sort_title = ?, description = ?, published = ?, published_at = ?, language = ?, updated_at = ?
					WHERE id = ?
				`, title, MakeTitleSortKey(title), descPtr, pubPtr, pubAtPtr, langPtr, now, bookID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM book_authors WHERE book_id = ?`, bookID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM book_identifiers WHERE book_id = ?`, bookID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM book_files WHERE book_id = ?`, bookID); err != nil {
					return err
				}
			} else {
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO books (
						id, collection_id, added_by_user_id, added_at,
						title, sort_title, description, published, published_at,
						language, cover_image_path, created_by_user_id, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				`, bookID, targetCol, userID, now,
					title, MakeTitleSortKey(title), descPtr, pubPtr, pubAtPtr,
					langPtr, coverImagePath, userID, now, now); err != nil {
					return err
				}
			}

			aid, err := findOrCreateAuthorByName(ctx, tx, authorName)
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, 1)
			`, bookID, aid); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO book_files (id, book_id, format, relative_path, created_at)
				VALUES (?, ?, ?, ?, ?)
			`, uuid.NewString(), bookID, ext, relativePath, now); err != nil {
				return err
			}
			for _, ident := range identifiers {
				t := strings.ToLower(strings.TrimSpace(ident.Type))
				v := strings.TrimSpace(ident.Value)
				if t != "" && v != "" {
					if _, err := tx.ExecContext(ctx, `
						INSERT INTO book_identifiers (book_id, type, value)
						VALUES (?, ?, ?)
						ON CONFLICT(book_id, type) DO UPDATE SET value = excluded.value
					`, bookID, t, v); err != nil {
						return err
					}
				}
			}
			return tx.Commit()
		}

		if replaceBookID != "" {
			oldPaths, err := queryStringColumn(ctx, s.db, `SELECT relative_path FROM book_files WHERE book_id = ?`, bookID)
			if err != nil {
				return err
			}
			var sources []string
			for _, p := range oldPaths {
				if p == "" || (existingCoverImagePath != nil && p == *existingCoverImagePath) {
					continue
				}
				var dummy string
				if s.db.QueryRowContext(ctx, `SELECT id FROM book_files WHERE relative_path = ? AND book_id != ? LIMIT 1`, p, bookID).Scan(&dummy) == nil {
					continue
				}
				if s.db.QueryRowContext(ctx, `SELECT id FROM books WHERE cover_image_path = ? AND id != ? LIMIT 1`, p, bookID).Scan(&dummy) == nil {
					continue
				}
				abs, rerr := storage.ResolveUnderLibrary(s.libraryDir, p)
				if rerr == nil {
					if _, serr := os.Stat(abs); serr == nil {
						sources = append(sources, abs)
					}
				}
			}
			if err := storage.DeleteStoredFiles(ctx, s.libraryDir, bookID, sources, storage.DBDeleteDecision(s.db), persist); err != nil {
				return err
			}
		} else {
			opID := ""
			if creation != nil {
				opID = creation.ID
			}
			if err := persist(opID); err != nil {
				return err
			}
		}

		finalizing = true
		if creation != nil {
			if err := creation.Finish(ctx); err != nil {
				return err
			}
		}

		out = map[string]any{
			"id":             bookID,
			"title":          title,
			"author":         authorName,
			"format":         ext,
			"relativePath":   relativePath,
			"coverImagePath": coverImagePath,
			"createdAt":      formatUnixSecISO(now),
		}
		return nil
	})
	return out, err
}

// GET /api/books/{id}/cover
func (s *Service) handleGetBookCover(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}
	variant := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("variant")))
	if variant == "" {
		variant = "thumb"
	}
	if variant != "thumb" && variant != "source" {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid variant")
		return
	}

	var coverImagePath sql.NullString
	err := s.db.QueryRowContext(r.Context(), `
		SELECT b.cover_image_path
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&coverImagePath)
	if errors.Is(err, sql.ErrNoRows) || !coverImagePath.Valid || strings.TrimSpace(coverImagePath.String) == "" {
		httpapi.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/cover query failed", err)
		return
	}

	relFromLibrary := strings.TrimPrefix(storage.NormalizePosix(strings.TrimSpace(coverImagePath.String)), "library/")
	coverDirPosix := path.Dir(relFromLibrary)

	var chosenAbs string
	if variant == "thumb" {
		thumbRel := "thumb.webp"
		if coverDirPosix != "." && coverDirPosix != "" {
			thumbRel = coverDirPosix + "/thumb.webp"
		}
		thumbAbs, err := storage.ResolveUnderLibrary(s.libraryDir, thumbRel)
		if err != nil {
			httpapi.WriteHTTPError(w, err)
			return
		}
		if fileExistsNonEmpty(thumbAbs) {
			chosenAbs = thumbAbs
		} else {
			coverAbs, err := storage.ResolveUnderLibrary(s.libraryDir, relFromLibrary)
			if err != nil {
				httpapi.WriteHTTPError(w, err)
				return
			}
			if fileExistsNonEmpty(coverAbs) {
				chosenAbs = coverAbs
			}
		}
	} else {
		for _, cand := range coverSourceCandidates {
			relPosix := cand
			if coverDirPosix != "." && coverDirPosix != "" {
				relPosix = coverDirPosix + "/" + cand
			}
			abs, err := storage.ResolveUnderLibrary(s.libraryDir, relPosix)
			if err != nil {
				httpapi.WriteHTTPError(w, err)
				return
			}
			if fileExistsNonEmpty(abs) {
				chosenAbs = abs
				break
			}
		}
	}

	if chosenAbs == "" {
		httpapi.WriteError(w, http.StatusNotFound, "Not found")
		return
	}

	st, err := os.Stat(chosenAbs)
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	rawEtag := fmt.Sprintf("%s:%s:%d:%d", bookID, variant, st.Size(), st.ModTime().UnixMilli())
	sum := sha1.Sum([]byte(rawEtag))
	etag := `"` + hex.EncodeToString(sum[:]) + `"`

	w.Header().Set("Content-Type", coverContentTypeFromExt(filepath.Ext(chosenAbs)))
	w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
	w.Header().Set("ETag", etag)
	w.Header().Set("Vary", "Cookie")

	if inm := r.Header.Get("If-None-Match"); inm != "" {
		for _, part := range strings.Split(inm, ",") {
			t := strings.TrimSpace(part)
			if t == etag || t == "*" {
				w.WriteHeader(http.StatusNotModified)
				return
			}
		}
	}

	data, err := os.ReadFile(chosenAbs)
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func coverContentTypeFromExt(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".png":
		return "image/png"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".svg":
		return "image/svg+xml"
	case ".avif":
		return "image/avif"
	case ".tif", ".tiff":
		return "image/tiff"
	default:
		return "application/octet-stream"
	}
}

// POST /api/books/{id}/cover
func (s *Service) handleUploadBookCover(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	parts, err := readBoundedMultipart(r, maxCoverBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if len(parts) == 0 {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing form data")
		return
	}

	var coverData []byte
	foundFile := false
	for _, p := range parts {
		if p.Name == "file" && p.Data != nil {
			coverData = p.Data
			foundFile = true
			break
		}
	}
	if !foundFile {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing cover file")
		return
	}

	var respData map[string]any
	err = storage.WithBookStorageLock(r.Context(), s.libraryDir, bookID, func() error {
		var title string
		var coverImagePath sql.NullString
		err := s.db.QueryRowContext(r.Context(), `
			SELECT b.title, b.cover_image_path
			FROM books b
			INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
			WHERE b.id = ?
			LIMIT 1
		`, userID, bookID).Scan(&title, &coverImagePath)
		if errors.Is(err, sql.ErrNoRows) {
			return httpapi.NewError(http.StatusNotFound, "Book not found")
		}
		if err != nil {
			return err
		}
		if _, err := collections.AssertBookEditor(r.Context(), s.db, userID, bookID); err != nil {
			return err
		}

		files, err := listBookFilesDTO(r.Context(), s.db, bookID)
		if err != nil {
			return err
		}

		var bookDirAbs string
		if len(files) > 0 {
			preferred := files[0]
			for _, f := range files {
				if strings.EqualFold(f.Format, "epub") {
					preferred = f
					break
				}
			}
			if preferred.RelativePath == "" {
				return httpapi.NewError(http.StatusConflict, "Book file path missing; cannot store cover")
			}
			fileAbs, err := storage.ResolveUnderLibrary(s.libraryDir, preferred.RelativePath)
			if err != nil {
				return err
			}
			bookDirAbs = filepath.Dir(fileAbs)
		} else if coverImagePath.Valid && strings.TrimSpace(coverImagePath.String) != "" {
			covAbs, err := storage.ResolveUnderLibrary(s.libraryDir, strings.TrimSpace(coverImagePath.String))
			if err != nil {
				return err
			}
			bookDirAbs = filepath.Dir(covAbs)
		} else {
			type aRow struct {
				name string
				pos  sql.NullInt64
			}
			aRows, err := s.db.QueryContext(r.Context(), `
				SELECT a.name, ba.position
				FROM book_authors ba
				INNER JOIN authors a ON a.id = ba.author_id
				WHERE ba.book_id = ?
			`, bookID)
			if err != nil {
				return err
			}
			var links []aRow
			for aRows.Next() {
				var l aRow
				if err := aRows.Scan(&l.name, &l.pos); err != nil {
					_ = aRows.Close()
					return err
				}
				links = append(links, l)
			}
			_ = aRows.Close()
			sort.Slice(links, func(i, j int) bool {
				ap := int64(10000)
				if links[i].pos.Valid {
					ap = links[i].pos.Int64
				}
				bp := int64(10000)
				if links[j].pos.Valid {
					bp = links[j].pos.Int64
				}
				if ap != bp {
					return ap < bp
				}
				return links[i].name < links[j].name
			})
			var ordered []string
			for _, l := range links {
				if l.name != "" {
					ordered = append(ordered, l.name)
				}
			}
			canonical := storage.GetCanonicalBookPaths(ordered, title, bookID)
			dirAbs, err := storage.ResolveUnderLibrary(s.libraryDir, canonical.BookDir)
			if err != nil {
				return err
			}
			bookDirAbs = dirAbs
		}

		if err := os.MkdirAll(bookDirAbs, 0o755); err != nil {
			return err
		}

		decision := storage.DBCoverDecision(s.db, bookID)
		prevCoverPtr := nullStringPtr(coverImagePath)
		recRes, err := storage.RecoverPendingCoverUpdates(r.Context(), bookDirAbs, s.libraryDir, prevCoverPtr, bookID, &decision)
		if err != nil {
			return err
		}
		fallbackSet := make(map[string]struct{})
		for _, p := range recRes.BackupFallbackPaths {
			fallbackSet[p] = struct{}{}
		}

		if len(coverData) > maxCoverUploadBytes {
			return httpapi.NewError(http.StatusRequestEntityTooLarge, "Cover image exceeds the 25 MiB upload limit")
		}

		meta, err := SniffImageMeta(coverData)
		if err != nil {
			return httpapi.NewError(http.StatusUnsupportedMediaType, "Unsupported or invalid cover image")
		}
		if int64(meta.Width)*int64(meta.Height) > maxCoverPixels {
			return httpapi.NewError(http.StatusRequestEntityTooLarge, "Cover image exceeds the 100 megapixel limit")
		}

		var ext string
		switch meta.Format {
		case "jpeg", "jpg":
			ext = "jpg"
		case "png":
			ext = "png"
		case "webp":
			ext = "webp"
		case "gif":
			ext = "gif"
		case "tiff", "tif":
			ext = "tiff"
		default:
			return httpapi.NewError(http.StatusUnsupportedMediaType, "Unsupported cover image format")
		}

		img, _, err := DecodeImageAndOrient(coverData)
		if err != nil {
			return httpapi.NewError(http.StatusUnsupportedMediaType, "Unsupported or invalid cover image")
		}
		thumbWebp, err := EncodeWebP(ResizeMaxWidth(img, 320))
		if err != nil {
			return err
		}
		embeddedJpeg, err := EncodeJPEG(img, 95)
		if err != nil {
			return err
		}

		sourceAbs := filepath.Join(bookDirAbs, "cover."+ext)
		thumbAbs := filepath.Join(bookDirAbs, "thumb.webp")
		relThumb, err := filepath.Rel(s.libraryDir, thumbAbs)
		if err != nil {
			return err
		}
		thumbRelPosix := storage.BaseDir + "/" + filepath.ToSlash(relThumb)

		updates := []storage.CoverUpdateFile{
			{TargetPath: sourceAbs, Data: coverData},
			{TargetPath: thumbAbs, Data: thumbWebp},
		}

		epubWarnings := make([]string, 0)
		var epubFiles []bookFileDTO
		for _, f := range files {
			if strings.EqualFold(f.Format, "epub") {
				epubFiles = append(epubFiles, f)
			}
		}
		for _, ef := range epubFiles {
			epubAbs, err := storage.ResolveUnderLibrary(s.libraryDir, ef.RelativePath)
			if err != nil {
				return err
			}
			epubBytes, err := os.ReadFile(epubAbs)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return httpapi.NewErrorWithData(
						http.StatusConflict,
						"An associated EPUB file is missing. Restore the file or correct its library entry, then retry the cover upload.",
						map[string]any{
							"code":         "EPUB_FILE_MISSING",
							"relativePath": ef.RelativePath,
						},
					)
				}
				return err
			}
			res, err := epub.SetCover(epubBytes, embeddedJpeg, "image/jpeg", epub.CoverMutationOptions{
				RepairMimetype: true,
			})
			if err != nil {
				var epubErr *epub.Error
				if errors.As(err, &epubErr) {
					return httpapi.NewErrorWithData(
						http.StatusUnprocessableEntity,
						"EPUB cover update failed: "+epubErr.Message,
						map[string]any{"code": string(epubErr.Code)},
					)
				}
				return err
			}
			verified, err := epub.InspectCover(res.Data, nil)
			if err != nil || verified == nil || verified.MediaType != "image/jpeg" {
				return httpapi.NewErrorWithData(
					http.StatusUnprocessableEntity,
					"EPUB cover update failed: Rewritten EPUB did not contain the expected JPEG cover: "+ef.RelativePath,
					map[string]any{"code": string(epub.ErrInvalidEpub)},
				)
			}
			for _, wmsg := range res.Warnings {
				epubWarnings = append(epubWarnings, ef.RelativePath+": "+wmsg)
			}
			updates = append(updates, storage.CoverUpdateFile{
				TargetPath: epubAbs,
				Data:       res.Data,
			})
		}

		commitRes, err := storage.CommitCoverUpdate(r.Context(), storage.CommitCoverUpdateOptions{
			OperationParent:        bookDirAbs,
			AllowedRoot:            s.libraryDir,
			PreviousCoverImagePath: prevCoverPtr,
			ExpectedCoverImagePath: thumbRelPosix,
			BookID:                 bookID,
			Files:                  updates,
			Decision:               &decision,
			CommitDatabase: func(opID string) error {
				tx, err := s.db.BeginTx(r.Context(), nil)
				if err != nil {
					return err
				}
				defer func() { _ = tx.Rollback() }()
				if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
					return err
				}
				if _, err := collections.AssertBookEditor(r.Context(), tx, userID, bookID); err != nil {
					return err
				}
				now := time.Now().UTC().Unix()
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO storage_operations (id, book_id, kind, created_at)
					VALUES (?, ?, 'cover', ?)
				`, opID, bookID, now); err != nil {
					return err
				}
				if _, err := tx.ExecContext(r.Context(), `
					UPDATE books SET cover_image_path = ?, updated_at = ? WHERE id = ?
				`, thumbRelPosix, now, bookID); err != nil {
					return err
				}
				return tx.Commit()
			},
			RollbackDatabase: func() error {
				_, err := s.db.ExecContext(r.Context(), `
					UPDATE books SET cover_image_path = ?, updated_at = ? WHERE id = ?
				`, prevCoverPtr, time.Now().UTC().Unix(), bookID)
				return err
			},
		})
		if err != nil {
			var stErr *storage.CoverUpdateStorageError
			if errors.As(err, &stErr) {
				return httpapi.NewErrorWithData(
					http.StatusInsufficientStorage,
					"Library storage could not safely replace an existing cover file",
					map[string]any{"code": stErr.Code},
				)
			}
			return err
		}

		for _, p := range commitRes.BackupFallbackPaths {
			fallbackSet[p] = struct{}{}
		}

		// Clean prior source variants best-effort.
		targetSourceLower := strings.ToLower(filepath.Base(sourceAbs))
		if dirEntries, derr := os.ReadDir(bookDirAbs); derr == nil {
			for _, de := range dirEntries {
				if de.IsDir() || !de.Type().IsRegular() {
					continue
				}
				if !oldCoverSourceRe.MatchString(de.Name()) {
					continue
				}
				if strings.ToLower(de.Name()) == targetSourceLower {
					continue
				}
				_ = os.Remove(filepath.Join(bookDirAbs, de.Name()))
			}
		}

		respData = map[string]any{
			"coverImagePath":   thumbRelPosix,
			"embeddedEpubs":    len(epubFiles),
			"totalEpubs":       len(epubFiles),
			"storageFallbacks": len(fallbackSet),
			"warnings":         epubWarnings,
		}
		return nil
	})
	if err != nil {
		s.writeErrWithFallback(w, "POST /api/books/{id}/cover failed", "Failed to upload cover", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    respData,
	})
}

// GET /api/books/{id}/download
func (s *Service) handleDownloadBook(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	q := r.URL.Query()
	requestedFileID := strings.TrimSpace(q.Get("fileId"))
	requestedFormat := strings.ToLower(strings.TrimSpace(q.Get("format")))

	var title string
	err := s.db.QueryRowContext(r.Context(), `
		SELECT b.title
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&title)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/download query failed", err)
		return
	}

	allFiles, err := listBookFilesDTO(r.Context(), s.db, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/download files failed", err)
		return
	}

	var normalized []bookFileDTO
	for _, f := range allFiles {
		f.Format = strings.ToLower(strings.TrimSpace(f.Format))
		if isSupportedBookFormat(f.Format) {
			normalized = append(normalized, f)
		}
	}

	var chosen *bookFileDTO
	if requestedFileID != "" {
		for i := range normalized {
			if normalized[i].ID == requestedFileID {
				chosen = &normalized[i]
				break
			}
		}
		if chosen == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Book file not found")
			return
		}
	}
	if requestedFormat != "" {
		var fromFormat *bookFileDTO
		for i := range normalized {
			if normalized[i].Format == requestedFormat {
				fromFormat = &normalized[i]
				break
			}
		}
		if fromFormat == nil {
			httpapi.WriteError(w, http.StatusNotFound, "Book file not found")
			return
		}
		if chosen == nil {
			chosen = fromFormat
		}
	}
	if chosen == nil {
		for _, pref := range preferredDownloadOrd {
			for i := range normalized {
				if normalized[i].Format == pref {
					chosen = &normalized[i]
					break
				}
			}
			if chosen != nil {
				break
			}
		}
	}
	if chosen == nil && len(normalized) > 0 {
		chosen = &normalized[0]
	}
	if chosen == nil || chosen.RelativePath == "" {
		httpapi.WriteError(w, http.StatusInternalServerError, "Book file path missing")
		return
	}

	fileAbs, err := storage.ResolveUnderLibrary(s.libraryDir, chosen.RelativePath)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	format := chosen.Format
	if format == "" {
		format = strings.TrimPrefix(strings.ToLower(filepath.Ext(fileAbs)), ".")
	}
	contentType, ok := downloadMimeByFormat[format]
	if !ok {
		httpapi.WriteError(w, http.StatusBadRequest, "Unsupported book format for download")
		return
	}

	f, err := os.Open(fileAbs)
	if err != nil {
		httpapi.WriteError(w, http.StatusNotFound, "Not found")
		return
	}
	defer func() { _ = f.Close() }()

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", storage.BookDownloadDisposition(title, format))
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// GET /api/books/{id}/files
func (s *Service) handleListBookFiles(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}
	visible, err := isBookVisibleToUser(r.Context(), s.db, userID, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/files visibility failed", err)
		return
	}
	if !visible {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	files, err := listBookFilesDTO(r.Context(), s.db, bookID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/files query failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"files": files},
	})
}
