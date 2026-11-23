package spines

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	maxSpineUploadBodyBytes   int64 = SpineMaxBytes + 1024*1024
	maxSpineDeleteBodyBytes   int64 = 4096
	maxAdminChatGPTBodyBytes  int64 = 4096
	maxSpineGenBodyBytes      int64 = SpineMaxBytes + 64*1024
	maxProviderResponseBytes  int64 = 16 * 1024 * 1024
	maxPromptInstructionChars       = 2000
)

var strictBase64Re = regexp.MustCompile(`^[A-Za-z0-9+/]*={0,2}$`)

func rejectCrossSite(w http.ResponseWriter, r *http.Request) bool {
	sfs := strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))
	if sfs == "cross-site" || sfs == "same-site" {
		httpapi.WriteError(w, http.StatusForbidden, "Cross-site requests are not allowed.")
		return true
	}
	return false
}

func assertCollectionAdminDB(ctx context.Context, q collections.Queryable, userID string) error {
	var role string
	err := q.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ? LIMIT 1`, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && role != "admin" && role != "owner") {
		return httpapi.NewError(http.StatusForbidden, "Administrator access required")
	}
	return err
}

func readBoundedFile(absPath string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, errors.New("file exceeds limit")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("file exceeds limit")
	}
	return data, nil
}

func accountHeadersFromJWT(token string) map[string]string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims map[string]any
	if err := json.Unmarshal(decoded, &claims); err != nil || claims == nil {
		return nil
	}
	authData, ok := claims["https://api.openai.com/auth"].(map[string]any)
	if !ok || authData == nil {
		return nil
	}
	headers := map[string]string{}
	if accountID, ok := authData["chatgpt_account_id"].(string); ok {
		headers["ChatGPT-Account-ID"] = accountID
	}
	if res, ok := authData["chatgpt_data_residency"].(string); ok {
		headers["x-openai-internal-codex-residency"] = res
	} else if res, ok := authData["chatgpt_compute_residency"].(string); ok {
		headers["x-openai-internal-codex-residency"] = res
	}
	return headers
}

// /api/books/{id}/spine (GET, POST, DELETE, else 405)
func (s *Service) handleBookSpine(w http.ResponseWriter, r *http.Request) {
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
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, swu.User.ID, bookID).Scan(&visibleID)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErr(w, "/api/books/{id}/spine visibility failed", err)
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
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid spine variant")
			return
		}
		if variant == "metadata" {
			var (
				rev      string
				editsRaw string
			)
			err := s.db.QueryRowContext(r.Context(), `
				SELECT revision, edits FROM book_spines WHERE book_id = ? LIMIT 1
			`, bookID).Scan(&rev, &editsRaw)
			if errors.Is(err, sql.ErrNoRows) {
				httpapi.WriteJSON(w, http.StatusOK, map[string]any{
					"exists":   false,
					"revision": nil,
					"edits":    nil,
				})
				return
			}
			if err != nil {
				s.writeErr(w, "GET /api/books/{id}/spine metadata failed", err)
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
			if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
				s.writeErr(w, "GET /api/books/{id}/spine source auth failed", err)
				return
			}
		}

		// Read only the lightweight indexed revision first so matching
		// If-None-Match requests return 304 without touching large image blobs.
		var rev string
		err := s.db.QueryRowContext(r.Context(), `
			SELECT revision
			FROM book_spines
			WHERE book_id = ?
			LIMIT 1
		`, bookID).Scan(&rev)
		if errors.Is(err, sql.ErrNoRows) {
			httpapi.WriteError(w, http.StatusNotFound, "No spine artwork")
			return
		}
		if err != nil {
			s.writeErr(w, "GET /api/books/{id}/spine revision query failed", err)
			return
		}

		sum := sha1.Sum([]byte(fmt.Sprintf("%s:%s:%s", bookID, variant, rev)))
		etag := `"` + hex.EncodeToString(sum[:]) + `"`
		w.Header().Set("ETag", etag)
		if v := strings.TrimSpace(r.URL.Query().Get("v")); v != "" && v == rev {
			// Revision-pinned spine URLs cache-bust automatically on any edit.
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

		// Select ONLY the blob column needed for the requested variant so
		// rendering shelves never reads multi-megabyte original_base64 blobs.
		var (
			ct     string
			rawB64 string
		)
		if variant == "source" {
			err = s.db.QueryRowContext(r.Context(), `
				SELECT original_type, original_base64
				FROM book_spines
				WHERE book_id = ?
				LIMIT 1
			`, bookID).Scan(&ct, &rawB64)
		} else {
			ct = "image/webp"
			err = s.db.QueryRowContext(r.Context(), `
				SELECT image_base64
				FROM book_spines
				WHERE book_id = ?
				LIMIT 1
			`, bookID).Scan(&rawB64)
		}
		if errors.Is(err, sql.ErrNoRows) {
			httpapi.WriteError(w, http.StatusNotFound, "No spine artwork")
			return
		}
		if err != nil {
			s.writeErr(w, "GET /api/books/{id}/spine image query failed", err)
			return
		}

		data, err := base64.StdEncoding.DecodeString(rawB64)
		if err != nil {
			s.writeErr(w, "GET /api/books/{id}/spine base64 decode failed", err)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
		return
	}

	if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "/api/books/{id}/spine editor auth failed", err)
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

		tx, err := s.db.BeginTx(r.Context(), nil)
		if err != nil {
			s.writeErr(w, "DELETE /api/books/{id}/spine begin tx failed", err)
			return
		}
		defer func() { _ = tx.Rollback() }()

		if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
			s.writeErr(w, "DELETE /api/books/{id}/spine lock failed", err)
			return
		}
		if _, err := collections.AssertBookEditor(r.Context(), tx, swu.User.ID, bookID); err != nil {
			s.writeErr(w, "DELETE /api/books/{id}/spine tx auth failed", err)
			return
		}
		res, err := tx.ExecContext(r.Context(), `
			DELETE FROM book_spines WHERE book_id = ? AND revision = ?
		`, bookID, expectedRev)
		if err != nil {
			s.writeErr(w, "DELETE /api/books/{id}/spine delete failed", err)
			return
		}
		if n, _ := res.RowsAffected(); n == 0 {
			httpapi.WriteError(w, http.StatusConflict, "Spine artwork changed. Reload before saving.")
			return
		}
		if err := tx.Commit(); err != nil {
			s.writeErr(w, "DELETE /api/books/{id}/spine commit failed", err)
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
	)
	for i := range parts {
		p := &parts[i]
		if p.Name == "file" && p.Filename != "" && filePart == nil {
			filePart = p
		} else if p.Name == "edits" && editsPart == nil {
			editsPart = p
		} else if p.Name == "revision" && revisionPart == nil {
			revisionPart = p
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

	var (
		prevRev      string
		prevOrigB64  string
		hasPrevious  bool
	)
	err = s.db.QueryRowContext(r.Context(), `
		SELECT revision, original_base64 FROM book_spines WHERE book_id = ? LIMIT 1
	`, bookID).Scan(&prevRev, &prevOrigB64)
	if err == nil {
		hasPrevious = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		s.writeErr(w, "POST /api/books/{id}/spine previous lookup failed", err)
		return
	}

	if prevRev != expected {
		httpapi.WriteError(w, http.StatusConflict, "Spine artwork changed. Reload before saving.")
		return
	}
	if filePart == nil && !hasPrevious {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose a spine image")
		return
	}

	var original []byte
	if filePart != nil {
		original = filePart.Data
	} else {
		original, err = base64.StdEncoding.DecodeString(prevOrigB64)
		if err != nil {
			s.writeErr(w, "POST /api/books/{id}/spine decode previous failed", err)
			return
		}
	}

	renderedWebP, contentType, err := RenderSpine(original, *edits)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Use a static JPEG, PNG, WebP or AVIF under 10 MB and 24 megapixels.")
		return
	}

	newRevision := uuid.NewString()
	editsJSON, err := json.Marshal(edits)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine marshal edits failed", err)
		return
	}
	origB64 := base64.StdEncoding.EncodeToString(original)
	imgB64 := base64.StdEncoding.EncodeToString(renderedWebP)

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine lock failed", err)
		return
	}
	if _, err := collections.AssertBookEditor(r.Context(), tx, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine tx auth failed", err)
		return
	}
	var currentRev string
	err = tx.QueryRowContext(r.Context(), `
		SELECT revision FROM book_spines WHERE book_id = ? LIMIT 1
	`, bookID).Scan(&currentRev)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		s.writeErr(w, "POST /api/books/{id}/spine current revision check failed", err)
		return
	}
	if currentRev != expected {
		httpapi.WriteError(w, http.StatusConflict, "Spine artwork changed. Reload before saving.")
		return
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO book_spines (book_id, original_base64, original_type, image_base64, edits, revision)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(book_id) DO UPDATE SET
			original_base64 = excluded.original_base64,
			original_type = excluded.original_type,
			image_base64 = excluded.image_base64,
			edits = excluded.edits,
			revision = excluded.revision
	`, bookID, origB64, contentType, imgB64, string(editsJSON), newRevision); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine upsert failed", err)
		return
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine commit failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "book spine saved",
		"bookId", bookID,
		"userId", swu.User.ID,
		"revision", newRevision,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success":  true,
		"revision": newRevision,
	})
}

// /api/settings/admin/chatgpt-image (GET, POST, DELETE, else 405)
func (s *Service) handleAdminChatGPTImage(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && rejectCrossSite(w, r) {
		return
	}
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("/api/settings/admin/chatgpt-image auth failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Sign in to Delb first.")
		return
	}
	if err := assertCollectionAdminDB(r.Context(), s.db, swu.User.ID); err != nil {
		s.writeErr(w, "/api/settings/admin/chatgpt-image admin check failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")

	switch r.Method {
	case http.MethodGet:
		status, err := s.codex.ConnectionStatus(r.Context())
		if err != nil {
			s.writeErr(w, "GET /api/settings/admin/chatgpt-image status failed", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, status)
		return

	case http.MethodDelete:
		if err := s.codex.Disconnect(r.Context()); err != nil {
			s.writeErr(w, "DELETE /api/settings/admin/chatgpt-image disconnect failed", err)
			return
		}
		s.logger.InfoContext(r.Context(), "admin disconnected ChatGPT image connection", "actorUserId", swu.User.ID)
		httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"connected": false})
		return

	case http.MethodPost:
		raw, err := httpapi.ReadBodyBounded(r, maxAdminChatGPTBodyBytes)
		if err != nil {
			httpapi.WriteHTTPError(w, err)
			return
		}
		var body map[string]json.RawMessage
		if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &body) != nil || body == nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request.")
			return
		}
		var action string
		if json.Unmarshal(body["action"], &action) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid request.")
			return
		}

		authorize := func() error {
			current, aerr := s.auth.Authenticate(nil, r)
			if aerr != nil {
				return aerr
			}
			if current == nil || current.Session.ID != swu.Session.ID {
				return errors.New("Session expired")
			}
			return assertCollectionAdminDB(r.Context(), s.db, swu.User.ID)
		}

		if action == "start" {
			res, err := s.codex.StartConnection(r.Context(), swu.User.ID, swu.Session.ID, authorize)
			if err != nil {
				s.writeErr(w, "POST /api/settings/admin/chatgpt-image start failed", err)
				return
			}
			s.logger.InfoContext(r.Context(), "admin started ChatGPT image sign-in flow", "actorUserId", swu.User.ID)
			httpapi.WriteJSON(w, http.StatusOK, res)
			return
		}
		if action == "poll" {
			var attemptID string
			if attRaw, ok := body["attemptId"]; ok && json.Unmarshal(attRaw, &attemptID) == nil {
				connected, err := s.codex.PollConnection(r.Context(), swu.User.ID, swu.Session.ID, attemptID, authorize)
				if err != nil {
					s.writeErr(w, "POST /api/settings/admin/chatgpt-image poll failed", err)
					return
				}
				if connected {
					s.logger.InfoContext(r.Context(), "admin connected ChatGPT image integration", "actorUserId", swu.User.ID)
				}
				httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"connected": connected})
				return
			}
		}
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid request.")
		return

	default:
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed.")
	}
}

// /api/books/{id}/spine-generate/connection (GET only; others return 405)
func (s *Service) handleSpineGenerateConnection(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return
	}
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("GET /api/books/{id}/spine-generate/connection auth failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book.")
		return
	}
	if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "GET /api/books/{id}/spine-generate/connection editor check failed", err)
		return
	}
	status, err := s.codex.ConnectionStatus(r.Context())
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/spine-generate/connection status failed", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"connected": status.Connected})
}

// GET /api/books/{id}/spine-generate/series-references
func (s *Service) handleSpineGenerateSeriesReferences(w http.ResponseWriter, r *http.Request) {
	swu := httpapi.SessionFromContext(r.Context())
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book.")
		return
	}
	if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "GET /api/books/{id}/spine-generate/series-references editor check failed", err)
		return
	}
	refs, err := FindSeriesSpines(r.Context(), s.db, swu.User.ID, bookID, nil)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/spine-generate/series-references query failed", err)
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	httpapi.WriteJSON(w, http.StatusOK, refs)
}

// POST /api/books/{id}/spine-generate
func (s *Service) handleSpineGenerate(w http.ResponseWriter, r *http.Request) {
	if rejectCrossSite(w, r) {
		return
	}
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.logger.Error("POST /api/books/{id}/spine-generate auth failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if swu == nil {
		httpapi.WriteError(w, http.StatusUnauthorized, "Sign in to Delb first.")
		return
	}
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book.")
		return
	}
	if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate editor check failed", err)
		return
	}

	parts, err := books.ReadBoundedMultipart(r, maxSpineGenBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var (
		prompt          string
		previous        []byte
		hasPrevious     bool
		seriesRefsRaw   = "[]"
	)
	for _, p := range parts {
		switch p.Name {
		case "prompt":
			if prompt == "" {
				prompt = strings.TrimSpace(string(p.Data))
			}
		case "previous":
			if !hasPrevious {
				previous = p.Data
				hasPrevious = true
			}
		case "seriesReferences":
			seriesRefsRaw = string(p.Data)
		}
	}

	var rawSeriesRefs any
	if err := json.Unmarshal([]byte(seriesRefsRaw), &rawSeriesRefs); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid series references.")
		return
	}
	selectedSeriesSpines, ok := ParseSelectedSeriesSpines(rawSeriesRefs)
	if !ok {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid series references.")
		return
	}
	if hasPrevious && len(selectedSeriesSpines) >= MaxSeriesSpineReferences {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose at most 14 series spines when updating a preview.")
		return
	}
	if len(utf16.Encode([]rune(prompt))) > maxPromptInstructionChars {
		httpapi.WriteError(w, http.StatusBadRequest, "Keep instructions under 2,000 characters.")
		return
	}

	coverAbs, err := books.ResolveBookCoverSourcePath(r.Context(), s.db, s.libraryDir, swu.User.ID, bookID)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate cover lookup failed", err)
		return
	}

	coverBytes, err := readBoundedFile(coverAbs, SpineMaxBytes)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "The cover or preview must be a static image under 10 MB and 24 megapixels.")
		return
	}
	coverSum := sha256.Sum256(coverBytes)
	coverHash := hex.EncodeToString(coverSum[:])

	normCover, err := NormalizeReferenceImage(coverBytes)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "The cover or preview must be a static image under 10 MB and 24 megapixels.")
		return
	}
	images := [][]byte{normCover}
	if hasPrevious {
		normPrev, perr := NormalizeReferenceImage(previous)
		if perr != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "The cover or preview must be a static image under 10 MB and 24 megapixels.")
			return
		}
		images = append(images, normPrev)
	}

	var bookTitle string
	err = s.db.QueryRowContext(r.Context(), `SELECT title FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&bookTitle)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found.")
		return
	}
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate book query failed", err)
		return
	}

	authorRows, err := s.db.QueryContext(r.Context(), `
		SELECT a.name
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id = ?
		ORDER BY ba.position
	`, bookID)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate authors query failed", err)
		return
	}
	authorNames := make([]string, 0)
	for authorRows.Next() {
		var name string
		if err := authorRows.Scan(&name); err != nil {
			_ = authorRows.Close()
			s.writeErr(w, "POST /api/books/{id}/spine-generate authors scan failed", err)
			return
		}
		authorNames = append(authorNames, name)
	}
	if err := authorRows.Close(); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate authors close failed", err)
		return
	}
	if err := authorRows.Err(); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate authors err", err)
		return
	}

	template, err := readSpineGenerationPromptTemplate(r.Context(), s.db)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate prompt read failed", err)
		return
	}

	seriesSpines, err := FindSeriesSpines(r.Context(), s.db, swu.User.ID, bookID, selectedSeriesSpines)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate series spines failed", err)
		return
	}
	for _, sp := range seriesSpines {
		decoded, derr := base64.StdEncoding.DecodeString(sp.ImageBase64)
		if derr != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "A selected series spine could not be used. Reload the references and try again.")
			return
		}
		normSpine, nerr := NormalizeReferenceImage(decoded)
		if nerr != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "A selected series spine could not be used. Reload the references and try again.")
			return
		}
		images = append(images, normSpine)
	}

	conn, err := s.codex.GetConnection(r.Context())
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate get connection failed", err)
		return
	}
	if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate pre-call editor check failed", err)
		return
	}
	currentConn, err := s.codex.IsCurrentConnection(r.Context(), conn.Generation)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate current connection check failed", err)
		return
	}
	if !currentConn {
		httpapi.WriteError(w, http.StatusConflict, "ChatGPT connection changed. Try again.")
		return
	}
	if _, err := FindSeriesSpines(r.Context(), s.db, swu.User.ID, bookID, selectedSeriesSpines); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate pre-call series check failed", err)
		return
	}

	instructions := BuildSpineGenerationPrompt(PromptBuildOptions{
		Template:             template,
		Title:                bookTitle,
		Authors:              authorNames,
		HasPrevious:          hasPrevious,
		SeriesReferenceCount: len(seriesSpines),
		Instructions:         prompt,
	})

	type imageEntry struct {
		ImageURL string `json:"image_url"`
	}
	reqImages := make([]imageEntry, len(images))
	for i, imgBytes := range images {
		reqImages[i] = imageEntry{
			ImageURL: "data:image/png;base64," + base64.StdEncoding.EncodeToString(imgBytes),
		}
	}
	payloadBytes, err := json.Marshal(map[string]any{
		"model":      "gpt-image-2",
		"prompt":     instructions,
		"n":          1,
		"quality":    "medium",
		"size":       "1024x1536",
		"background": "opaque",
		"images":     reqImages,
	})
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate marshal payload failed", err)
		return
	}

	failureMsg := "ChatGPT could not generate the spine. Your account may not support this experimental feature, or the service may be unavailable."
	callCtx, cancel := context.WithTimeout(r.Context(), 300*time.Second)
	defer cancel()

	providerReq, err := http.NewRequestWithContext(
		callCtx,
		http.MethodPost,
		s.codex.apiBaseURL+"/backend-api/codex/images/edits",
		bytes.NewReader(payloadBytes),
	)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}
	providerReq.Header.Set("Content-Type", "application/json")
	providerReq.Header.Set("Authorization", "Bearer "+conn.AccessToken)
	providerReq.Header.Set("User-Agent", "Delb/0.1")
	providerReq.Header.Set("originator", "delb")
	providerReq.Header.Set("x-codex-image-turn-id", uuid.NewString())
	for k, v := range accountHeadersFromJWT(conn.AccessToken) {
		providerReq.Header.Set(k, v)
	}

	genStart := time.Now()
	s.logger.InfoContext(r.Context(), "starting spine generation",
		"bookId", bookID,
		"userId", swu.User.ID,
		"hasPrevious", hasPrevious,
		"seriesReferences", len(seriesSpines),
	)

	providerResp, err := s.codex.client.Do(providerReq)
	if err != nil {
		s.logger.ErrorContext(r.Context(), "spine generation provider request failed",
			"bookId", bookID,
			"userId", swu.User.ID,
			"durationMs", time.Since(genStart).Milliseconds(),
			"error", err,
		)
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}
	respBody, readErr := io.ReadAll(io.LimitReader(providerResp.Body, maxProviderResponseBytes+1))
	_ = providerResp.Body.Close()

	if providerResp.StatusCode < 200 || providerResp.StatusCode >= 300 {
		s.logger.WarnContext(r.Context(), "spine generation provider returned non-2xx",
			"bookId", bookID,
			"userId", swu.User.ID,
			"providerStatus", providerResp.StatusCode,
			"durationMs", time.Since(genStart).Milliseconds(),
		)
		if providerResp.StatusCode == http.StatusUnauthorized || providerResp.StatusCode == http.StatusForbidden {
			failureMsg = "ChatGPT rejected this request. Ask an administrator to reconnect or check whether the account supports Codex image generation."
		} else if providerResp.StatusCode == http.StatusTooManyRequests {
			failureMsg = "ChatGPT reached a usage limit. Try again later."
		}
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}
	if readErr != nil || int64(len(respBody)) > maxProviderResponseBytes {
		s.logger.ErrorContext(r.Context(), "spine generation provider response unreadable or oversized",
			"bookId", bookID,
			"durationMs", time.Since(genStart).Milliseconds(),
			"error", readErr,
		)
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}

	var parsed struct {
		Data []struct {
			B64JSON *string `json:"b64_json"`
		} `json:"data"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil ||
		len(parsed.Data) == 0 ||
		parsed.Data[0].B64JSON == nil ||
		!strictBase64Re.MatchString(*parsed.Data[0].B64JSON) {
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}
	generatedBytes, err := base64.StdEncoding.DecodeString(*parsed.Data[0].B64JSON)
	if err != nil {
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}
	if _, _, err := RenderSpine(generatedBytes, DefaultSpineEdits()); err != nil {
		httpapi.WriteError(w, http.StatusBadGateway, failureMsg)
		return
	}

	// Post-generation re-verification: session, editor role, connection, series refs, cover hash.
	latest, err := s.auth.Authenticate(nil, r)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate post-auth failed", err)
		return
	}
	if latest == nil || latest.Session.ID != swu.Session.ID {
		httpapi.WriteError(w, http.StatusUnauthorized, "Your session expired.")
		return
	}
	if _, err := collections.AssertBookEditor(r.Context(), s.db, swu.User.ID, bookID); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate post-editor check failed", err)
		return
	}
	stillCurrent, err := s.codex.IsCurrentConnection(r.Context(), conn.Generation)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate post-connection check failed", err)
		return
	}
	if !stillCurrent {
		httpapi.WriteError(w, http.StatusConflict, "ChatGPT connection changed. The preview was discarded.")
		return
	}
	if _, err := FindSeriesSpines(r.Context(), s.db, swu.User.ID, bookID, selectedSeriesSpines); err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate post-series check failed", err)
		return
	}

	curCoverAbs, err := books.ResolveBookCoverSourcePath(r.Context(), s.db, s.libraryDir, swu.User.ID, bookID)
	if err != nil {
		s.writeErr(w, "POST /api/books/{id}/spine-generate post-cover lookup failed", err)
		return
	}
	curCoverBytes, err := readBoundedFile(curCoverAbs, SpineMaxBytes)
	if err != nil {
		httpapi.WriteError(w, http.StatusConflict, "The cover changed while generating. Generate again using the new cover.")
		return
	}
	curSum := sha256.Sum256(curCoverBytes)
	if hex.EncodeToString(curSum[:]) != coverHash {
		httpapi.WriteError(w, http.StatusConflict, "The cover changed while generating. Generate again using the new cover.")
		return
	}

	s.logger.InfoContext(r.Context(), "spine generation completed",
		"bookId", bookID,
		"userId", swu.User.ID,
		"bytes", len(generatedBytes),
		"durationMs", time.Since(genStart).Milliseconds(),
	)

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", SniffOutputMime(generatedBytes))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(generatedBytes)
}
