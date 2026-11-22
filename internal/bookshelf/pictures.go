package bookshelf

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	maxPictureBytes        = 10 * 1024 * 1024
	maxPictureBodyBytes    = 11 * 1024 * 1024
	maxPicturePixels       = 24_000_000
	maxPictureDimension    = 2400
	maxShelfPictureAssets  = 100
	maxShelfPictureBytes   = 100 * 1024 * 1024
	unusedPictureTTLMillis = 7 * 24 * 60 * 60 * 1000
)

type PictureScope struct {
	Kind string // "collection" | "personal"
	ID   string
}

func (sc PictureScope) whereColumn() string {
	if sc.Kind == "collection" {
		return "collection_id"
	}
	return "personal_shelf_id"
}

func pictureAccess(ctx context.Context, q collections.Queryable, userID string, scope PictureScope, edit bool) error {
	if scope.Kind == "personal" {
		var id string
		err := q.QueryRowContext(ctx, `
			SELECT id FROM personal_shelves WHERE id = ? AND owner_id = ? LIMIT 1
		`, scope.ID, userID).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return httpapi.NewError(http.StatusNotFound, "Shelf not found")
		}
		return err
	}

	var role string
	err := q.QueryRowContext(ctx, `
		SELECT role FROM collection_members WHERE collection_id = ? AND user_id = ? LIMIT 1
	`, scope.ID, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return httpapi.NewError(http.StatusNotFound, "Collection not found")
	}
	if err != nil {
		return err
	}
	if edit && role != "owner" && role != "editor" {
		return httpapi.NewError(http.StatusForbidden, "Owner or editor access required")
	}
	return nil
}

func validatePictureAssets(ctx context.Context, q collections.Queryable, scope PictureScope, layout *Bookshelf) error {
	col := scope.whereColumn()

	used := make(map[string]struct{}, len(layout.Pictures))
	for _, pic := range layout.Pictures {
		used[pic.AssetID] = struct{}{}
	}

	type assetRow struct {
		id          string
		unusedSince sql.NullInt64
	}
	rows, err := q.QueryContext(ctx, `
		SELECT id, unused_since FROM shelf_picture_assets WHERE `+col+` = ?
	`, scope.ID)
	if err != nil {
		return err
	}
	var assets []assetRow
	assetSet := make(map[string]struct{})
	for rows.Next() {
		var a assetRow
		if err := rows.Scan(&a.id, &a.unusedSince); err != nil {
			_ = rows.Close()
			return err
		}
		assets = append(assets, a)
		assetSet[a.id] = struct{}{}
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if err := rows.Err(); err != nil {
		return err
	}

	for id := range used {
		if _, ok := assetSet[id]; !ok {
			return httpapi.NewError(http.StatusBadRequest, "A picture is missing or belongs to another shelf.")
		}
	}

	nowMs := time.Now().UTC().UnixMilli()
	for _, asset := range assets {
		_, isUsed := used[asset.id]
		if isUsed {
			if asset.unusedSince.Valid {
				if _, err := q.ExecContext(ctx, `
					UPDATE shelf_picture_assets SET unused_since = NULL WHERE `+col+` = ? AND id = ?
				`, scope.ID, asset.id); err != nil {
					return err
				}
			}
		} else {
			if !asset.unusedSince.Valid {
				if _, err := q.ExecContext(ctx, `
					UPDATE shelf_picture_assets SET unused_since = ? WHERE `+col+` = ? AND id = ?
				`, nowMs, scope.ID, asset.id); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

type uploadedPictureResult struct {
	ID     string `json:"id"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
}

func processPictureImage(raw []byte) (webpBytes []byte, width, height int, err error) {
	if len(raw) == 0 || len(raw) > maxPictureBytes {
		return nil, 0, 0, httpapi.NewError(http.StatusBadRequest, "Choose an image under 10 MB.")
	}
	invalidErr := httpapi.NewError(http.StatusBadRequest, "Use a static JPEG, PNG, WebP or AVIF under 10 MB and 24 megapixels.")

	meta, serr := books.SniffImageMeta(raw)
	if serr != nil {
		return nil, 0, 0, invalidErr
	}
	if meta.Format != "jpeg" && meta.Format != "png" && meta.Format != "webp" {
		return nil, 0, 0, invalidErr
	}
	if meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width)*int64(meta.Height) > maxPicturePixels {
		return nil, 0, 0, invalidErr
	}
	if books.IsAnimatedImage(raw, meta.Format) {
		return nil, 0, 0, invalidErr
	}

	img, _, derr := books.DecodeImageAndOrient(raw)
	if derr != nil {
		return nil, 0, 0, invalidErr
	}
	resized := books.ResizeInsideNoEnlarge(img, maxPictureDimension, maxPictureDimension)
	out, eerr := books.EncodeWebP(resized)
	if eerr != nil || len(out) > maxPictureBytes {
		return nil, 0, 0, invalidErr
	}
	bounds := resized.Bounds()
	return out, bounds.Dx(), bounds.Dy(), nil
}

func (s *Service) uploadPicture(ctx context.Context, userID string, scope PictureScope, raw []byte) (*uploadedPictureResult, error) {
	webpBytes, width, height, err := processPictureImage(raw)
	if err != nil {
		return nil, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(ctx, tx); err != nil {
		return nil, err
	}
	if err := pictureAccess(ctx, tx, userID, scope, true); err != nil {
		return nil, err
	}

	col := scope.whereColumn()
	nowMs := time.Now().UTC().UnixMilli()
	cutoff := nowMs - unusedPictureTTLMillis
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM shelf_picture_assets
		WHERE `+col+` = ? AND unused_since IS NOT NULL AND unused_since < ?
	`, scope.ID, cutoff); err != nil {
		return nil, err
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT bytes FROM shelf_picture_assets WHERE `+col+` = ?
	`, scope.ID)
	if err != nil {
		return nil, err
	}
	count := 0
	var totalBytes int64
	for rows.Next() {
		var b int64
		if err := rows.Scan(&b); err != nil {
			_ = rows.Close()
			return nil, err
		}
		count++
		totalBytes += b
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if count >= maxShelfPictureAssets || totalBytes+int64(len(webpBytes)) > maxShelfPictureBytes {
		return nil, httpapi.NewError(http.StatusBadRequest, "This shelf has reached its picture storage limit.")
	}

	id := uuid.NewString()
	var colID, personalID any
	if scope.Kind == "collection" {
		colID = scope.ID
	} else {
		personalID = scope.ID
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO shelf_picture_assets (id, collection_id, personal_shelf_id, image_base64, bytes, created_at, unused_since)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, id, colID, personalID, base64.StdEncoding.EncodeToString(webpBytes), len(webpBytes), nowMs, nowMs); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &uploadedPictureResult{ID: id, Width: width, Height: height}, nil
}

func (s *Service) readPicture(ctx context.Context, userID string, scope PictureScope, assetID string) ([]byte, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := pictureAccess(ctx, tx, userID, scope, false); err != nil {
		return nil, err
	}

	col := scope.whereColumn()
	var b64 string
	err = tx.QueryRowContext(ctx, `
		SELECT image_base64 FROM shelf_picture_assets WHERE `+col+` = ? AND id = ? LIMIT 1
	`, scope.ID, assetID).Scan(&b64)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpapi.NewError(http.StatusNotFound, "Picture not found")
	}
	if err != nil {
		return nil, err
	}

	if scope.Kind == "collection" {
		var role string
		err := tx.QueryRowContext(ctx, `
			SELECT role FROM collection_members WHERE collection_id = ? AND user_id = ? LIMIT 1
		`, scope.ID, userID).Scan(&role)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if role == "viewer" {
			var rawArr string
			err := tx.QueryRowContext(ctx, `
				SELECT arrangement FROM collection_bookshelves WHERE collection_id = ? LIMIT 1
			`, scope.ID).Scan(&rawArr)
			if errors.Is(err, sql.ErrNoRows) {
				return nil, httpapi.NewError(http.StatusNotFound, "Picture not found")
			}
			if err != nil {
				return nil, err
			}
			layout := ParseBookshelfJSON([]byte(rawArr))
			referenced := false
			if layout != nil {
				for _, pic := range layout.Pictures {
					if pic.AssetID == assetID {
						referenced = true
						break
					}
				}
			}
			if !referenced {
				return nil, httpapi.NewError(http.StatusNotFound, "Picture not found")
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(b64)
}

// /api/bookshelf-pictures/{scope}/{id}
func (s *Service) handleBookshelfPictures(w http.ResponseWriter, r *http.Request) {
	swu := httpapi.SessionFromContext(r.Context())
	kind := r.PathValue("scope")
	id := r.PathValue("id")
	if (kind != "collection" && kind != "personal") || id == "" {
		httpapi.WriteError(w, http.StatusNotFound, "Shelf not found")
		return
	}
	scope := PictureScope{Kind: kind, ID: id}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Vary", "Cookie")

	switch r.Method {
	case http.MethodGet:
		if !r.URL.Query().Has("asset") {
			httpapi.WriteError(w, http.StatusBadRequest, "Picture required")
			return
		}
		assetID := r.URL.Query().Get("asset")
		imgBytes, err := s.readPicture(r.Context(), swu.User.ID, scope, assetID)
		if err != nil {
			s.writeErr(w, "GET /api/bookshelf-pictures failed", err)
			return
		}
		w.Header().Set("Content-Type", "image/webp")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(imgBytes)
		return

	case http.MethodPost:
		if err := pictureAccess(r.Context(), s.db, swu.User.ID, scope, true); err != nil {
			s.writeErr(w, "POST /api/bookshelf-pictures access failed", err)
			return
		}
		parts, err := books.ReadBoundedMultipart(r, maxPictureBodyBytes)
		if err != nil {
			httpapi.WriteHTTPError(w, err)
			return
		}
		var fileData []byte
		foundFile := false
		for _, p := range parts {
			if p.Name == "file" && p.Filename != "" {
				fileData = p.Data
				foundFile = true
				break
			}
		}
		if !foundFile {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose a picture")
			return
		}
		res, err := s.uploadPicture(r.Context(), swu.User.ID, scope, fileData)
		if err != nil {
			s.writeErr(w, "POST /api/bookshelf-pictures upload failed", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, res)
		return

	default:
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed")
	}
}
