package bookshelf

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type collectionCatalogRow struct {
	ID            string
	Title         string
	Pages         *int
	CollectionID  string
	SpineRevision *string
	Dimensions    *BookDimensions
	AuthorNames   []string
}

type collectionBookDTO struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Pages         *int     `json:"pages"`
	CollectionID  string   `json:"collectionId"`
	SpineRevision *string  `json:"spineRevision"`
	AuthorNames   []string `json:"authorNames"`
}

func readCollectionCatalog(ctx context.Context, q collections.Queryable, collectionID string) ([]collectionCatalogRow, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			b.id,
			b.title,
			b.pages,
			b.collection_id,
			(SELECT revision FROM book_spines INDEXED BY book_spines_book_revision_idx WHERE book_id = b.id),
			bsd.width,
			bsd.height,
			bsd.manual_width,
			bsd.manual_height,
			bsd.source_pages,
			COALESCE(
				(SELECT json_group_array(name) FROM (
					SELECT a.name AS name
					FROM book_authors ba
					JOIN authors a ON a.id = ba.author_id
					WHERE ba.book_id = b.id
					ORDER BY COALESCE(ba.position, 10000), a.id
				)),
				'[]'
			)
		FROM books b
		LEFT JOIN book_shelf_dimensions bsd ON bsd.book_id = b.id
		WHERE b.collection_id = ?
		ORDER BY b.created_at ASC, b.id ASC
		LIMIT ?
	`, collectionID, BookshelfMaxBooks+1)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]collectionCatalogRow, 0)
	for rows.Next() {
		var (
			r           collectionCatalogRow
			pages       sql.NullInt64
			spineRev    sql.NullString
			dimW        sql.NullInt64
			dimH        sql.NullInt64
			dimManualW  sql.NullInt64
			dimManualH  sql.NullInt64
			dimSrcPages sql.NullInt64
			authorJSON  string
		)
		if err := rows.Scan(
			&r.ID, &r.Title, &pages, &r.CollectionID, &spineRev,
			&dimW, &dimH, &dimManualW, &dimManualH, &dimSrcPages,
			&authorJSON,
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
		var names []string
		if err := json.Unmarshal([]byte(authorJSON), &names); err != nil || names == nil {
			names = []string{}
		}
		r.AuthorNames = names
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out) > BookshelfMaxBooks {
		return nil, httpapi.NewError(http.StatusBadRequest, "This collection exceeds the supported bookshelf size.")
	}
	return out, nil
}

func computeCollectionCatalogToken(catalog []collectionCatalogRow) string {
	type entry struct {
		ID         string          `json:"id"`
		Pages      *int            `json:"pages"`
		Dimensions *BookDimensions `json:"dimensions"`
	}
	items := make([]entry, len(catalog))
	for i, c := range catalog {
		items[i] = entry{
			ID:         c.ID,
			Pages:      c.Pages,
			Dimensions: c.Dimensions,
		}
	}
	encoded, _ := json.Marshal(items)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func collectionMemberRole(ctx context.Context, q collections.Queryable, userID, collectionID string) (string, error) {
	var role string
	err := q.QueryRowContext(ctx, `
		SELECT role FROM collection_members WHERE user_id = ? AND collection_id = ? LIMIT 1
	`, userID, collectionID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", httpapi.NewError(http.StatusNotFound, "Collection not found")
	}
	if err != nil {
		return "", err
	}
	return role, nil
}

func upsertBookShelfDimensions(ctx context.Context, q collections.Queryable, books []ShelfBook) error {
	for i := 0; i < len(books); i += 100 {
		end := i + 100
		if end > len(books) {
			end = len(books)
		}
		batch := books[i:end]
		values := make([]string, len(batch))
		args := make([]any, 0, len(batch)*6)
		for j, b := range batch {
			values[j] = "(?, ?, ?, ?, ?, ?)"
			mw := 0
			if b.ManualWidth {
				mw = 1
			}
			mh := 0
			if b.ManualHeight {
				mh = 1
			}
			var sp any
			if b.SourcePages != nil {
				sp = *b.SourcePages
			}
			args = append(args, b.ID, b.Width, b.Height, mw, mh, sp)
		}
		_, err := q.ExecContext(ctx, `
			INSERT INTO book_shelf_dimensions (book_id, width, height, manual_width, manual_height, source_pages)
			VALUES `+strings.Join(values, ",")+`
			ON CONFLICT(book_id) DO UPDATE SET
				width = excluded.width,
				height = excluded.height,
				manual_width = excluded.manual_width,
				manual_height = excluded.manual_height,
				source_pages = excluded.source_pages
		`, args...)
		if err != nil {
			return err
		}
	}
	return nil
}

// GET /api/collections/{id}/bookshelf
func (s *Service) handleGetCollectionBookshelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	collectionID := r.PathValue("id")
	if collectionID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection is required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "GET /api/collections/{id}/bookshelf begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	role, err := collectionMemberRole(r.Context(), tx, userID, collectionID)
	if err != nil {
		s.writeErr(w, "GET /api/collections/{id}/bookshelf auth failed", err)
		return
	}

	catalog, err := readCollectionCatalog(r.Context(), tx, collectionID)
	if err != nil {
		s.writeErr(w, "GET /api/collections/{id}/bookshelf catalog failed", err)
		return
	}

	var (
		storedRev int
		storedRaw string
		hasStored bool
	)
	err = tx.QueryRowContext(r.Context(), `
		SELECT revision, layout FROM bookshelf_layouts WHERE scope_kind = 'collection' AND scope_id = ? LIMIT 1
	`, collectionID).Scan(&storedRev, &storedRaw)
	if err == nil {
		hasStored = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		s.writeErr(w, "GET /api/collections/{id}/bookshelf query failed", err)
		return
	}

	var layout *Bookshelf
	if hasStored {
		layout = ParseBookshelfJSON([]byte(storedRaw))
	} else {
		layout = EmptyBookshelf()
	}
	if layout == nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "The saved bookshelf could not be read.")
		return
	}

	dimByID := make(map[string]*BookDimensions, len(catalog))
	visible := make(map[string]struct{}, len(catalog))
	catalogBooks := make([]ShelfCatalogBook, len(catalog))
	for i, c := range catalog {
		dimByID[c.ID] = c.Dimensions
		visible[c.ID] = struct{}{}
		catalogBooks[i] = ShelfCatalogBook{
			ID:         c.ID,
			Pages:      c.Pages,
			Dimensions: c.Dimensions,
		}
	}

	placements := make([]BookLayoutEntry, 0)
	for bi := range layout.Bookcases {
		bc := &layout.Bookcases[bi]
		for si := range bc.Shelves {
			sh := &bc.Shelves[si]
			for ii := range sh.Items {
				it := &sh.Items[ii]
				for order := range it.Books {
					bk := &it.Books[order]
					oldW := bk.Width
					oldH := bk.Height
					if storedDim := dimByID[bk.ID]; storedDim != nil {
						bk.Width = storedDim.Width
						bk.Height = storedDim.Height
						bk.ManualWidth = storedDim.ManualWidth
						bk.ManualHeight = storedDim.ManualHeight
						bk.SourcePages = NormalizedPages(storedDim.SourcePages)
					}
					if _, ok := visible[bk.ID]; ok {
						ox := 0
						if bk.OffsetX != nil {
							ox = *bk.OffsetX
						}
						bx := it.X + ox
						placements = append(placements, BookLayoutEntry{
							Book: cloneShelfBook(*bk),
							Placement: &BookPlacementAnchor{
								CaseID:     bc.ID,
								ShelfID:    sh.ID,
								StackID:    bc.ID + "/" + sh.ID + "/" + itoa(ii),
								X:          it.X,
								BookX:      &bx,
								Horizontal: it.Horizontal,
								Order:      order,
								Width:      &oldW,
								Height:     &oldH,
							},
						})
					}
				}
			}
		}
	}

	var repairedArr *Bookshelf
	var repairedAdj []string
	if ParseBookshelfStruct(layout) == nil {
		geomRaw, _ := json.Marshal(BookshelfGeometry(layout))
		repairedArr, repairedAdj, err = ComposeBookshelfLayout(geomRaw, placements, collectionID)
		if err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	baseLayout := layout
	if repairedArr != nil {
		baseLayout = repairedArr
	}
	reconciled, needsAdjustment, _ := ReconcileBookshelf(baseLayout, catalogBooks)
	if ParseBookshelfStruct(reconciled) == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "This collection exceeds the supported bookshelf arrangement size.")
		return
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "GET /api/collections/{id}/bookshelf commit failed", err)
		return
	}

	adjSet := make(map[string]struct{}, len(repairedAdj)+len(needsAdjustment))
	adjustments := make([]string, 0, len(repairedAdj)+len(needsAdjustment))
	for _, id := range repairedAdj {
		if _, ok := adjSet[id]; !ok {
			adjSet[id] = struct{}{}
			adjustments = append(adjustments, id)
		}
	}
	for _, id := range needsAdjustment {
		if _, ok := adjSet[id]; !ok {
			adjSet[id] = struct{}{}
			adjustments = append(adjustments, id)
		}
	}

	booksDTO := make([]collectionBookDTO, len(catalog))
	for i, c := range catalog {
		booksDTO[i] = collectionBookDTO{
			ID:            c.ID,
			Title:         c.Title,
			Pages:         c.Pages,
			CollectionID:  c.CollectionID,
			SpineRevision: c.SpineRevision,
			AuthorNames:   c.AuthorNames,
		}
	}

	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"revision":    storedRev,
		"token":       computeCollectionCatalogToken(catalog),
		"arrangement": reconciled,
		"adjustments": adjustments,
		"books":       booksDTO,
		"canEdit":     role == "owner" || role == "editor",
	})
}

// PUT /api/collections/{id}/bookshelf
func (s *Service) handlePutCollectionBookshelf(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	collectionID := r.PathValue("id")
	if collectionID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection is required")
		return
	}

	raw, err := httpapi.ReadBodyBounded(r, maxBookshelfBodyBytes)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var fields map[string]json.RawMessage
	if len(strings.TrimSpace(string(raw))) == 0 || json.Unmarshal(raw, &fields) != nil || fields == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookshelf request")
		return
	}

	revRaw, hasRev := fields["revision"]
	tokenRaw, hasToken := fields["token"]
	arrRaw, hasArr := fields["arrangement"]
	rev, revOK := parseSafeNonNegInt(revRaw)
	var token string
	tokenOK := hasToken && json.Unmarshal(tokenRaw, &token) == nil
	if !hasRev || !revOK || !tokenOK || !hasArr {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookshelf request")
		return
	}

	arrangement := ParseBookshelfJSON(arrRaw)
	if arrangement == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid bookshelf arrangement.")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf lock failed", err)
		return
	}
	role, err := collectionMemberRole(r.Context(), tx, userID, collectionID)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf auth failed", err)
		return
	}
	if role != "owner" && role != "editor" {
		httpapi.WriteError(w, http.StatusForbidden, "Owner or editor access is required.")
		return
	}

	catalog, err := readCollectionCatalog(r.Context(), tx, collectionID)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf catalog failed", err)
		return
	}

	var (
		storedRev int
		storedRaw string
		hasStored bool
	)
	err = tx.QueryRowContext(r.Context(), `
		SELECT revision, layout FROM bookshelf_layouts WHERE scope_kind = 'collection' AND scope_id = ? LIMIT 1
	`, collectionID).Scan(&storedRev, &storedRaw)
	if err == nil {
		hasStored = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf stored query failed", err)
		return
	}

	if storedRev != rev || computeCollectionCatalogToken(catalog) != token {
		httpapi.WriteError(w, http.StatusConflict, "This bookshelf or its books changed. Reload to review the latest version.")
		return
	}

	if hasStored && RawHasVersion2([]byte(storedRaw)) && !RawHasVersion2(arrRaw) {
		httpapi.WriteError(w, http.StatusConflict, "This bookshelf needs a newer version of Delb. Reload before saving.")
		return
	}

	if err := validatePictureAssets(r.Context(), tx, PictureScope{Kind: "collection", ID: collectionID}, arrangement); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf pictures failed", err)
		return
	}

	var placed []ShelfBook
	for _, bc := range arrangement.Bookcases {
		for _, sh := range bc.Shelves {
			for _, it := range sh.Items {
				placed = append(placed, it.Books...)
			}
		}
	}

	currentIDs := make(map[string]*BookDimensions, len(catalog))
	for _, c := range catalog {
		currentIDs[c.ID] = c.Dimensions
	}
	if len(placed) != len(currentIDs) {
		httpapi.WriteError(w, http.StatusConflict, "The collection books changed. Reload to review the latest version.")
		return
	}
	for _, bk := range placed {
		if _, ok := currentIDs[bk.ID]; !ok {
			httpapi.WriteError(w, http.StatusConflict, "The collection books changed. Reload to review the latest version.")
			return
		}
	}

	var changedDims []ShelfBook
	for _, bk := range placed {
		cur := currentIDs[bk.ID]
		if cur == nil ||
			cur.Width != bk.Width ||
			cur.Height != bk.Height ||
			cur.ManualWidth != bk.ManualWidth ||
			cur.ManualHeight != bk.ManualHeight ||
			!equalIntPtr(cur.SourcePages, bk.SourcePages) {
			changedDims = append(changedDims, bk)
		}
	}
	if err := upsertBookShelfDimensions(r.Context(), tx, changedDims); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf dimensions failed", err)
		return
	}

	nextRev := rev + 1
	encoded, err := json.Marshal(arrangement)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf marshal failed", err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO bookshelf_layouts (scope_kind, scope_id, revision, layout, updated_at)
		VALUES ('collection', ?, ?, ?, ?)
		ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
			revision = excluded.revision,
			layout = excluded.layout,
			updated_at = excluded.updated_at
	`, collectionID, nextRev, string(encoded), time.Now().UTC().UnixMilli()); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf upsert failed", err)
		return
	}

	updatedCatalog, err := readCollectionCatalog(r.Context(), tx, collectionID)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf reload failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/bookshelf commit failed", err)
		return
	}

	w.Header().Set("Cache-Control", "private, no-store")
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"revision": nextRev,
		"token":    computeCollectionCatalogToken(updatedCatalog),
	})
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
