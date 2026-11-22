package bookshelf

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	maxShelfBooksBodyBytes int64 = 8 * 1024 * 1024
	maxShelfNameLen              = 120
)

type personalShelfRow struct {
	ID        string
	OwnerID   string
	Name      string
	Revision  int
	Geometry  string
	CreatedAt int64
}

type personalShelfVisibleRow struct {
	ID            string
	Title         string
	Pages         *int
	CollectionID  string
	SpineRevision *string
	AuthorNames   []string
	Dimensions    *BookDimensions
	Placement     sql.NullString
	Role          string
}

type personalShelfBookDTO struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Pages         *int     `json:"pages"`
	CollectionID  string   `json:"collectionId"`
	SpineRevision *string  `json:"spineRevision"`
	AuthorNames   []string `json:"authorNames"`
	CanResize     bool     `json:"canResize"`
}

type personalShelfSnapshot struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Revision    int                    `json:"revision"`
	Token       string                 `json:"token"`
	Arrangement *Bookshelf             `json:"arrangement"`
	Adjustments []string               `json:"adjustments"`
	CanEdit     bool                   `json:"canEdit"`
	Books       []personalShelfBookDTO `json:"books"`
}

func ownedPersonalShelf(ctx context.Context, q collections.Queryable, userID, shelfID string) (*personalShelfRow, error) {
	var row personalShelfRow
	err := q.QueryRowContext(ctx, `
		SELECT id, owner_id, name, revision, geometry, created_at
		FROM personal_shelves
		WHERE id = ? AND owner_id = ?
		LIMIT 1
	`, shelfID, userID).Scan(&row.ID, &row.OwnerID, &row.Name, &row.Revision, &row.Geometry, &row.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpapi.NewError(http.StatusNotFound, "Shelf not found")
	}
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func visiblePersonalShelfBooks(ctx context.Context, q collections.Queryable, userID, shelfID string) ([]personalShelfVisibleRow, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			b.id,
			b.title,
			b.pages,
			b.collection_id,
			(SELECT revision FROM book_spines INDEXED BY book_spines_book_revision_idx WHERE book_id = b.id),
			COALESCE(
				(SELECT json_group_array(name) FROM (
					SELECT a.name AS name
					FROM book_authors ba
					JOIN authors a ON a.id = ba.author_id
					WHERE ba.book_id = b.id
					ORDER BY COALESCE(ba.position, 10000), a.id
				)),
				'[]'
			),
			bsd.width,
			bsd.height,
			bsd.manual_width,
			bsd.manual_height,
			bsd.source_pages,
			psb.placement,
			cm.role
		FROM personal_shelf_books psb
		INNER JOIN books b ON b.id = psb.book_id
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		LEFT JOIN book_shelf_dimensions bsd ON bsd.book_id = b.id
		WHERE psb.shelf_id = ?
		ORDER BY psb.added_at ASC, psb.book_id ASC
		LIMIT ?
	`, userID, shelfID, BookshelfMaxBooks+1)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]personalShelfVisibleRow, 0)
	for rows.Next() {
		var (
			r           personalShelfVisibleRow
			pages       sql.NullInt64
			spineRev    sql.NullString
			authorJSON  string
			dimW        sql.NullInt64
			dimH        sql.NullInt64
			dimManualW  sql.NullInt64
			dimManualH  sql.NullInt64
			dimSrcPages sql.NullInt64
		)
		if err := rows.Scan(
			&r.ID, &r.Title, &pages, &r.CollectionID, &spineRev, &authorJSON,
			&dimW, &dimH, &dimManualW, &dimManualH, &dimSrcPages,
			&r.Placement, &r.Role,
		); err != nil {
			return nil, err
		}
		if pages.Valid {
			v := int(pages.Int64)
			r.Pages = &v
		}
		if spineRev.Valid {
			v := spineRev.String
			r.SpineRevision = &v
		}
		var names []string
		if err := json.Unmarshal([]byte(authorJSON), &names); err != nil || names == nil {
			names = []string{}
		}
		r.AuthorNames = names
		if dimW.Valid && dimH.Valid && dimManualW.Valid && dimManualH.Valid {
			d := &BookDimensions{
				Width:        int(dimW.Int64),
				Height:       int(dimH.Int64),
				ManualWidth:  dimManualW.Int64 != 0,
				ManualHeight: dimManualH.Int64 != 0,
			}
			if dimSrcPages.Valid {
				v := int(dimSrcPages.Int64)
				d.SourcePages = &v
			}
			r.Dimensions = d
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func resolvedShelfBookDimensions(row personalShelfVisibleRow) ShelfBook {
	if row.Dimensions != nil {
		return ShelfBook{
			ID:           row.ID,
			Width:        row.Dimensions.Width,
			Height:       row.Dimensions.Height,
			ManualWidth:  row.Dimensions.ManualWidth,
			ManualHeight: row.Dimensions.ManualHeight,
			SourcePages:  NormalizedPages(row.Dimensions.SourcePages),
		}
	}
	pages := NormalizedPages(row.Pages)
	return ShelfBook{
		ID:           row.ID,
		Width:        EstimatedWidth(pages),
		Height:       StableHeight(row.ID),
		ManualWidth:  false,
		ManualHeight: false,
		SourcePages:  pages,
	}
}

func (s *Service) personalShelfToken(shelfID string, rows []personalShelfVisibleRow) string {
	entries := make([][]any, len(rows))
	for i, r := range rows {
		entries[i] = []any{r.ID, r.CollectionID, r.Role, r.Pages, r.Dimensions}
	}
	payload, _ := json.Marshal([]any{shelfID, entries})
	mac := hmac.New(sha256.New, []byte(s.tokenSecret))
	_, _ = mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Service) personalShelfSnapshot(ctx context.Context, q collections.Queryable, userID, shelfID string) (*personalShelfSnapshot, error) {
	shelf, err := ownedPersonalShelf(ctx, q, userID, shelfID)
	if err != nil {
		return nil, err
	}
	rows, err := visiblePersonalShelfBooks(ctx, q, userID, shelfID)
	if err != nil {
		return nil, err
	}
	if len(rows) > BookshelfMaxBooks {
		return nil, httpapi.NewError(http.StatusBadRequest, "This Shelf has too many books.")
	}

	members := make([]BookLayoutEntry, len(rows))
	for i, r := range rows {
		var pl *BookPlacementAnchor
		if r.Placement.Valid {
			pl = ParsePlacement([]byte(r.Placement.String))
		}
		members[i] = BookLayoutEntry{
			Book:      resolvedShelfBookDimensions(r),
			Placement: pl,
		}
	}

	arrangement, adjustments, err := ComposeBookshelfLayout([]byte(shelf.Geometry), members, shelf.ID)
	if err != nil {
		return nil, err
	}

	booksDTO := make([]personalShelfBookDTO, len(rows))
	for i, r := range rows {
		booksDTO[i] = personalShelfBookDTO{
			ID:            r.ID,
			Title:         r.Title,
			Pages:         r.Pages,
			CollectionID:  r.CollectionID,
			SpineRevision: r.SpineRevision,
			AuthorNames:   r.AuthorNames,
			CanResize:     r.Role == "owner" || r.Role == "editor",
		}
	}

	return &personalShelfSnapshot{
		ID:          shelf.ID,
		Name:        shelf.Name,
		Revision:    shelf.Revision,
		Token:       s.personalShelfToken(shelfID, rows),
		Arrangement: arrangement,
		Adjustments: adjustments,
		CanEdit:     true,
		Books:       booksDTO,
	}, nil
}

func persistVisiblePlacements(ctx context.Context, q collections.Queryable, shelfID string, layout *Bookshelf, rows []personalShelfVisibleRow) error {
	previous := make(map[string]*BookPlacementAnchor, len(rows))
	visibleIDs := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		visibleIDs[r.ID] = struct{}{}
		if r.Placement.Valid {
			previous[r.ID] = ParsePlacement([]byte(r.Placement.String))
		}
	}

	type placementWrite struct {
		bookID    string
		placement string
	}
	var writes []placementWrite
	dormantFalse := false

	for _, bc := range layout.Bookcases {
		for _, sh := range bc.Shelves {
			for _, it := range sh.Items {
				anchors := make([]*BookPlacementAnchor, len(it.Books))
				for i, bk := range it.Books {
					anchors[i] = previous[bk.ID]
				}
				first := anchors[0]
				preserveStack := first != nil
				if preserveStack {
					for idx, p := range anchors {
						ox := 0
						if it.Books[idx].OffsetX != nil {
							ox = *it.Books[idx].OffsetX
						}
						if p == nil ||
							p.StackID != first.StackID ||
							p.CaseID != bc.ID ||
							p.ShelfID != sh.ID ||
							placementBookX(p) != it.X+ox ||
							p.Horizontal != it.Horizontal ||
							(idx > 0 && p.Order <= anchors[idx-1].Order) {
							preserveStack = false
							break
						}
					}
				}
				stackID := uuid.NewString()
				if preserveStack {
					stackID = first.StackID
				}
				for order, bk := range it.Books {
					ox := 0
					if bk.OffsetX != nil {
						ox = *bk.OffsetX
					}
					bx := it.X + ox
					ord := order
					if preserveStack {
						ord = anchors[order].Order
					}
					w := bk.Width
					h := bk.Height
					anchor := BookPlacementAnchor{
						CaseID:     bc.ID,
						ShelfID:    sh.ID,
						StackID:    stackID,
						X:          it.X,
						BookX:      &bx,
						Horizontal: it.Horizontal,
						Order:      ord,
						Width:      &w,
						Height:     &h,
						Dormant:    &dormantFalse,
					}
					encoded, err := json.Marshal(anchor)
					if err != nil {
						return err
					}
					writes = append(writes, placementWrite{
						bookID:    bk.ID,
						placement: string(encoded),
					})
				}
			}
		}
	}

	nowMs := time.Now().UTC().UnixMilli()
	for i := 0; i < len(writes); i += 100 {
		end := i + 100
		if end > len(writes) {
			end = len(writes)
		}
		batch := writes[i:end]
		values := make([]string, len(batch))
		args := make([]any, 0, len(batch)*4)
		for j, w := range batch {
			values[j] = "(?, ?, ?, ?)"
			args = append(args, shelfID, w.bookID, w.placement, nowMs)
		}
		if _, err := q.ExecContext(ctx, `
			INSERT INTO personal_shelf_books (shelf_id, book_id, placement, added_at)
			VALUES `+strings.Join(values, ",")+`
			ON CONFLICT(shelf_id, book_id) DO UPDATE SET placement = excluded.placement
		`, args...); err != nil {
			return err
		}
	}

	// Mark hidden (non-visible) members of this shelf as dormant so returning books
	// do not displace unchanged books.
	allRows, err := q.QueryContext(ctx, `
		SELECT book_id, placement FROM personal_shelf_books WHERE shelf_id = ?
	`, shelfID)
	if err != nil {
		return err
	}
	type dormantUpdate struct {
		bookID    string
		placement string
	}
	var dormantUpdates []dormantUpdate
	dormantTrue := true
	for allRows.Next() {
		var (
			bookID string
			plRaw  sql.NullString
		)
		if err := allRows.Scan(&bookID, &plRaw); err != nil {
			_ = allRows.Close()
			return err
		}
		if _, isVis := visibleIDs[bookID]; isVis {
			continue
		}
		if !plRaw.Valid {
			continue
		}
		pl := ParsePlacement([]byte(plRaw.String))
		if pl != nil && (pl.Dormant == nil || !*pl.Dormant) {
			pl.Dormant = &dormantTrue
			enc, err := json.Marshal(pl)
			if err != nil {
				_ = allRows.Close()
				return err
			}
			dormantUpdates = append(dormantUpdates, dormantUpdate{bookID: bookID, placement: string(enc)})
		}
	}
	if err := allRows.Close(); err != nil {
		return err
	}
	if err := allRows.Err(); err != nil {
		return err
	}

	for _, upd := range dormantUpdates {
		if _, err := q.ExecContext(ctx, `
			UPDATE personal_shelf_books SET placement = ? WHERE shelf_id = ? AND book_id = ?
		`, upd.placement, shelfID, upd.bookID); err != nil {
			return err
		}
	}
	return nil
}

func validateShelfName(raw string) (string, error) {
	clean := strings.TrimSpace(raw)
	if clean == "" || len(utf16.Encode([]rune(clean))) > maxShelfNameLen {
		return "", httpapi.NewError(http.StatusBadRequest, "Enter a Shelf name of up to 120 characters.")
	}
	return clean, nil
}

// ShelfPreviewDTO is a compact preview entry for a personal shelf listing.
type ShelfPreviewDTO struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// ShelfSummaryDTO mirrors server/utils/shelves/model.ts listShelves items.
type ShelfSummaryDTO struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Count    int               `json:"count"`
	Previews []ShelfPreviewDTO `json:"previews"`
}

// ListShelves returns all personal shelves owned by userID with visible counts and previews.
func (s *Service) ListShelves(ctx context.Context, userID string) ([]ShelfSummaryDTO, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.QueryContext(ctx, `
		SELECT id, name FROM personal_shelves WHERE owner_id = ? ORDER BY created_at ASC, id ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	type shelfBasic struct {
		id   string
		name string
	}
	var basics []shelfBasic
	for rows.Next() {
		var b shelfBasic
		if err := rows.Scan(&b.id, &b.name); err != nil {
			_ = rows.Close()
			return nil, err
		}
		basics = append(basics, b)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	out := make([]ShelfSummaryDTO, 0, len(basics))
	for _, b := range basics {
		vis, err := visiblePersonalShelfBooks(ctx, tx, userID, b.id)
		if err != nil {
			return nil, err
		}
		limit := len(vis)
		if limit > 4 {
			limit = 4
		}
		previews := make([]ShelfPreviewDTO, limit)
		for i := 0; i < limit; i++ {
			previews[i] = ShelfPreviewDTO{ID: vis[i].ID, Title: vis[i].Title}
		}
		out = append(out, ShelfSummaryDTO{
			ID:       b.id,
			Name:     b.name,
			Count:    len(vis),
			Previews: previews,
		})
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}

// GET /api/shelves
func (s *Service) handleListShelves(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	out, err := s.ListShelves(r.Context(), userID)
	if err != nil {
		s.writeErr(w, "GET /api/shelves failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"shelves": out,
		},
	})
}

// POST /api/shelves
func (s *Service) handleCreateShelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	var body struct {
		Name json.RawMessage `json:"name"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var nameRaw string
	if len(body.Name) == 0 || string(body.Name) == "null" || json.Unmarshal(body.Name, &nameRaw) != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Shelf name required")
		return
	}
	clean, err := validateShelfName(nameRaw)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	id := uuid.NewString()
	geomBytes, err := json.Marshal(BookshelfGeometry(EmptyBookshelf()))
	if err != nil {
		s.writeErr(w, "POST /api/shelves marshal geometry failed", err)
		return
	}
	nowMs := time.Now().UTC().UnixMilli()
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO personal_shelves (id, owner_id, name, revision, geometry, created_at)
		VALUES (?, ?, ?, 0, ?, ?)
	`, id, userID, clean, string(geomBytes), nowMs); err != nil {
		s.writeErr(w, "POST /api/shelves insert failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"id":   id,
			"name": clean,
		},
	})
}

// GET /api/shelves/{id}
func (s *Service) handleGetShelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	shelfID := r.PathValue("id")
	if shelfID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Shelf required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "GET /api/shelves/{id} begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	snap, err := s.personalShelfSnapshot(r.Context(), tx, userID, shelfID)
	if err != nil {
		s.writeErr(w, "GET /api/shelves/{id} snapshot failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "GET /api/shelves/{id} commit failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, snap)
}

// PATCH /api/shelves/{id}
func (s *Service) handlePatchShelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	shelfID := r.PathValue("id")

	var body struct {
		Name json.RawMessage `json:"name"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var nameRaw string
	if shelfID == "" || len(body.Name) == 0 || string(body.Name) == "null" || json.Unmarshal(body.Name, &nameRaw) != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Shelf name required")
		return
	}
	clean, err := validateShelfName(nameRaw)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PATCH /api/shelves/{id} begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "PATCH /api/shelves/{id} lock failed", err)
		return
	}
	shelf, err := ownedPersonalShelf(r.Context(), tx, userID, shelfID)
	if err != nil {
		s.writeErr(w, "PATCH /api/shelves/{id} auth failed", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE personal_shelves SET name = ?, revision = ? WHERE id = ?
	`, clean, shelf.Revision+1, shelfID); err != nil {
		s.writeErr(w, "PATCH /api/shelves/{id} update failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PATCH /api/shelves/{id} commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})
}

// DELETE /api/shelves/{id}
func (s *Service) handleDeleteShelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	shelfID := r.PathValue("id")
	if shelfID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Shelf required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "DELETE /api/shelves/{id} begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "DELETE /api/shelves/{id} lock failed", err)
		return
	}
	if _, err := ownedPersonalShelf(r.Context(), tx, userID, shelfID); err != nil {
		s.writeErr(w, "DELETE /api/shelves/{id} auth failed", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM personal_shelf_books WHERE shelf_id = ?`, shelfID); err != nil {
		s.writeErr(w, "DELETE /api/shelves/{id} delete books failed", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `DELETE FROM personal_shelves WHERE id = ?`, shelfID); err != nil {
		s.writeErr(w, "DELETE /api/shelves/{id} delete shelf failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "DELETE /api/shelves/{id} commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})
}

// PUT /api/shelves/{id}
func (s *Service) handlePutShelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	shelfID := r.PathValue("id")

	raw, err := httpapi.ReadBodyBounded(r, maxBookshelfBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if shelfID == "" || len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid Shelf arrangement")
		return
	}

	revRaw, hasRev := fields["revision"]
	tokenRaw, hasToken := fields["token"]
	arrRaw, hasArr := fields["arrangement"]
	rev, revOK := parseSafeNonNegInt(revRaw)
	var token string
	tokenOK := hasToken && json.Unmarshal(tokenRaw, &token) == nil
	if !hasRev || !revOK || !tokenOK || !hasArr {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid Shelf arrangement")
		return
	}

	layout := ParseBookshelfJSON(arrRaw)
	if layout == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid Shelf arrangement.")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} lock failed", err)
		return
	}
	shelf, err := ownedPersonalShelf(r.Context(), tx, userID, shelfID)
	if err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} auth failed", err)
		return
	}
	rows, err := visiblePersonalShelfBooks(r.Context(), tx, userID, shelfID)
	if err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} visible failed", err)
		return
	}
	if rev != shelf.Revision || token != s.personalShelfToken(shelfID, rows) {
		httpapi.WriteError(w, http.StatusConflict, "This Shelf or its books changed. Reload to continue.")
		return
	}

	if RawHasVersion2([]byte(shelf.Geometry)) && !RawHasVersion2(arrRaw) {
		httpapi.WriteError(w, http.StatusConflict, "This Shelf needs a newer version of Delb. Reload before saving.")
		return
	}

	if err := validatePictureAssets(r.Context(), tx, PictureScope{Kind: "personal", ID: shelfID}, layout); err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} pictures failed", err)
		return
	}

	var placed []ShelfBook
	for _, bc := range layout.Bookcases {
		for _, sh := range bc.Shelves {
			for _, it := range sh.Items {
				placed = append(placed, it.Books...)
			}
		}
	}

	rowMap := make(map[string]personalShelfVisibleRow, len(rows))
	for _, row := range rows {
		rowMap[row.ID] = row
	}
	if len(placed) != len(rows) {
		httpapi.WriteError(w, http.StatusConflict, "This Shelf or its books changed. Reload to continue.")
		return
	}
	for _, bk := range placed {
		if _, ok := rowMap[bk.ID]; !ok {
			httpapi.WriteError(w, http.StatusConflict, "This Shelf or its books changed. Reload to continue.")
			return
		}
	}

	var updates []ShelfBook
	for _, bk := range placed {
		row := rowMap[bk.ID]
		old := resolvedShelfBookDimensions(row)
		if bk.Width != old.Width ||
			bk.Height != old.Height ||
			bk.ManualWidth != old.ManualWidth ||
			bk.ManualHeight != old.ManualHeight ||
			!equalIntPtr(bk.SourcePages, old.SourcePages) {
			if row.Role != "owner" && row.Role != "editor" {
				httpapi.WriteError(w, http.StatusForbidden, "You cannot resize this book.")
				return
			}
			if !equalIntPtr(bk.SourcePages, old.SourcePages) {
				httpapi.WriteError(w, http.StatusConflict, "This Shelf or its books changed. Reload to continue.")
				return
			}
			updates = append(updates, bk)
		}
	}

	if err := upsertBookShelfDimensions(r.Context(), tx, updates); err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} dimensions failed", err)
		return
	}
	if err := persistVisiblePlacements(r.Context(), tx, shelfID, layout, rows); err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} placements failed", err)
		return
	}

	geomBytes, err := json.Marshal(BookshelfGeometry(layout))
	if err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} marshal geometry failed", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE personal_shelves SET geometry = ?, revision = ? WHERE id = ?
	`, string(geomBytes), shelf.Revision+1, shelfID); err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} update shelf failed", err)
		return
	}

	updated, err := s.personalShelfSnapshot(r.Context(), tx, userID, shelfID)
	if err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} reload snapshot failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/shelves/{id} commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"revision": updated.Revision,
		"token":    updated.Token,
	})
}

// ChangeShelfBooks mirrors server/utils/shelves/model.ts changeShelfBooks.
func (s *Service) ChangeShelfBooks(
	ctx context.Context,
	userID, shelfID string,
	bookIDs []string,
	action string,
	authorize func(tx *sql.Tx) error,
) (*personalShelfSnapshot, error) {
	if action != "add" && action != "remove" {
		return nil, httpapi.NewError(http.StatusBadRequest, "Choose valid books.")
	}
	seen := make(map[string]struct{}, len(bookIDs))
	unique := make([]string, 0, len(bookIDs))
	for _, id := range bookIDs {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		unique = append(unique, id)
	}
	if len(unique) == 0 || len(unique) > BookshelfMaxBooks {
		return nil, httpapi.NewError(http.StatusBadRequest, "Choose valid books.")
	}
	for _, id := range unique {
		if id == "" || len(id) > 128 {
			return nil, httpapi.NewError(http.StatusBadRequest, "Choose valid books.")
		}
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(ctx, tx); err != nil {
		return nil, err
	}
	if authorize != nil {
		if err := authorize(tx); err != nil {
			return nil, err
		}
	}
	shelf, err := ownedPersonalShelf(ctx, tx, userID, shelfID)
	if err != nil {
		return nil, err
	}

	authorized := make(map[string]struct{}, len(unique))
	for i := 0; i < len(unique); i += 400 {
		end := i + 400
		if end > len(unique) {
			end = len(unique)
		}
		chunk := unique[i:end]
		args := make([]any, 0, len(chunk)+1)
		args = append(args, userID)
		for _, id := range chunk {
			args = append(args, id)
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT b.id
			FROM books b
			INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
			WHERE b.id IN (`+makePlaceholders(len(chunk))+`)
		`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var bid string
			if err := rows.Scan(&bid); err != nil {
				_ = rows.Close()
				return nil, err
			}
			authorized[bid] = struct{}{}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	if len(authorized) != len(unique) {
		return nil, httpapi.NewError(http.StatusNotFound, "One or more books are unavailable.")
	}

	if action == "add" {
		var existingCount int
		if err := tx.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM personal_shelf_books WHERE shelf_id = ?
		`, shelfID).Scan(&existingCount); err != nil {
			return nil, err
		}
		prevRows, err := tx.QueryContext(ctx, `
			SELECT book_id FROM personal_shelf_books WHERE shelf_id = ?
		`, shelfID)
		if err != nil {
			return nil, err
		}
		prevSet := make(map[string]struct{})
		for prevRows.Next() {
			var bid string
			if err := prevRows.Scan(&bid); err != nil {
				_ = prevRows.Close()
				return nil, err
			}
			prevSet[bid] = struct{}{}
		}
		if err := prevRows.Close(); err != nil {
			return nil, err
		}
		if err := prevRows.Err(); err != nil {
			return nil, err
		}

		additions := make([]string, 0, len(unique))
		for _, id := range unique {
			if _, exists := prevSet[id]; !exists {
				additions = append(additions, id)
			}
		}
		if existingCount+len(additions) > BookshelfMaxBooks {
			return nil, httpapi.NewError(http.StatusBadRequest, "This Shelf has too many books.")
		}
		nowMs := time.Now().UTC().UnixMilli()
		for i := 0; i < len(additions); i += 100 {
			end := i + 100
			if end > len(additions) {
				end = len(additions)
			}
			batch := additions[i:end]
			values := make([]string, len(batch))
			args := make([]any, 0, len(batch)*3)
			for j, bid := range batch {
				values[j] = "(?, ?, NULL, ?)"
				args = append(args, shelfID, bid, nowMs)
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO personal_shelf_books (shelf_id, book_id, placement, added_at)
				VALUES `+strings.Join(values, ",")+`
				ON CONFLICT DO NOTHING
			`, args...); err != nil {
				return nil, err
			}
		}
	} else {
		for i := 0; i < len(unique); i += 400 {
			end := i + 400
			if end > len(unique) {
				end = len(unique)
			}
			chunk := unique[i:end]
			args := make([]any, 0, len(chunk)+1)
			args = append(args, shelfID)
			for _, id := range chunk {
				args = append(args, id)
			}
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM personal_shelf_books
				WHERE shelf_id = ? AND book_id IN (`+makePlaceholders(len(chunk))+`)
			`, args...); err != nil {
				return nil, err
			}
		}
	}

	composed, err := s.personalShelfSnapshot(ctx, tx, userID, shelfID)
	if err != nil {
		return nil, err
	}
	visRows, err := visiblePersonalShelfBooks(ctx, tx, userID, shelfID)
	if err != nil {
		return nil, err
	}
	if err := persistVisiblePlacements(ctx, tx, shelfID, composed.Arrangement, visRows); err != nil {
		return nil, err
	}

	geomBytes, err := json.Marshal(BookshelfGeometry(composed.Arrangement))
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE personal_shelves SET geometry = ?, revision = ? WHERE id = ?
	`, string(geomBytes), shelf.Revision+1, shelfID); err != nil {
		return nil, err
	}

	finalSnap, err := s.personalShelfSnapshot(ctx, tx, userID, shelfID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return finalSnap, nil
}

// POST /api/shelves/{id}/books
func (s *Service) handlePostShelfBooks(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	shelfID := r.PathValue("id")

	raw, err := httpapi.ReadBodyBounded(r, maxShelfBooksBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if shelfID == "" || len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose valid books")
		return
	}

	var (
		rawBookIDs []any
		action     string
	)
	if json.Unmarshal(fields["bookIds"], &rawBookIDs) != nil ||
		json.Unmarshal(fields["action"], &action) != nil ||
		(action != "add" && action != "remove") {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose valid books")
		return
	}

	bookIDs := make([]string, 0, len(rawBookIDs))
	for _, elem := range rawBookIDs {
		id, ok := elem.(string)
		if !ok {
			httpapi.WriteError(w, http.StatusBadRequest, "Choose valid books")
			return
		}
		bookIDs = append(bookIDs, id)
	}

	finalSnap, err := s.ChangeShelfBooks(r.Context(), userID, shelfID, bookIDs, action, nil)
	if err != nil {
		s.writeErr(w, "POST /api/shelves/{id}/books failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, finalSnap)
}

// GET /api/books/{id}/shelves
func (s *Service) handleGetBookShelves(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book.")
		return
	}

	var found string
	err := s.db.QueryRowContext(r.Context(), `
		SELECT b.id
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/shelves book lookup failed", err)
		return
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT ps.id, ps.name, psb.book_id
		FROM personal_shelves ps
		LEFT JOIN personal_shelf_books psb ON psb.shelf_id = ps.id AND psb.book_id = ?
		WHERE ps.owner_id = ?
		ORDER BY ps.created_at ASC, ps.id ASC
	`, bookID, userID)
	if err != nil {
		s.writeErr(w, "GET /api/books/{id}/shelves query failed", err)
		return
	}
	defer func() { _ = rows.Close() }()

	type membershipDTO struct {
		ID           string `json:"id"`
		Name         string `json:"name"`
		ContainsBook bool   `json:"containsBook"`
	}
	out := make([]membershipDTO, 0)
	for rows.Next() {
		var (
			id     string
			name   string
			member sql.NullString
		)
		if err := rows.Scan(&id, &name, &member); err != nil {
			s.writeErr(w, "GET /api/books/{id}/shelves scan failed", err)
			return
		}
		out = append(out, membershipDTO{
			ID:           id,
			Name:         name,
			ContainsBook: member.Valid,
		})
	}
	if err := rows.Err(); err != nil {
		s.writeErr(w, "GET /api/books/{id}/shelves rows err", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Cookie")
	httpapi.WriteJSON(w, http.StatusOK, out)
}

func makePlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}
