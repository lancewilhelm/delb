package spines

import (
	"crypto/sha1"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
	"github.com/lancewilhelm/delb/internal/storage"
)

const maxMiniCoverSettingsBodyBytes int64 = 16 * 1024

// MiniCoverSettings holds the saved per-book mini book cover configuration.
type MiniCoverSettings struct {
	SpineSource string  `json:"spineSource"`
	SpineFit    string  `json:"spineFit"`
	SpineOffset float64 `json:"spineOffset"`
	BackStyle   string  `json:"backStyle"`
	Orientation string  `json:"orientation"`
	Resolution  string  `json:"resolution"`
	BleedMm     int     `json:"bleedMm"`
	FoldMarks   bool    `json:"foldMarks"`
	TrimMarks   bool    `json:"trimMarks"`
}

func DefaultMiniCoverSettings() MiniCoverSettings {
	return MiniCoverSettings{
		SpineSource: "book",
		SpineFit:    "crop",
		SpineOffset: 0,
		BackStyle:   "same",
		Orientation: "ltr",
		Resolution:  "high",
		BleedMm:     0,
		FoldMarks:   true,
		TrimMarks:   false,
	}
}

func ParseMiniCoverSettings(raw any) (*MiniCoverSettings, bool) {
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return nil, false
	}
	out := DefaultMiniCoverSettings()

	if v, ok := m["spineSource"]; ok {
		s, ok := v.(string)
		if !ok || (s != "mini" && s != "book" && s != "plain") {
			return nil, false
		}
		out.SpineSource = s
	}
	if v, ok := m["spineFit"]; ok {
		s, ok := v.(string)
		if !ok || (s != "crop" && s != "fit" && s != "stretch") {
			return nil, false
		}
		out.SpineFit = s
	}
	if v, ok := m["spineOffset"]; ok {
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < -1 || f > 1 {
			return nil, false
		}
		out.SpineOffset = math.Round(f*100) / 100
	}
	if v, ok := m["backStyle"]; ok {
		s, ok := v.(string)
		if !ok || (s != "same" && s != "solid" && s != "blur") {
			return nil, false
		}
		out.BackStyle = s
	}
	if v, ok := m["orientation"]; ok {
		s, ok := v.(string)
		if !ok || (s != "ltr" && s != "rtl") {
			return nil, false
		}
		out.Orientation = s
	}
	if v, ok := m["resolution"]; ok {
		s, ok := v.(string)
		if !ok || (s != "standard" && s != "high") {
			return nil, false
		}
		out.Resolution = s
	}
	if v, ok := m["bleedMm"]; ok {
		f, ok := v.(float64)
		if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
			return nil, false
		}
		b := int(f)
		if b != 0 && b != 1 && b != 2 {
			return nil, false
		}
		out.BleedMm = b
	}
	if v, ok := m["foldMarks"]; ok {
		b, ok := v.(bool)
		if !ok {
			return nil, false
		}
		out.FoldMarks = b
	}
	if v, ok := m["trimMarks"]; ok {
		b, ok := v.(bool)
		if !ok {
			return nil, false
		}
		out.TrimMarks = b
	}
	return &out, true
}

func (s *Service) readStoredSpineBytes(relPath, fallbackB64 string) ([]byte, error) {
	if relPath != "" {
		absPath, err := storage.ResolveUnderLibrary(s.libraryDir, relPath)
		if err != nil {
			return nil, err
		}
		data, err := readBoundedFile(absPath, SpineMaxBytes)
		if err == nil {
			return data, nil
		}
		if !errors.Is(err, os.ErrNotExist) || fallbackB64 == "" {
			return nil, err
		}
	}
	if fallbackB64 == "" {
		return nil, os.ErrNotExist
	}
	return base64.StdEncoding.DecodeString(fallbackB64)
}

func (s *Service) existingAbsPaths(relPaths ...string) []string {
	var out []string
	seen := make(map[string]struct{}, len(relPaths))
	for _, rel := range relPaths {
		if rel == "" {
			continue
		}
		absPath, err := storage.ResolveUnderLibrary(s.libraryDir, rel)
		if err != nil {
			continue
		}
		cleaned := filepath.Clean(absPath)
		if _, ok := seen[cleaned]; ok {
			continue
		}
		if _, err := os.Stat(cleaned); err == nil {
			seen[cleaned] = struct{}{}
			out = append(out, cleaned)
		}
	}
	return out
}

// /api/books/{id}/mini-cover (GET, PUT, else 405)
func (s *Service) handleBookMiniCover(w http.ResponseWriter, r *http.Request) {
	swu := httpapi.SessionFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var visibleID string
	err := s.db.QueryRowContext(r.Context(), `
		SELECT b.id
		FROM books b
		INNER JOIN visible_books vb ON vb.book_id = b.id AND vb.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, swu.User.ID, bookID).Scan(&visibleID)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErr(w, "/api/books/{id}/mini-cover visibility failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")

	if r.Method == http.MethodGet {
		var (
			rev         string
			editsRaw    string
			settingsRaw string
			updatedAt   int64
		)
		err := s.db.QueryRowContext(r.Context(), `
			SELECT spine_revision, spine_edits, settings, updated_at
			FROM book_mini_covers
			WHERE book_id = ?
			LIMIT 1
		`, bookID).Scan(&rev, &editsRaw, &settingsRaw, &updatedAt)
		if errors.Is(err, sql.ErrNoRows) {
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"hasSpine":      false,
				"spineRevision": nil,
				"spineEdits":    nil,
				"settings":      nil,
				"updatedAt":     nil,
			})
			return
		}
		if err != nil {
			s.writeErr(w, "GET /api/books/{id}/mini-cover query failed", err)
			return
		}

		var editsVal any
		if editsRaw != "" {
			_ = json.Unmarshal([]byte(editsRaw), &editsVal)
		}
		var settingsVal any
		if settingsRaw != "" && settingsRaw != "{}" {
			var parsed any
			if json.Unmarshal([]byte(settingsRaw), &parsed) == nil {
				if clean, ok := ParseMiniCoverSettings(parsed); ok {
					settingsVal = clean
				}
			}
		}
		var revPtr *string
		if rev != "" {
			revPtr = &rev
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"hasSpine":      rev != "",
			"spineRevision": revPtr,
			"spineEdits":    editsVal,
			"settings":      settingsVal,
			"updatedAt":     time.Unix(updatedAt, 0).UTC().Format(time.RFC3339),
		})
		return
	}

	if r.Method != http.MethodPut {
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	if err := library.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/mini-cover editor auth failed", err)
		return
	}

	raw, err := httpapi.ReadBodyBounded(r, maxMiniCoverSettingsBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var payload map[string]any
	if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &payload) != nil || payload == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid mini cover settings")
		return
	}
	settingsInput := any(payload)
	if nested, ok := payload["settings"]; ok {
		settingsInput = nested
	}
	parsed, ok := ParseMiniCoverSettings(settingsInput)
	if !ok {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid mini cover settings")
		return
	}
	settingsJSON, err := json.Marshal(parsed)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/mini-cover marshal failed", err)
		return
	}

	now := time.Now().UTC().Unix()
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/books/{id}/mini-cover begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := library.AssertBookEditor(r.Context(), tx, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/mini-cover tx auth failed", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO book_mini_covers (book_id, settings, updated_at)
		VALUES (?, ?, ?)
		ON CONFLICT(book_id) DO UPDATE SET
			settings = excluded.settings,
			updated_at = excluded.updated_at
	`, bookID, string(settingsJSON), now); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/mini-cover upsert failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/books/{id}/mini-cover commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"settings": parsed,
	})
}

// /api/books/{id}/mini-cover/spine (GET, POST, DELETE, else 405)
func (s *Service) handleBookMiniCoverSpine(w http.ResponseWriter, r *http.Request) {
	swu := httpapi.SessionFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	var visibleID string
	err := s.db.QueryRowContext(r.Context(), `
		SELECT b.id
		FROM books b
		INNER JOIN visible_books vb ON vb.book_id = b.id AND vb.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, swu.User.ID, bookID).Scan(&visibleID)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErr(w, "/api/books/{id}/mini-cover/spine visibility failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	if r.Method == http.MethodGet {
		variant := r.URL.Query().Get("variant")
		if variant == "" {
			variant = "image"
		}
		if variant != "metadata" && variant != "image" && variant != "source" {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid mini spine variant")
			return
		}
		if variant == "metadata" {
			var rev, editsRaw string
			err := s.db.QueryRowContext(r.Context(), `
				SELECT spine_revision, spine_edits FROM book_mini_covers WHERE book_id = ? LIMIT 1
			`, bookID).Scan(&rev, &editsRaw)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && rev == "") {
				httpapi.WriteJSON(w, http.StatusOK, map[string]any{
					"exists":   false,
					"revision": nil,
					"edits":    nil,
				})
				return
			}
			if err != nil {
				s.writeErr(w, "GET /api/books/{id}/mini-cover/spine metadata failed", err)
				return
			}
			var editsVal any
			_ = json.Unmarshal([]byte(editsRaw), &editsVal)
			httpapi.WriteJSON(w, http.StatusOK, map[string]any{
				"exists":   true,
				"revision": rev,
				"edits":    editsVal,
			})
			return
		}

		if variant == "source" {
			if err := library.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
				s.writeErr(w, "GET /api/books/{id}/mini-cover/spine source auth failed", err)
				return
			}
		}

		var rev, imgPath, srcPath, origType string
		err := s.db.QueryRowContext(r.Context(), `
			SELECT spine_revision, spine_image_path, spine_source_path, spine_original_type
			FROM book_mini_covers
			WHERE book_id = ?
			LIMIT 1
		`, bookID).Scan(&rev, &imgPath, &srcPath, &origType)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && rev == "") {
			httpapi.WriteError(w, http.StatusNotFound, "No mini cover spine")
			return
		}
		if err != nil {
			s.writeErr(w, "GET /api/books/{id}/mini-cover/spine query failed", err)
			return
		}

		sum := sha1.Sum([]byte(fmt.Sprintf("%s:mini:%s:%s", bookID, variant, rev)))
		etag := `"` + hex.EncodeToString(sum[:]) + `"`
		w.Header().Set("ETag", etag)
		if v := strings.TrimSpace(r.URL.Query().Get("v")); v != "" && v == rev {
			w.Header().Set("Cache-Control", "private, max-age=300, stale-while-revalidate=3600")
		} else {
			w.Header().Set("Cache-Control", "private, max-age=0, must-revalidate")
		}
		if inm := r.Header.Get("If-None-Match"); inm != "" {
			for _, part := range strings.Split(inm, ",") {
				t := strings.TrimSpace(part)
				if t == etag || t == "*" {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}

		targetRel := imgPath
		ct := "image/webp"
		if variant == "source" {
			targetRel = srcPath
			if origType != "" {
				ct = origType
			}
		}
		data, err := s.readStoredSpineBytes(targetRel, "")
		if errors.Is(err, os.ErrNotExist) {
			httpapi.WriteError(w, http.StatusNotFound, "No mini cover spine")
			return
		}
		if err != nil {
			s.writeErr(w, "GET /api/books/{id}/mini-cover/spine read failed", err)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
		return
	}

	if err := library.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "/api/books/{id}/mini-cover/spine editor auth failed", err)
		return
	}

	if r.Method == http.MethodDelete {
		raw, err := httpapi.ReadBodyBounded(r, maxSpineDeleteBodyBytes)
		if err != nil {
			httpapi.WriteHTTPError(w, err)
			return
		}
		var fields map[string]json.RawMessage
		if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Missing spine revision")
			return
		}
		var expectedRev string
		revRaw, hasRev := fields["revision"]
		if !hasRev || json.Unmarshal(revRaw, &expectedRev) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Missing spine revision")
			return
		}

		err = storage.WithBookStorageLock(r.Context(), s.libraryDir, bookID, func() error {
			var currentRev, imgPath, srcPath string
			err := s.db.QueryRowContext(r.Context(), `
				SELECT spine_revision, spine_image_path, spine_source_path
				FROM book_mini_covers
				WHERE book_id = ?
				LIMIT 1
			`, bookID).Scan(&currentRev, &imgPath, &srcPath)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && (currentRev == "" || currentRev != expectedRev)) {
				return httpapi.NewError(http.StatusConflict, "Mini cover spine changed. Reload before saving.")
			}
			if err != nil {
				return err
			}

			sources := s.existingAbsPaths(imgPath, srcPath)
			commitDB := func(opID string) error {
				tx, err := s.db.BeginTx(r.Context(), nil)
				if err != nil {
					return err
				}
				defer func() { _ = tx.Rollback() }()
				if err := library.AssertBookEditor(r.Context(), tx, swu.User.ID, bookID); err != nil {
					return err
				}
				if opID != "" {
					if _, err := tx.ExecContext(r.Context(), `
						INSERT INTO storage_operations (id, book_id, kind, created_at)
						VALUES (?, ?, 'delete', ?)
					`, opID, bookID, time.Now().UTC().Unix()); err != nil {
						return err
					}
				}
				res, err := tx.ExecContext(r.Context(), `
					UPDATE book_mini_covers
					SET spine_image_path = '',
					    spine_source_path = '',
					    spine_original_type = '',
					    spine_edits = '',
					    spine_revision = '',
					    updated_at = ?
					WHERE book_id = ? AND spine_revision = ?
				`, time.Now().UTC().Unix(), bookID, expectedRev)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n == 0 {
					return httpapi.NewError(http.StatusConflict, "Mini cover spine changed. Reload before saving.")
				}
				return tx.Commit()
			}
			if len(sources) > 0 {
				if err := os.MkdirAll(s.libraryDir, 0o755); err != nil {
					return err
				}
				return storage.DeleteStoredFiles(r.Context(), s.libraryDir, bookID, sources, storage.DBDeleteDecision(s.db), commitDB)
			}
			return commitDB("")
		})
		if err != nil {
			s.writeErr(w, "DELETE /api/books/{id}/mini-cover/spine failed", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})
		return
	}

	if r.Method != http.MethodPost {
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
		return
	}

	parts, err := books.ReadBoundedMultipart(r, maxSpineUploadBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var (
		filePart     *books.MultipartPart
		editsPart    *books.MultipartPart
		revisionPart *books.MultipartPart
		settingsPart *books.MultipartPart
	)
	for i := range parts {
		p := &parts[i]
		if p.Name == "file" && p.Filename != "" && filePart == nil {
			filePart = p
		} else if p.Name == "edits" && editsPart == nil {
			editsPart = p
		} else if p.Name == "revision" && revisionPart == nil {
			revisionPart = p
		} else if p.Name == "settings" && settingsPart == nil {
			settingsPart = p
		}
	}

	var rawEdits any
	if editsPart == nil || json.Unmarshal(editsPart.Data, &rawEdits) != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid spine edits")
		return
	}
	edits, ok := ParseSpineEdits(rawEdits)
	if !ok || revisionPart == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid spine edits or revision")
		return
	}
	expected := string(revisionPart.Data)

	var settingsJSON string
	var parsedSettings *MiniCoverSettings
	if settingsPart != nil && len(strings.TrimSpace(string(settingsPart.Data))) > 0 {
		var rawSettings any
		if json.Unmarshal(settingsPart.Data, &rawSettings) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid mini cover settings")
			return
		}
		sVal, sok := ParseMiniCoverSettings(rawSettings)
		if !sok {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid mini cover settings")
			return
		}
		parsedSettings = sVal
		b, merr := json.Marshal(sVal)
		if merr != nil {
			s.writeErr(w, "POST /api/books/{id}/mini-cover/spine marshal settings failed", merr)
			return
		}
		settingsJSON = string(b)
	}

	var newRevision string
	err = storage.WithBookStorageLock(r.Context(), s.libraryDir, bookID, func() error {
		var (
			prevRev     string
			prevSrcPath string
			hasPrevious bool
		)
		err := s.db.QueryRowContext(r.Context(), `
			SELECT spine_revision, spine_source_path FROM book_mini_covers WHERE book_id = ? LIMIT 1
		`, bookID).Scan(&prevRev, &prevSrcPath)
		if err == nil && prevRev != "" {
			hasPrevious = true
		} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		if prevRev != expected {
			return httpapi.NewError(http.StatusConflict, "Mini cover spine changed. Reload before saving.")
		}
		if filePart == nil && !hasPrevious {
			return httpapi.NewError(http.StatusBadRequest, "Choose a spine image")
		}

		var original []byte
		if filePart != nil {
			original = filePart.Data
		} else {
			original, err = s.readStoredSpineBytes(prevSrcPath, "")
			if err != nil {
				return err
			}
		}

		renderedWebP, contentType, err := RenderMiniSpine(original, *edits)
		if err != nil {
			return httpapi.NewError(http.StatusBadRequest, "Use a static JPEG, PNG, WebP or AVIF under 10 MB and 24 megapixels.")
		}

		relDir, absDir, err := storage.ResolveBookStorageDir(r.Context(), s.db, s.libraryDir, bookID)
		if err != nil {
			return err
		}

		ext := storage.SpineFileExt(contentType)
		renderedName := "mini-spine.webp"
		sourceName := "mini-spine.source." + ext
		renderedRel := relDir + "/" + renderedName
		sourceRel := relDir + "/" + sourceName

		newRevision = uuid.NewString()
		editsJSON, err := json.Marshal(edits)
		if err != nil {
			return err
		}

		files := []storage.CoverUpdateFile{
			{TargetPath: filepath.Join(absDir, renderedName), Data: renderedWebP},
			{TargetPath: filepath.Join(absDir, sourceName), Data: original},
		}
		stale := s.existingAbsPaths(prevSrcPath)

		return storage.WriteBookSpineFiles(r.Context(), s.db, s.libraryDir, bookID, absDir, files, stale, func(opID string) error {
			tx, err := s.db.BeginTx(r.Context(), nil)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback() }()

			if err := library.AssertBookEditor(r.Context(), tx, swu.User.ID, bookID); err != nil {
				return err
			}
			var currentRev string
			err = tx.QueryRowContext(r.Context(), `
				SELECT spine_revision FROM book_mini_covers WHERE book_id = ? LIMIT 1
			`, bookID).Scan(&currentRev)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if currentRev != expected {
				return httpapi.NewError(http.StatusConflict, "Mini cover spine changed. Reload before saving.")
			}

			now := time.Now().UTC().Unix()
			if _, err := tx.ExecContext(r.Context(), `
				INSERT INTO storage_operations (id, book_id, kind, created_at)
				VALUES (?, ?, 'cover', ?)
			`, opID, bookID, now); err != nil {
				return err
			}

			if settingsJSON != "" {
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO book_mini_covers (book_id, spine_image_path, spine_source_path, spine_original_type, spine_edits, spine_revision, settings, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(book_id) DO UPDATE SET
						spine_image_path = excluded.spine_image_path,
						spine_source_path = excluded.spine_source_path,
						spine_original_type = excluded.spine_original_type,
						spine_edits = excluded.spine_edits,
						spine_revision = excluded.spine_revision,
						settings = excluded.settings,
						updated_at = excluded.updated_at
				`, bookID, renderedRel, sourceRel, contentType, string(editsJSON), newRevision, settingsJSON, now); err != nil {
					return err
				}
			} else {
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO book_mini_covers (book_id, spine_image_path, spine_source_path, spine_original_type, spine_edits, spine_revision, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(book_id) DO UPDATE SET
						spine_image_path = excluded.spine_image_path,
						spine_source_path = excluded.spine_source_path,
						spine_original_type = excluded.spine_original_type,
						spine_edits = excluded.spine_edits,
						spine_revision = excluded.spine_revision,
						updated_at = excluded.updated_at
				`, bookID, renderedRel, sourceRel, contentType, string(editsJSON), newRevision, now); err != nil {
					return err
				}
			}
			return tx.Commit()
		})
	})
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/mini-cover/spine failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "mini cover spine saved",
		"bookId", bookID,
		"userId", swu.User.ID,
		"revision", newRevision,
	)

	resp := map[string]any{
		"success":  true,
		"revision": newRevision,
	}
	if parsedSettings != nil {
		resp["settings"] = parsedSettings
	}
	httpapi.WriteJSON(w, http.StatusOK, resp)
}
