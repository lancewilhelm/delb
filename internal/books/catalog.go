package books

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
	"github.com/lancewilhelm/delb/internal/storage"
)

type entityKind string

const (
	entityAuthors    entityKind = "authors"
	entityPublishers entityKind = "publishers"
	entitySeries     entityKind = "series"
	entityTags       entityKind = "tags"
	entityGenres     entityKind = "genres"
)

type entityListConfig struct {
	table    string
	relation string
	key      string
	rhs      string
	order    string
}

var entityConfigs = map[entityKind]entityListConfig{
	entityAuthors: {
		table:    "authors",
		relation: "JOIN book_authors rel ON rel.author_id = e.id",
		key:      "rel.book_id",
		rhs:      "b.id",
		order:    "v.title, v.book_id",
	},
	entityPublishers: {
		table:    "publishers",
		relation: "",
		key:      "b.publisher_id",
		rhs:      "e.id",
		order:    "v.title, v.book_id",
	},
	entitySeries: {
		table:    "series",
		relation: "",
		key:      "b.series_id",
		rhs:      "e.id",
		order:    "COALESCE(v.series_index, 999999), v.title, v.book_id",
	},
	entityTags: {
		table:    "tags",
		relation: "JOIN book_tags rel ON rel.tag_id = e.id",
		key:      "rel.book_id",
		rhs:      "b.id",
		order:    "v.title, v.book_id",
	},
	entityGenres: {
		table:    "genres",
		relation: "JOIN book_genres rel ON rel.genre_id = e.id",
		key:      "rel.book_id",
		rhs:      "b.id",
		order:    "v.title, v.book_id",
	},
}

var intStrRe = regexp.MustCompile(`^-?\d+$`)

func boundedIntStrict(raw string, fallback, minVal, maxVal int) int {
	if !intStrRe.MatchString(raw) {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	if n < minVal {
		return minVal
	}
	if n > maxVal {
		return maxVal
	}
	return n
}

func (s *Service) handleListAuthors(w http.ResponseWriter, r *http.Request) {
	s.handleListEntities(w, r, entityAuthors)
}
func (s *Service) handleListPublishers(w http.ResponseWriter, r *http.Request) {
	s.handleListEntities(w, r, entityPublishers)
}
func (s *Service) handleListSeries(w http.ResponseWriter, r *http.Request) {
	s.handleListEntities(w, r, entitySeries)
}
func (s *Service) handleListTags(w http.ResponseWriter, r *http.Request) {
	s.handleListEntities(w, r, entityTags)
}
func (s *Service) handleListGenres(w http.ResponseWriter, r *http.Request) {
	s.handleListEntities(w, r, entityGenres)
}

// Mirrors server/utils/books/entity-list.ts + entity-list-query.ts.
func (s *Service) handleListEntities(w http.ResponseWriter, r *http.Request, kind entityKind) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	q := r.URL.Query()
	limit := boundedIntStrict(q.Get("limit"), 50, 1, 100)
	offset := boundedIntStrict(q.Get("offset"), 0, 0, 1000000000)
	previewLimit := boundedIntStrict(q.Get("previewLimit"), 8, -1, math.MaxInt32)
	artPreviews := q.Get("artPreviews") == "1"
	if artPreviews {
		// One tile uses at most the Wall's 5×5 grid of previews.
		previewLimit = boundedIntStrict(q.Get("previewLimit"), 25, 0, 25)
	}
	search := strings.TrimSpace(q.Get("search"))
	cfg := entityConfigs[kind]

	sqlQuery := `
		WITH visible AS (
			SELECT DISTINCT e.id, e.name, b.id AS book_id, b.title,
				b.cover_image_path, b.updated_at, b.series_index, b.pages
			FROM ` + cfg.table + ` e
			` + cfg.relation + `
			JOIN books b ON ` + cfg.key + ` = ` + cfg.rhs + `
			JOIN visible_books vb ON vb.book_id = b.id
			WHERE vb.user_id = ?
			  AND e.name GLOB ?
		), summaries AS (
			SELECT id, name, count(*) AS book_count FROM visible
			GROUP BY id, name ORDER BY name, id LIMIT ? OFFSET ?
		), ranked AS (
			SELECT v.*, row_number() OVER (PARTITION BY v.id ORDER BY ` + cfg.order + `) AS position
			FROM visible v JOIN (SELECT id FROM summaries ORDER BY name, id LIMIT ?) s ON s.id = v.id
			WHERE ? OR (v.cover_image_path IS NOT NULL AND trim(v.cover_image_path) != '')
		)
		SELECT s.id, s.name, s.book_count, r.book_id,
			r.title, r.cover_image_path, r.updated_at, r.series_index,
			CASE WHEN ? THEN r.pages END, sp.revision,
			CASE WHEN dim.manual_width = 1 THEN dim.width END, dim.height
		FROM summaries s LEFT JOIN ranked r ON r.id = s.id AND (? = -1 OR r.position <= ?)
		LEFT JOIN book_spines sp ON sp.book_id = r.book_id AND ?
		LEFT JOIN book_shelf_dimensions dim ON dim.book_id = r.book_id AND ?
		ORDER BY s.name, s.id, r.position
	`

	rows, err := s.db.QueryContext(r.Context(), sqlQuery,
		userID, TitleFilterGlob(search),
		limit+1, offset, limit, artPreviews,
		artPreviews, previewLimit, previewLimit, artPreviews, artPreviews,
	)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/"+string(kind)+" failed", "Failed to load "+string(kind), err)
		return
	}
	defer func() { _ = rows.Close() }()

	type previewBook struct {
		ID                string   `json:"id"`
		Title             string   `json:"title"`
		CoverImagePath    *string  `json:"coverImagePath"`
		CoverThumbnailURL string   `json:"coverThumbnailUrl"`
		SeriesIndex       *float64 `json:"seriesIndex"`
		UpdatedAt         string   `json:"updatedAt,omitempty"`
		Pages             *int64   `json:"pages,omitempty"`
		SpineRevision     *string  `json:"spineRevision,omitempty"`
		ShelfWidth        *int64   `json:"shelfWidth,omitempty"`
		ShelfHeight       *int64   `json:"shelfHeight,omitempty"`
	}
	type entityOut struct {
		ID        string        `json:"id"`
		Name      string        `json:"name"`
		BookCount int           `json:"bookCount"`
		Books     []previewBook `json:"books"`
	}

	byID := make(map[string]*entityOut)
	order := make([]string, 0)
	for rows.Next() {
		var (
			id, name    string
			bookCount   int
			bookID      sql.NullString
			title       sql.NullString
			cover       sql.NullString
			updatedAt   sql.NullInt64
			seriesIndex sql.NullFloat64
			pages       sql.NullInt64
			spine       sql.NullString
			shelfWidth  sql.NullInt64
			shelfHeight sql.NullInt64
		)
		if err := rows.Scan(&id, &name, &bookCount, &bookID, &title, &cover, &updatedAt, &seriesIndex, &pages, &spine, &shelfWidth, &shelfHeight); err != nil {
			s.writeErrWithFallback(w, "GET /api/"+string(kind)+" scan failed", "Failed to load "+string(kind), err)
			return
		}
		ent, ok := byID[id]
		if !ok {
			ent = &entityOut{
				ID:        id,
				Name:      name,
				BookCount: bookCount,
				Books:     make([]previewBook, 0),
			}
			byID[id] = ent
			order = append(order, id)
		}
		if !bookID.Valid || bookID.String == "" {
			continue
		}
		preview := previewBook{
			ID:            bookID.String,
			Title:         title.String,
			SeriesIndex:   nullFloat64Ptr(seriesIndex),
			Pages:         nullInt64Ptr(pages),
			SpineRevision: nullStringPtr(spine),
			ShelfWidth:    nullInt64Ptr(shelfWidth),
			ShelfHeight:   nullInt64Ptr(shelfHeight),
		}
		var msPtr *int64
		if updatedAt.Valid {
			ms := updatedAt.Int64 * 1000
			msPtr = &ms
			if artPreviews {
				preview.UpdatedAt = formatUnixSecISO(updatedAt.Int64)
			}
		}
		if cover.Valid && strings.TrimSpace(cover.String) != "" {
			preview.CoverImagePath = &cover.String
			preview.CoverThumbnailURL = storage.BuildBookCoverURL(bookID.String, msPtr, "thumb")
		}
		ent.Books = append(ent.Books, preview)
	}
	if err := rows.Err(); err != nil {
		s.writeErrWithFallback(w, "GET /api/"+string(kind)+" rows err", "Failed to load "+string(kind), err)
		return
	}

	hasMore := len(order) > limit
	if hasMore {
		order = order[:limit]
	}
	out := make([]entityOut, len(order))
	for i, id := range order {
		out[i] = *byID[id]
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			string(kind): out,
			"hasMore":    hasMore,
		},
	})
}

func visibleEntitySQL(kind string) string {
	switch kind {
	case "author":
		return `EXISTS (SELECT 1 FROM book_authors ba INNER JOIN books b ON b.id = ba.book_id INNER JOIN visible_books vb ON vb.book_id = b.id WHERE ba.author_id = authors.id AND vb.user_id = ?)`
	case "tag":
		return `EXISTS (SELECT 1 FROM book_tags bt INNER JOIN books b ON b.id = bt.book_id INNER JOIN visible_books vb ON vb.book_id = b.id WHERE bt.tag_id = tags.id AND vb.user_id = ?)`
	case "genre":
		return `EXISTS (SELECT 1 FROM book_genres bg INNER JOIN books b ON b.id = bg.book_id INNER JOIN visible_books vb ON vb.book_id = b.id WHERE bg.genre_id = genres.id AND vb.user_id = ?)`
	case "publisher":
		return `EXISTS (SELECT 1 FROM books b INNER JOIN visible_books vb ON vb.book_id = b.id WHERE b.publisher_id = publishers.id AND vb.user_id = ?)`
	case "series":
		return `EXISTS (SELECT 1 FROM books b INNER JOIN visible_books vb ON vb.book_id = b.id WHERE b.series_id = series.id AND vb.user_id = ?)`
	default:
		return "0=1"
	}
}

func scoreName(name, lowerNeedle string) float64 {
	lower := strings.ToLower(name)
	starts := 100.0
	if strings.HasPrefix(lower, lowerNeedle) {
		starts = 0.0
	}
	idx := strings.Index(lower, lowerNeedle)
	idxVal := 10000.0
	if idx >= 0 {
		idxVal = float64(idx)
	}
	nameLen := len(name)
	if nameLen > 10000 {
		nameLen = 10000
	}
	return starts + idxVal + float64(nameLen)/10000.0
}

func rankNamedRefs(rows []namedRef, rawNeedle string, take int) []namedRef {
	seen := make(map[string]struct{}, len(rows))
	unique := make([]namedRef, 0, len(rows))
	for _, r := range rows {
		if _, ok := seen[r.ID]; ok {
			continue
		}
		seen[r.ID] = struct{}{}
		unique = append(unique, r)
	}
	lowerNeedle := strings.ToLower(rawNeedle)
	type scored struct {
		ref   namedRef
		score float64
	}
	list := make([]scored, len(unique))
	for i, r := range unique {
		list[i] = scored{ref: r, score: scoreName(r.Name, lowerNeedle)}
	}
	sort.Slice(list, func(i, j int) bool {
		if list[i].score != list[j].score {
			return list[i].score < list[j].score
		}
		if len(list[i].ref.Name) != len(list[j].ref.Name) {
			return len(list[i].ref.Name) < len(list[j].ref.Name)
		}
		return list[i].ref.Name < list[j].ref.Name
	})
	if len(list) > take {
		list = list[:take]
	}
	out := make([]namedRef, len(list))
	for i, s := range list {
		out[i] = s.ref
	}
	return out
}

func (s *Service) handleSearchAuthors(w http.ResponseWriter, r *http.Request) {
	s.handleAdminEntitySearch(w, r, "authors", "author", 5, false)
}
func (s *Service) handleSearchPublishers(w http.ResponseWriter, r *http.Request) {
	s.handleAdminEntitySearch(w, r, "publishers", "publisher", 5, false)
}
func (s *Service) handleSearchSeries(w http.ResponseWriter, r *http.Request) {
	s.handleAdminEntitySearch(w, r, "series", "series", 5, false)
}
func (s *Service) handleSearchTags(w http.ResponseWriter, r *http.Request) {
	s.handleAdminEntitySearch(w, r, "tags", "tag", 8, true)
}
func (s *Service) handleSearchGenres(w http.ResponseWriter, r *http.Request) {
	s.handleAdminEntitySearch(w, r, "genres", "genre", 8, true)
}

func (s *Service) handleAdminEntitySearch(w http.ResponseWriter, r *http.Request, table, visKind string, defaultLimit int, useInstr bool) {
	// Nitro returns 401 if unauthenticated OR not admin/owner.
	swu, err := s.auth.Authenticate(w, r)
	if err != nil {
		s.writeErr(w, "entity search auth failed", err)
		return
	}
	if swu == nil || (swu.User.Role != "admin" && swu.User.Role != "owner") {
		httpapi.WriteError(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	raw := strings.TrimSpace(r.URL.Query().Get("q"))
	if raw == "" {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"results": []any{}},
		})
		return
	}
	take := clampIntQuery(r.URL.Query().Get("limit"), 1, 20, defaultLimit)
	containsLimit := take * 5
	if containsLimit < 25 {
		containsLimit = 25
	}

	vis := visibleEntitySQL(visKind)
	var prefixQ, containsQ string
	var prefixArgs, containsArgs []any
	if useInstr {
		prefixQ = `SELECT id, name FROM ` + table + ` WHERE instr(lower(name), lower(?)) = 1 AND ` + vis + ` LIMIT ?`
		containsQ = `SELECT id, name FROM ` + table + ` WHERE instr(lower(name), lower(?)) > 0 AND ` + vis + ` LIMIT ?`
		prefixArgs = []any{raw, swu.User.ID, take}
		containsArgs = []any{raw, swu.User.ID, containsLimit}
	} else {
		needle := EscapeLike(raw)
		prefixQ = `SELECT id, name FROM ` + table + ` WHERE name LIKE ? ESCAPE '\' AND ` + vis + ` LIMIT ?`
		containsQ = `SELECT id, name FROM ` + table + ` WHERE name LIKE ? ESCAPE '\' AND ` + vis + ` LIMIT ?`
		prefixArgs = []any{needle + "%", swu.User.ID, take}
		containsArgs = []any{"%" + needle + "%", swu.User.ID, containsLimit}
	}

	merged := make([]namedRef, 0, take+containsLimit)
	for _, pair := range []struct {
		q    string
		args []any
	}{
		{prefixQ, prefixArgs},
		{containsQ, containsArgs},
	} {
		rows, err := s.db.QueryContext(r.Context(), pair.q, pair.args...)
		if err != nil {
			s.writeErrWithFallback(w, "GET /api/"+table+"/search failed", "Failed to search "+table, err)
			return
		}
		for rows.Next() {
			var ref namedRef
			if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
				_ = rows.Close()
				s.writeErrWithFallback(w, "GET /api/"+table+"/search scan failed", "Failed to search "+table, err)
				return
			}
			merged = append(merged, ref)
		}
		_ = rows.Close()
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]any{"results": rankNamedRefs(merged, raw, take)},
	})
}

// GET /api/authors/{id}/books, /api/publishers/{id}/books, /api/tags/{id}/books
func (s *Service) handleListAuthorBooks(w http.ResponseWriter, r *http.Request) {
	s.handleListEntityBooks(w, r, "author", "authors", "Author", "author")
}
func (s *Service) handleListPublisherBooks(w http.ResponseWriter, r *http.Request) {
	s.handleListEntityBooks(w, r, "publisher", "publishers", "Publisher", "publisher")
}
func (s *Service) handleListTagBooks(w http.ResponseWriter, r *http.Request) {
	s.handleListEntityBooks(w, r, "tag", "tags", "Tag", "tag")
}
func (s *Service) handleListGenreBooks(w http.ResponseWriter, r *http.Request) {
	s.handleListEntityBooks(w, r, "genre", "genres", "Genre", "genre")
}

func (s *Service) handleListEntityBooks(w http.ResponseWriter, r *http.Request, visKind, table, label, responseKey string) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	entityID := r.PathValue("id")
	if entityID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing "+visKind+" id")
		return
	}

	q := r.URL.Query()
	limit := clampIntQuery(q.Get("limit"), 1, 200, 48)
	sortKey := NormalizeSortKey(q.Get("sort"))
	sortDir := NormalizeSortDir(q.Get("sortDir"), sortKey)
	ordering := BuildBookSort(sortKey, sortDir, DecodeCursor(q.Get("cursor")))

	var entity namedRef
	err := s.db.QueryRowContext(r.Context(), `
		SELECT id, name FROM `+table+` WHERE id = ? AND `+visibleEntitySQL(visKind)+` LIMIT 1
	`, entityID, userID).Scan(&entity.ID, &entity.Name)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, label+" not found")
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "entity books lookup failed", "Failed to fetch "+visKind+" books", err)
		return
	}

	var joinSQL, filterSQL string
	switch visKind {
	case "author":
		joinSQL = `INNER JOIN book_authors ba ON ba.book_id = b.id`
		filterSQL = `ba.author_id = ?`
	case "publisher":
		filterSQL = `b.publisher_id = ?`
	case "tag":
		joinSQL = `INNER JOIN book_tags bt ON bt.book_id = b.id`
		filterSQL = `bt.tag_id = ?`
	case "genre":
		joinSQL = `INNER JOIN book_genres bg ON bg.book_id = b.id`
		filterSQL = `bg.genre_id = ?`
	}

	args := make([]any, 0, 8)
	if sortKey == SortDateFinished {
		joinSQL += FinishedJoinSQL
		args = append(args, userID)
	}
	args = append(args, entityID, userID)
	where := []string{
		filterSQL,
		library.VisibleBookFilter("b"),
	}
	if ordering.WhereSQL != "" {
		where = append(where, ordering.WhereSQL)
		args = append(args, ordering.WhereArgs...)
	}
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT `+bookSelectColumns+`
		FROM books b `+joinSQL+`
		WHERE `+strings.Join(where, " AND ")+`
		GROUP BY b.id
		ORDER BY `+ordering.OrderSQL+`
		LIMIT ?
	`, args...)
	if err != nil {
		s.writeErrWithFallback(w, "entity books query failed", "Failed to fetch "+visKind+" books", err)
		return
	}
	var found []bookRow
	for rows.Next() {
		b, err := scanBookRow(rows)
		if err != nil {
			_ = rows.Close()
			s.writeErrWithFallback(w, "entity books scan failed", "Failed to fetch "+visKind+" books", err)
			return
		}
		found = append(found, b)
	}
	_ = rows.Close()

	if len(found) == 0 {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				responseKey:  entity,
				"books":      []any{},
				"nextCursor": nil,
			},
		})
		return
	}

	hasMore := len(found) > limit
	page := found
	if hasMore {
		page = found[:limit]
	}

	withRel, err := attachBookListRelations(r.Context(), s.db, page)
	if err != nil {
		s.writeErrWithFallback(w, "entity books relations failed", "Failed to fetch "+visKind+" books", err)
		return
	}
	enriched, err := enrichBookViewPage(r.Context(), s.db, withRel, userID)
	if err != nil {
		s.writeErrWithFallback(w, "entity books enrich failed", "Failed to fetch "+visKind+" books", err)
		return
	}

	last := page[len(page)-1]
	nextCursor := NextBookCursor(sortKey, hasMore, last.ID, last.CreatedAt, last.SortTitle, nullInt64Ptr(last.PublishedAt), nullInt64Ptr(last.Pages),
		finishedAtForCursor(r.Context(), s.db, sortKey, userID, last.ID))

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			responseKey:  entity,
			"books":      enriched,
			"nextCursor": nextCursor,
		},
	})
}

type seriesBooksCursor struct {
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

func decodeSeriesCursor(raw string) (*seriesBooksCursor, int64) {
	if strings.TrimSpace(raw) == "" {
		return nil, 0
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		b, err = base64.URLEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			return nil, 0
		}
	}
	var c seriesBooksCursor
	if err := json.Unmarshal(b, &c); err != nil {
		return nil, 0
	}
	c.CreatedAt = strings.TrimSpace(c.CreatedAt)
	c.ID = strings.TrimSpace(c.ID)
	if c.CreatedAt == "" || c.ID == "" {
		return nil, 0
	}
	sec, ok := parseISOToUnixSec(c.CreatedAt)
	if !ok {
		return nil, 0
	}
	return &c, sec
}

// GET /api/series/{id}/books
func (s *Service) handleListSeriesBooks(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	seriesID := r.PathValue("id")
	if seriesID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing series id")
		return
	}
	q := r.URL.Query()
	limit := clampIntQuery(q.Get("limit"), 1, 200, 48)
	cursor, cursorSec := decodeSeriesCursor(q.Get("cursor"))

	var seriesMeta namedRef
	err := s.db.QueryRowContext(r.Context(), `
		SELECT id, name FROM series WHERE id = ? AND `+visibleEntitySQL("series")+` LIMIT 1
	`, seriesID, userID).Scan(&seriesMeta.ID, &seriesMeta.Name)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Series not found")
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/series/{id}/books lookup failed", "Failed to fetch series books", err)
		return
	}

	args := make([]any, 0, 6)
	args = append(args, seriesID, userID)
	where := []string{
		"b.series_id = ?",
		library.VisibleBookFilter("b"),
	}
	if cursor != nil {
		where = append(where, "(b.created_at < ? OR (b.created_at = ? AND b.id < ?))")
		args = append(args, cursorSec, cursorSec, cursor.ID)
	}
	args = append(args, limit+1)

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT `+bookSelectColumns+`
		FROM books b
		WHERE `+strings.Join(where, " AND ")+`
		GROUP BY b.id
		ORDER BY b.created_at DESC, b.id DESC
		LIMIT ?
	`, args...)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/series/{id}/books query failed", "Failed to fetch series books", err)
		return
	}
	var found []bookRow
	for rows.Next() {
		b, err := scanBookRow(rows)
		if err != nil {
			_ = rows.Close()
			s.writeErrWithFallback(w, "GET /api/series/{id}/books scan failed", "Failed to fetch series books", err)
			return
		}
		found = append(found, b)
	}
	_ = rows.Close()

	if len(found) == 0 {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"series": seriesMeta, "books": []any{}, "nextCursor": nil},
		})
		return
	}

	hasMore := len(found) > limit
	page := found
	if hasMore {
		page = found[:limit]
	}

	withRel, err := attachBookListRelations(r.Context(), s.db, page)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/series/{id}/books relations failed", "Failed to fetch series books", err)
		return
	}

	var nextCursor *string
	if hasMore && len(page) > 0 {
		last := page[len(page)-1]
		b, _ := json.Marshal(seriesBooksCursor{
			CreatedAt: formatUnixSecISO(last.CreatedAt),
			ID:        last.ID,
		})
		enc := base64.RawURLEncoding.EncodeToString(b)
		nextCursor = &enc
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"series":     seriesMeta,
			"books":      withRel,
			"nextCursor": nextCursor,
		},
	})
}

// DELETE /api/tags/{id}
func (s *Service) handleDeleteTag(w http.ResponseWriter, r *http.Request) {
	s.handleDeleteCatalogTerm(w, r, "tag", "tags", "book_tags", "tag_id", "Tag")
}

// DELETE /api/genres/{id}
func (s *Service) handleDeleteGenre(w http.ResponseWriter, r *http.Request) {
	s.handleDeleteCatalogTerm(w, r, "genre", "genres", "book_genres", "genre_id", "Genre")
}

func (s *Service) handleDeleteCatalogTerm(w http.ResponseWriter, r *http.Request, visKind, table, joinTable, fkCol, label string) {
	user := httpapi.SessionFromContext(r.Context()).User
	if user.Role != "admin" && user.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Forbidden")
		return
	}
	sourceID := r.PathValue("id")
	if sourceID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing "+visKind+" id")
		return
	}
	if err := mutateCatalogTerm(r.Context(), s.db, user.ID, visKind, table, joinTable, fkCol, label, "delete", sourceID, ""); err != nil {
		s.writeErr(w, "DELETE /api/"+table+"/{id} failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})
}

// POST /api/tags/{id}/merge
func (s *Service) handleMergeTag(w http.ResponseWriter, r *http.Request) {
	s.handleMergeCatalogTerm(w, r, "tag", "tags", "book_tags", "tag_id", "Tag")
}

// POST /api/genres/{id}/merge
func (s *Service) handleMergeGenre(w http.ResponseWriter, r *http.Request) {
	s.handleMergeCatalogTerm(w, r, "genre", "genres", "book_genres", "genre_id", "Genre")
}

func (s *Service) handleMergeCatalogTerm(w http.ResponseWriter, r *http.Request, visKind, table, joinTable, fkCol, label string) {
	user := httpapi.SessionFromContext(r.Context()).User
	if user.Role != "admin" && user.Role != "owner" {
		httpapi.WriteError(w, http.StatusForbidden, "Forbidden")
		return
	}
	sourceID := r.PathValue("id")

	var body map[string]json.RawMessage
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Source and destination are required")
		return
	}
	var targetID string
	if body != nil {
		if rawTarget, ok := body["targetId"]; ok && strings.TrimSpace(string(rawTarget)) != "null" {
			var t string
			if json.Unmarshal(rawTarget, &t) == nil {
				targetID = strings.TrimSpace(t)
			}
		}
	}
	if sourceID == "" || targetID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Source and destination are required")
		return
	}
	if err := mutateCatalogTerm(r.Context(), s.db, user.ID, visKind, table, joinTable, fkCol, label, "merge", sourceID, targetID); err != nil {
		s.writeErr(w, "POST /api/"+table+"/{id}/merge failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]string{"targetId": targetID},
	})
}

func mutateCatalogTerm(ctx context.Context, db *sql.DB, userID, visKind, table, joinTable, fkCol, label, kind, sourceID, targetID string) error {
	if kind == "merge" && sourceID == targetID {
		return httpapi.NewError(http.StatusBadRequest, "Choose a different destination "+visKind)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	checkIDs := []string{sourceID}
	if kind == "merge" {
		checkIDs = append(checkIDs, targetID)
	}
	vis := visibleEntitySQL(visKind)
	for _, id := range checkIDs {
		var existing string
		err := tx.QueryRowContext(ctx, `SELECT id FROM `+table+` WHERE id = ? AND `+vis+` LIMIT 1`, id, userID).Scan(&existing)
		if errors.Is(err, sql.ErrNoRows) {
			return httpapi.NewError(http.StatusNotFound, label+" not found")
		}
		if err != nil {
			return err
		}
	}

	if table == "tags" {
		if err := moveTagRules(ctx, tx, kind, sourceID, targetID); err != nil {
			return err
		}
	}
	if kind == "merge" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO `+joinTable+` (book_id, `+fkCol+`)
			SELECT book_id, ? FROM `+joinTable+` WHERE `+fkCol+` = ?
			ON CONFLICT(book_id, `+fkCol+`) DO NOTHING
		`, targetID, sourceID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+joinTable+` WHERE `+fkCol+` = ?`, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+table+` WHERE id = ?`, sourceID); err != nil {
		return err
	}
	return tx.Commit()
}

// moveTagRules keeps tag visibility rules intact when a tag goes away. A merge
// moves the rules to the destination tag, and a block rule wins if a user had
// both modes. A delete is refused while any rule uses the tag.
func moveTagRules(ctx context.Context, tx *sql.Tx, kind, sourceID, targetID string) error {
	if kind != "merge" {
		var used int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM user_tag_rules WHERE tag_id = ? LIMIT 1`, sourceID).Scan(&used)
		if err == nil {
			return httpapi.NewError(http.StatusConflict, "Tag visibility rules use this tag. Remove it from those rules first.")
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		return nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO user_tag_rules (user_id, tag_id, mode, created_at)
		SELECT user_id, ?, mode, created_at FROM user_tag_rules WHERE tag_id = ?
		ON CONFLICT(user_id, tag_id) DO UPDATE SET
			mode = CASE WHEN user_tag_rules.mode = 'block' OR excluded.mode = 'block' THEN 'block' ELSE 'allow' END
	`, targetID, sourceID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `DELETE FROM user_tag_rules WHERE tag_id = ?`, sourceID)
	return err
}

var (
	isbnPrefixRe    = regexp.MustCompile(`(?i)^\s*isbn(?:-?1[03])?\s*[:#]?\s*`)
	startsISBNRe    = regexp.MustCompile(`(?i)^\s*isbn`)
	isbnLikeCharsRe = regexp.MustCompile(`^[0-9Xx\-\s]{10,}$`)
	isbn13DigitsRe  = regexp.MustCompile(`^[0-9]{13}$`)
	isbn10DigitsRe  = regexp.MustCompile(`^[0-9X]{10}$`)
)

func normalizeSearchIdentCandidate(input string) string {
	stripped := strings.TrimSpace(isbnPrefixRe.ReplaceAllString(input, ""))
	return strings.ToUpper(nonAlnumRe.ReplaceAllString(stripped, ""))
}

// GET /api/search
func (s *Service) handleGlobalSearch(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	q := r.URL.Query()
	raw := strings.TrimSpace(q.Get("q"))
	perBucketLimit := clampIntQuery(q.Get("limit"), 1, 50, 8)

	if raw == "" {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"q":              raw,
				"perBucketLimit": perBucketLimit,
				"buckets": map[string]any{
					"books":      []any{},
					"authors":    []any{},
					"series":     []any{},
					"publishers": []any{},
					"genres":     []any{},
					"tags":       []any{},
				},
			},
		})
		return
	}

	needle := EscapeLike(raw)
	prefix := needle + "%"
	contains := "%" + needle + "%"
	lowerNeedle := strings.ToLower(raw)

	normIdent := normalizeSearchIdentCandidate(raw)
	isProbIdent := startsISBNRe.MatchString(raw) ||
		isbnLikeCharsRe.MatchString(raw) ||
		isbn13DigitsRe.MatchString(normIdent) ||
		isbn10DigitsRe.MatchString(normIdent)

	// ---- Books bucket
	booksBucket := make([]map[string]any, 0)
	{
		type searchBookRow struct {
			id         string
			title      string
			published  sql.NullString
			createdAt  int64
			updatedAt  int64
			cover      sql.NullString
			matchKind  string
			matchedVal string
		}

		colArgs := []any{userID}

		var merged []searchBookRow
		appendBookQuery := func(query string, extraArgs []any, matchKind string, hasMatchedVal bool) error {
			args := append(append([]any(nil), colArgs...), extraArgs...)
			rows, err := s.db.QueryContext(r.Context(), query, args...)
			if err != nil {
				return err
			}
			defer func() { _ = rows.Close() }()
			for rows.Next() {
				var r searchBookRow
				r.matchKind = matchKind
				if hasMatchedVal {
					var mv sql.NullString
					if err := rows.Scan(&r.id, &r.title, &r.published, &r.createdAt, &r.updatedAt, &r.cover, &mv); err != nil {
						return err
					}
					r.matchedVal = mv.String
				} else {
					if err := rows.Scan(&r.id, &r.title, &r.published, &r.createdAt, &r.updatedAt, &r.cover); err != nil {
						return err
					}
				}
				merged = append(merged, r)
			}
			return rows.Err()
		}

		limPrefix := perBucketLimit * 8
		if limPrefix < 80 {
			limPrefix = 80
		}
		limContains := perBucketLimit * 12
		if limContains < 120 {
			limContains = 120
		}

		if err := appendBookQuery(`
			SELECT b.id, b.title, b.published, b.created_at, b.updated_at, b.cover_image_path
			FROM books b
			INNER JOIN visible_books vb ON vb.book_id = b.id
			WHERE vb.user_id = ? AND b.title LIKE ? ESCAPE '\'
			LIMIT ?
		`, []any{prefix, limPrefix}, "titlePrefix", false); err != nil {
			s.writeErrWithFallback(w, "GET /api/search title prefix failed", "Failed to search", err)
			return
		}
		if err := appendBookQuery(`
			SELECT b.id, b.title, b.published, b.created_at, b.updated_at, b.cover_image_path
			FROM books b
			INNER JOIN visible_books vb ON vb.book_id = b.id
			WHERE vb.user_id = ? AND b.title LIKE ? ESCAPE '\'
			LIMIT ?
		`, []any{contains, limContains}, "titleContains", false); err != nil {
			s.writeErrWithFallback(w, "GET /api/search title contains failed", "Failed to search", err)
			return
		}
		if err := appendBookQuery(`
			SELECT b.id, b.title, b.published, b.created_at, b.updated_at, b.cover_image_path
			FROM books b
			INNER JOIN visible_books vb ON vb.book_id = b.id
			INNER JOIN book_authors ba ON ba.book_id = b.id
			INNER JOIN authors a ON a.id = ba.author_id
			WHERE vb.user_id = ? AND a.name LIKE ? ESCAPE '\'
			LIMIT ?
		`, []any{contains, limContains}, "author", false); err != nil {
			s.writeErrWithFallback(w, "GET /api/search author match failed", "Failed to search", err)
			return
		}
		if isProbIdent && len(normIdent) >= 4 {
			limIdent := perBucketLimit * 20
			if limIdent < 200 {
				limIdent = 200
			}
			if err := appendBookQuery(`
				SELECT b.id, b.title, b.published, b.created_at, b.updated_at, b.cover_image_path, bi.value
				FROM books b
				INNER JOIN visible_books vb ON vb.book_id = b.id
				INNER JOIN book_identifiers bi ON bi.book_id = b.id
				WHERE vb.user_id = ? AND UPPER(bi.value) LIKE ? ESCAPE '\'
				LIMIT ?
			`, []any{"%" + EscapeLike(normIdent) + "%", limIdent}, "identifier", true); err != nil {
				s.writeErrWithFallback(w, "GET /api/search ident match failed", "Failed to search", err)
				return
			}
		}

		matchPriority := func(r searchBookRow) int {
			switch r.matchKind {
			case "identifier":
				ident := normalizeSearchIdentCandidate(r.matchedVal)
				if ident != "" && ident == normIdent {
					return 0
				}
				if ident != "" && normIdent != "" && strings.HasPrefix(ident, normIdent) {
					return 1
				}
				return 2
			case "titlePrefix":
				return 10
			case "titleContains":
				return 20
			case "author":
				return 30
			default:
				return 50
			}
		}

		bestByID := make(map[string]searchBookRow)
		for _, row := range merged {
			prev, exists := bestByID[row.id]
			if !exists || matchPriority(row) < matchPriority(prev) {
				bestByID[row.id] = row
			}
		}

		type scoredBook struct {
			row     searchBookRow
			score   float64
			recency int64
		}
		scoredList := make([]scoredBook, 0, len(bestByID))
		for _, row := range bestByID {
			pri := float64(matchPriority(row))
			sc := pri*1000.0 + scoreName(row.title, lowerNeedle)
			scoredList = append(scoredList, scoredBook{row: row, score: sc, recency: row.createdAt})
		}
		sort.Slice(scoredList, func(i, j int) bool {
			if scoredList[i].score != scoredList[j].score {
				return scoredList[i].score < scoredList[j].score
			}
			if scoredList[i].recency != scoredList[j].recency {
				return scoredList[i].recency > scoredList[j].recency
			}
			return scoredList[i].row.title < scoredList[j].row.title
		})
		if len(scoredList) > perBucketLimit {
			scoredList = scoredList[:perBucketLimit]
		}

		if len(scoredList) > 0 {
			bIDs := make([]any, len(scoredList))
			for i, sb := range scoredList {
				bIDs[i] = sb.row.id
			}
			bPh := makePlaceholders(len(bIDs))

			type aPos struct {
				name string
				pos  sql.NullInt64
			}
			authorsByBook := make(map[string][]aPos)
			aRows, err := s.db.QueryContext(r.Context(), `
				SELECT ba.book_id, a.name, ba.position
				FROM book_authors ba
				INNER JOIN authors a ON a.id = ba.author_id
				WHERE ba.book_id IN (`+bPh+`)
			`, bIDs...)
			if err != nil {
				s.writeErrWithFallback(w, "GET /api/search book authors failed", "Failed to search", err)
				return
			}
			for aRows.Next() {
				var bid string
				var ap aPos
				if err := aRows.Scan(&bid, &ap.name, &ap.pos); err != nil {
					_ = aRows.Close()
					s.writeErrWithFallback(w, "GET /api/search book author scan failed", "Failed to search", err)
					return
				}
				authorsByBook[bid] = append(authorsByBook[bid], ap)
			}
			_ = aRows.Close()

			identsByBook := make(map[string][]IdentifierInput)
			iRows, err := s.db.QueryContext(r.Context(), `
				SELECT book_id, type, value FROM book_identifiers WHERE book_id IN (`+bPh+`)
			`, bIDs...)
			if err != nil {
				s.writeErrWithFallback(w, "GET /api/search book idents failed", "Failed to search", err)
				return
			}
			for iRows.Next() {
				var bid string
				var ident IdentifierInput
				if err := iRows.Scan(&bid, &ident.Type, &ident.Value); err != nil {
					_ = iRows.Close()
					s.writeErrWithFallback(w, "GET /api/search book ident scan failed", "Failed to search", err)
					return
				}
				identsByBook[bid] = append(identsByBook[bid], ident)
			}
			_ = iRows.Close()

			for _, sb := range scoredList {
				b := sb.row
				aList := append([]aPos(nil), authorsByBook[b.id]...)
				sort.Slice(aList, func(i, j int) bool {
					ap := int64(9999)
					if aList[i].pos.Valid {
						ap = aList[i].pos.Int64
					}
					bp := int64(9999)
					if aList[j].pos.Valid {
						bp = aList[j].pos.Int64
					}
					if ap != bp {
						return ap < bp
					}
					return aList[i].name < aList[j].name
				})
				var aNames []string
				for _, a := range aList {
					if a.name != "" {
						aNames = append(aNames, a.name)
					}
				}
				var subtitle *string
				if len(aNames) > 0 {
					sub := strings.Join(aNames, ", ")
					subtitle = &sub
				}

				isbnIdents := make([]IdentifierInput, 0)
				for _, ident := range identsByBook[b.id] {
					if strings.Contains(strings.ToLower(ident.Type), "isbn") {
						isbnIdents = append(isbnIdents, ident)
					}
				}
				sort.Slice(isbnIdents, func(i, j int) bool {
					at := strings.ToLower(isbnIdents[i].Type)
					bt := strings.ToLower(isbnIdents[j].Type)
					if at != bt {
						return at < bt
					}
					return isbnIdents[i].Value < isbnIdents[j].Value
				})
				if len(isbnIdents) > 4 {
					isbnIdents = isbnIdents[:4]
				}

				var coverThumbURL *string
				if b.cover.Valid && b.cover.String != "" {
					ms := b.updatedAt * 1000
					u := storage.BuildBookCoverURL(b.id, &ms, "thumb")
					coverThumbURL = &u
				}

				booksBucket = append(booksBucket, map[string]any{
					"id":                b.id,
					"title":             b.title,
					"subtitle":          subtitle,
					"identifiers":       isbnIdents,
					"published":         nullStringPtr(b.published),
					"coverImagePath":    nullStringPtr(b.cover),
					"updatedAt":         formatUnixSecISO(b.updatedAt),
					"coverThumbnailUrl": coverThumbURL,
				})
			}
		}
	}

	// ---- Entity buckets
	searchEntityBucket := func(table, visKind string) ([]namedRef, error) {
		containsLimit := perBucketLimit * 5
		if containsLimit < 25 {
			containsLimit = 25
		}
		vis := visibleEntitySQL(visKind)
		var rowsAll []namedRef
		for _, pair := range []struct {
			pat string
			lim int
		}{
			{prefix, perBucketLimit},
			{contains, containsLimit},
		} {
			rows, err := s.db.QueryContext(r.Context(), `
				SELECT id, name FROM `+table+`
				WHERE name LIKE ? ESCAPE '\' AND `+vis+`
				LIMIT ?
			`, pair.pat, userID, pair.lim)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var ref namedRef
				if err := rows.Scan(&ref.ID, &ref.Name); err != nil {
					_ = rows.Close()
					return nil, err
				}
				rowsAll = append(rowsAll, ref)
			}
			_ = rows.Close()
		}
		return rankNamedRefs(rowsAll, raw, perBucketLimit), nil
	}

	authorsBucket, err := searchEntityBucket("authors", "author")
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/search authors failed", "Failed to search", err)
		return
	}
	seriesBucket, err := searchEntityBucket("series", "series")
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/search series failed", "Failed to search", err)
		return
	}
	publishersBucket, err := searchEntityBucket("publishers", "publisher")
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/search publishers failed", "Failed to search", err)
		return
	}
	genresBucket, err := searchEntityBucket("genres", "genre")
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/search genres failed", "Failed to search", err)
		return
	}
	tagsBucket, err := searchEntityBucket("tags", "tag")
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/search tags failed", "Failed to search", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"q":              raw,
			"perBucketLimit": perBucketLimit,
			"buckets": map[string]any{
				"books":      booksBucket,
				"authors":    authorsBucket,
				"series":     seriesBucket,
				"publishers": publishersBucket,
				"genres":     genresBucket,
				"tags":       tagsBucket,
			},
		},
	})
}
