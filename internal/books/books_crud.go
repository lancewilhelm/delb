package books

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

type bookRow struct {
	ID               string
	CollectionID     string
	AddedByUserID    sql.NullString
	AddedAt          int64
	Title            string
	SortTitle        string
	CalibreBookID    sql.NullInt64
	Description      sql.NullString
	Published        sql.NullString
	PublishedAt      sql.NullInt64
	Language         sql.NullString
	HasPhysicalCopy  int64
	HasAudiobookCopy int64
	Pages            sql.NullInt64
	CoverImagePath   sql.NullString
	PublisherID      sql.NullString
	SeriesID         sql.NullString
	SeriesIndex      sql.NullFloat64
	CreatedByUserID  sql.NullString
	CreatedAt        int64
	UpdatedAt        int64
}

const bookSelectColumns = `
	b.id, b.collection_id, b.added_by_user_id, b.added_at,
	b.title, b.sort_title, b.calibre_book_id, b.description,
	b.published, b.published_at, b.language, b.has_physical_copy,
	b.has_audiobook_copy, b.pages, b.cover_image_path, b.publisher_id,
	b.series_id, b.series_index, b.created_by_user_id, b.created_at, b.updated_at
`

func scanBookRow(scanner interface{ Scan(dest ...any) error }) (bookRow, error) {
	var b bookRow
	err := scanner.Scan(
		&b.ID, &b.CollectionID, &b.AddedByUserID, &b.AddedAt,
		&b.Title, &b.SortTitle, &b.CalibreBookID, &b.Description,
		&b.Published, &b.PublishedAt, &b.Language, &b.HasPhysicalCopy,
		&b.HasAudiobookCopy, &b.Pages, &b.CoverImagePath, &b.PublisherID,
		&b.SeriesID, &b.SeriesIndex, &b.CreatedByUserID, &b.CreatedAt, &b.UpdatedAt,
	)
	return b, err
}

type namedRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type seriesDetailRef struct {
	ID    string   `json:"id"`
	Name  string   `json:"name"`
	Index *float64 `json:"index"`
}

type authorDetailRef struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Position *int64 `json:"position"`
}

type bookFileDTO struct {
	ID           string `json:"id"`
	BookID       string `json:"bookId"`
	Format       string `json:"format"`
	RelativePath string `json:"relativePath"`
	CreatedAt    string `json:"createdAt"`
}

type bookBaseJSON struct {
	ID               string   `json:"id"`
	CollectionID     string   `json:"collectionId"`
	AddedByUserID    *string  `json:"addedByUserId"`
	AddedAt          string   `json:"addedAt"`
	Title            string   `json:"title"`
	SortTitle        string   `json:"sortTitle"`
	CalibreBookID    *int64   `json:"calibreBookId"`
	Description      *string  `json:"description"`
	Published        *string  `json:"published"`
	PublishedAt      *string  `json:"publishedAt"`
	Language         *string  `json:"language"`
	HasPhysicalCopy  bool     `json:"hasPhysicalCopy"`
	HasAudiobookCopy bool     `json:"hasAudiobookCopy"`
	Pages            *int64   `json:"pages"`
	CoverImagePath   *string  `json:"coverImagePath"`
	PublisherID      *string  `json:"publisherId"`
	SeriesID         *string  `json:"seriesId"`
	SeriesIndex      *float64 `json:"seriesIndex"`
	CreatedByUserID  *string  `json:"createdByUserId"`
	CreatedAt        string   `json:"createdAt"`
	UpdatedAt        string   `json:"updatedAt"`
}

func (b bookRow) toBaseJSON() bookBaseJSON {
	return bookBaseJSON{
		ID:               b.ID,
		CollectionID:     b.CollectionID,
		AddedByUserID:    nullStringPtr(b.AddedByUserID),
		AddedAt:          formatUnixSecISO(b.AddedAt),
		Title:            b.Title,
		SortTitle:        b.SortTitle,
		CalibreBookID:    nullInt64Ptr(b.CalibreBookID),
		Description:      nullStringPtr(b.Description),
		Published:        nullStringPtr(b.Published),
		PublishedAt:      formatNullUnixSecISO(b.PublishedAt),
		Language:         nullStringPtr(b.Language),
		HasPhysicalCopy:  b.HasPhysicalCopy != 0,
		HasAudiobookCopy: b.HasAudiobookCopy != 0,
		Pages:            nullInt64Ptr(b.Pages),
		CoverImagePath:   nullStringPtr(b.CoverImagePath),
		PublisherID:      nullStringPtr(b.PublisherID),
		SeriesID:         nullStringPtr(b.SeriesID),
		SeriesIndex:      nullFloat64Ptr(b.SeriesIndex),
		CreatedByUserID:  nullStringPtr(b.CreatedByUserID),
		CreatedAt:        formatUnixSecISO(b.CreatedAt),
		UpdatedAt:        formatUnixSecISO(b.UpdatedAt),
	}
}

type bookListItemJSON struct {
	bookBaseJSON
	Author      string     `json:"author,omitempty"`
	AuthorNames []string   `json:"authorNames"`
	Authors     []namedRef `json:"authors"`
	Publisher   *namedRef  `json:"publisher"`
	Series      *namedRef  `json:"series"`
}

type enrichedBookListItemJSON struct {
	bookListItemJSON
	SpineRevision *string           `json:"spineRevision"`
	Tags          []namedRef        `json:"tags"`
	Identifiers   []IdentifierInput `json:"identifiers"`
	Formats       []string          `json:"formats"`
	Rating        *int              `json:"rating"`
	Status        *string           `json:"status"`
}

func attachBookListRelations(ctx context.Context, db *sql.DB, page []bookRow) ([]bookListItemJSON, error) {
	if len(page) == 0 {
		return make([]bookListItemJSON, 0), nil
	}
	bookIDs := make([]string, len(page))
	pubSet := make(map[string]struct{})
	serSet := make(map[string]struct{})
	for i, b := range page {
		bookIDs[i] = b.ID
		if b.PublisherID.Valid && b.PublisherID.String != "" {
			pubSet[b.PublisherID.String] = struct{}{}
		}
		if b.SeriesID.Valid && b.SeriesID.String != "" {
			serSet[b.SeriesID.String] = struct{}{}
		}
	}

	type aLink struct {
		bookID   string
		authorID string
		position sql.NullInt64
	}
	bPh := makePlaceholders(len(bookIDs))
	bArgs := make([]any, len(bookIDs))
	for i, id := range bookIDs {
		bArgs[i] = id
	}

	alRows, err := db.QueryContext(ctx, `
		SELECT book_id, author_id, position FROM book_authors WHERE book_id IN (`+bPh+`)
	`, bArgs...)
	if err != nil {
		return nil, err
	}
	linksByBook := make(map[string][]aLink)
	authorSet := make(map[string]struct{})
	for alRows.Next() {
		var l aLink
		if err := alRows.Scan(&l.bookID, &l.authorID, &l.position); err != nil {
			_ = alRows.Close()
			return nil, err
		}
		linksByBook[l.bookID] = append(linksByBook[l.bookID], l)
		if l.authorID != "" {
			authorSet[l.authorID] = struct{}{}
		}
	}
	if err := alRows.Close(); err != nil {
		return nil, err
	}

	authorNameByID := make(map[string]string, len(authorSet))
	if len(authorSet) > 0 {
		aIDs := make([]any, 0, len(authorSet))
		for id := range authorSet {
			aIDs = append(aIDs, id)
		}
		rows, err := db.QueryContext(ctx, `SELECT id, name FROM authors WHERE id IN (`+makePlaceholders(len(aIDs))+`)`, aIDs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, name string
			if err := rows.Scan(&id, &name); err != nil {
				_ = rows.Close()
				return nil, err
			}
			authorNameByID[id] = name
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	publisherByID := make(map[string]namedRef, len(pubSet))
	if len(pubSet) > 0 {
		pIDs := make([]any, 0, len(pubSet))
		for id := range pubSet {
			pIDs = append(pIDs, id)
		}
		rows, err := db.QueryContext(ctx, `SELECT id, name FROM publishers WHERE id IN (`+makePlaceholders(len(pIDs))+`)`, pIDs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var r namedRef
			if err := rows.Scan(&r.ID, &r.Name); err != nil {
				_ = rows.Close()
				return nil, err
			}
			publisherByID[r.ID] = r
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	seriesByID := make(map[string]namedRef, len(serSet))
	if len(serSet) > 0 {
		sIDs := make([]any, 0, len(serSet))
		for id := range serSet {
			sIDs = append(sIDs, id)
		}
		rows, err := db.QueryContext(ctx, `SELECT id, name FROM series WHERE id IN (`+makePlaceholders(len(sIDs))+`)`, sIDs...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var r namedRef
			if err := rows.Scan(&r.ID, &r.Name); err != nil {
				_ = rows.Close()
				return nil, err
			}
			seriesByID[r.ID] = r
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}

	out := make([]bookListItemJSON, len(page))
	for i, b := range page {
		links := append([]aLink(nil), linksByBook[b.ID]...)
		sort.SliceStable(links, func(a, c int) bool {
			ap := int64(10000)
			if links[a].position.Valid {
				ap = links[a].position.Int64
			}
			cp := int64(10000)
			if links[c].position.Valid {
				cp = links[c].position.Int64
			}
			return ap < cp
		})
		authorNames := make([]string, 0, len(links))
		authorsOut := make([]namedRef, 0, len(links))
		for _, l := range links {
			name, ok := authorNameByID[l.authorID]
			if !ok || name == "" {
				continue
			}
			authorNames = append(authorNames, name)
			authorsOut = append(authorsOut, namedRef{ID: l.authorID, Name: name})
		}
		var primaryAuthor string
		if len(authorNames) > 0 {
			primaryAuthor = authorNames[0]
		}
		var pubPtr *namedRef
		if b.PublisherID.Valid {
			if p, ok := publisherByID[b.PublisherID.String]; ok {
				cp := p
				pubPtr = &cp
			}
		}
		var serPtr *namedRef
		if b.SeriesID.Valid {
			if s, ok := seriesByID[b.SeriesID.String]; ok {
				cp := s
				serPtr = &cp
			}
		}
		out[i] = bookListItemJSON{
			bookBaseJSON: b.toBaseJSON(),
			Author:       primaryAuthor,
			AuthorNames:  authorNames,
			Authors:      authorsOut,
			Publisher:    pubPtr,
			Series:       serPtr,
		}
	}
	return out, nil
}

func enrichBookViewPage(ctx context.Context, db *sql.DB, items []bookListItemJSON, userID string) ([]enrichedBookListItemJSON, error) {
	if len(items) == 0 {
		return make([]enrichedBookListItemJSON, 0), nil
	}
	ids := make([]string, len(items))
	args := make([]any, len(items))
	for i, it := range items {
		ids[i] = it.ID
		args[i] = it.ID
	}
	ph := makePlaceholders(len(ids))

	// Tags
	tagsByBook := make(map[string][]namedRef)
	tRows, err := db.QueryContext(ctx, `
		SELECT bt.book_id, t.id, t.name
		FROM book_tags bt
		INNER JOIN tags t ON t.id = bt.tag_id
		WHERE bt.book_id IN (`+ph+`)
		ORDER BY t.name ASC, t.id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	for tRows.Next() {
		var bid string
		var ref namedRef
		if err := tRows.Scan(&bid, &ref.ID, &ref.Name); err != nil {
			_ = tRows.Close()
			return nil, err
		}
		tagsByBook[bid] = append(tagsByBook[bid], ref)
	}
	if err := tRows.Close(); err != nil {
		return nil, err
	}

	// Identifiers
	identsByBook := make(map[string][]IdentifierInput)
	iRows, err := db.QueryContext(ctx, `
		SELECT book_id, type, value
		FROM book_identifiers
		WHERE book_id IN (`+ph+`)
		ORDER BY type ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	for iRows.Next() {
		var bid string
		var ident IdentifierInput
		if err := iRows.Scan(&bid, &ident.Type, &ident.Value); err != nil {
			_ = iRows.Close()
			return nil, err
		}
		identsByBook[bid] = append(identsByBook[bid], ident)
	}
	if err := iRows.Close(); err != nil {
		return nil, err
	}

	// Formats
	formatsByBook := make(map[string][]string)
	fRows, err := db.QueryContext(ctx, `
		SELECT book_id, format
		FROM book_files
		WHERE book_id IN (`+ph+`)
		ORDER BY format ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	for fRows.Next() {
		var bid, fmtStr string
		if err := fRows.Scan(&bid, &fmtStr); err != nil {
			_ = fRows.Close()
			return nil, err
		}
		formatsByBook[bid] = append(formatsByBook[bid], strings.ToLower(fmtStr))
	}
	if err := fRows.Close(); err != nil {
		return nil, err
	}

	// Ratings for userId
	userArgs := append(append([]any(nil), args...), userID)
	ratingsByBook := make(map[string]int)
	rRows, err := db.QueryContext(ctx, `
		SELECT book_id, rating FROM book_ratings WHERE book_id IN (`+ph+`) AND user_id = ?
	`, userArgs...)
	if err != nil {
		return nil, err
	}
	for rRows.Next() {
		var bid string
		var rating int
		if err := rRows.Scan(&bid, &rating); err != nil {
			_ = rRows.Close()
			return nil, err
		}
		ratingsByBook[bid] = rating
	}
	if err := rRows.Close(); err != nil {
		return nil, err
	}

	// Statuses for userId
	statusByBook := make(map[string]string)
	stRows, err := db.QueryContext(ctx, `
		SELECT book_id, status FROM user_book_status WHERE book_id IN (`+ph+`) AND user_id = ?
	`, userArgs...)
	if err != nil {
		return nil, err
	}
	for stRows.Next() {
		var bid, st string
		if err := stRows.Scan(&bid, &st); err != nil {
			_ = stRows.Close()
			return nil, err
		}
		statusByBook[bid] = st
	}
	if err := stRows.Close(); err != nil {
		return nil, err
	}

	// Spines
	spineByBook := make(map[string]string)
	spRows, err := db.QueryContext(ctx, `
		SELECT book_id, revision FROM book_spines WHERE book_id IN (`+ph+`)
	`, args...)
	if err != nil {
		return nil, err
	}
	for spRows.Next() {
		var bid, rev string
		if err := spRows.Scan(&bid, &rev); err != nil {
			_ = spRows.Close()
			return nil, err
		}
		spineByBook[bid] = rev
	}
	if err := spRows.Close(); err != nil {
		return nil, err
	}

	out := make([]enrichedBookListItemJSON, len(items))
	for i, item := range items {
		tags := tagsByBook[item.ID]
		if tags == nil {
			tags = make([]namedRef, 0)
		}
		idents := identsByBook[item.ID]
		if idents == nil {
			idents = make([]IdentifierInput, 0)
		}
		formats := dedupeStrings(formatsByBook[item.ID])
		var spinePtr *string
		if rev, ok := spineByBook[item.ID]; ok {
			r := rev
			spinePtr = &r
		}
		var ratingPtr *int
		if r, ok := ratingsByBook[item.ID]; ok {
			val := r
			ratingPtr = &val
		}
		var statusPtr *string
		if st, ok := statusByBook[item.ID]; ok {
			val := st
			statusPtr = &val
		}
		out[i] = enrichedBookListItemJSON{
			bookListItemJSON: item,
			SpineRevision:    spinePtr,
			Tags:             tags,
			Identifiers:      idents,
			Formats:          formats,
			Rating:           ratingPtr,
			Status:           statusPtr,
		}
	}
	return out, nil
}

var ymdStrictRe = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
var nonAlnumRe = regexp.MustCompile(`[^0-9A-Za-z]`)

func parseYMDLocalBounds(raw string, endOfDay bool) *int64 {
	v := strings.TrimSpace(raw)
	if v == "" {
		return nil
	}
	m := ymdStrictRe.FindStringSubmatch(v)
	if m == nil {
		return nil
	}
	y, err1 := strconv.Atoi(m[1])
	mo, err2 := strconv.Atoi(m[2])
	d, err3 := strconv.Atoi(m[3])
	if err1 != nil || err2 != nil || err3 != nil || mo < 1 || mo > 12 || d < 1 || d > 31 {
		return nil
	}
	var dt time.Time
	if endOfDay {
		dt = time.Date(y, time.Month(mo), d, 23, 59, 59, 999000000, time.Local)
	} else {
		dt = time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.Local)
	}
	sec := dt.Unix()
	return &sec
}

func parseCopyFilterParam(raw, field string) (*int, error) {
	if raw == "" || raw == "any" {
		return nil, nil
	}
	if raw == "marked" {
		v := 1
		return &v, nil
	}
	if raw == "unmarked" {
		v := 0
		return &v, nil
	}
	return nil, httpapi.NewError(http.StatusBadRequest, "Invalid "+field+" copy filter")
}

func parseStatusFilterParam(raw string) (statuses []string, includeNone bool, err error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return nil, false, nil
	}
	seen := make(map[string]struct{})
	for _, p := range strings.Split(v, ",") {
		tok := strings.TrimSpace(p)
		if tok == "" {
			continue
		}
		if _, dup := seen[tok]; dup {
			continue
		}
		seen[tok] = struct{}{}
		if tok == "none" {
			includeNone = true
			continue
		}
		if isValidBookStatus(tok) {
			statuses = append(statuses, tok)
			continue
		}
		return nil, false, httpapi.NewError(http.StatusBadRequest, "Invalid status filter. Expected one of: "+strings.Join(userBookStatuses, ", ")+", none")
	}
	return statuses, includeNone, nil
}

// GET /api/books
func (s *Service) handleListBooks(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	q := r.URL.Query()

	collectionID := q.Get("collectionId")
	idsOnly := q.Get("idsOnly") == "1"
	maxLimit := 200
	if idsOnly {
		maxLimit = 20000
	}
	limit := clampIntQuery(q.Get("limit"), 1, maxLimit, 48)
	sortKey := NormalizeSortKey(q.Get("sort"))
	sortDir := NormalizeSortDir(q.Get("sortDir"), sortKey)
	cursor := DecodeCursor(q.Get("cursor"))

	statuses, includeNone, err := parseStatusFilterParam(q.Get("status"))
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	filesFilter := strings.ToLower(strings.TrimSpace(q.Get("files")))
	if filesFilter != "" && filesFilter != "has" && filesFilter != "none" {
		httpapi.WriteError(w, http.StatusBadRequest, "Invalid files filter. Expected one of: has, none")
		return
	}

	physicalFilter, err := parseCopyFilterParam(q.Get("physical"), "physical")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	audiobookFilter, err := parseCopyFilterParam(q.Get("audiobook"), "audiobook")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	title := strings.TrimSpace(q.Get("title"))
	search := strings.TrimSpace(q.Get("search"))
	shelfID := q.Get("shelfId")
	identNeedle := strings.ToUpper(nonAlnumRe.ReplaceAllString(search, ""))

	addedStartSec := parseYMDLocalBounds(q.Get("addedStart"), false)
	addedEndSec := parseYMDLocalBounds(q.Get("addedEnd"), true)
	finishedStartSec := parseYMDLocalBounds(q.Get("finishedStart"), false)
	finishedEndSec := parseYMDLocalBounds(q.Get("finishedEnd"), true)

	if shelfID != "" {
		var existing string
		err := s.db.QueryRowContext(r.Context(), `
			SELECT id FROM personal_shelves WHERE id = ? AND owner_id = ? LIMIT 1
		`, shelfID, userID).Scan(&existing)
		if errors.Is(err, sql.ErrNoRows) {
			httpapi.WriteError(w, http.StatusNotFound, "Shelf not found")
			return
		}
		if err != nil {
			s.writeErrWithFallback(w, "GET /api/books shelf check failed", "Failed to fetch books", err)
			return
		}
	}

	memberCollectionIDs, err := getUserMemberCollectionIDs(r.Context(), s.db, userID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books memberships failed", "Failed to fetch books", err)
		return
	}
	if len(memberCollectionIDs) == 0 {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"books": []any{}, "nextCursor": nil},
		})
		return
	}

	var targetCollectionIDs []string
	if collectionID != "" {
		for _, cid := range memberCollectionIDs {
			if cid == collectionID {
				targetCollectionIDs = []string{collectionID}
				break
			}
		}
	} else {
		targetCollectionIDs = memberCollectionIDs
	}
	if len(targetCollectionIDs) == 0 {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"books": []any{}, "nextCursor": nil},
		})
		return
	}

	ordering := BuildBookSort(sortKey, sortDir, cursor)

	hasStatusFilter := includeNone || len(statuses) > 0
	var joins strings.Builder
	joins.WriteString(" INNER JOIN collection_books cb ON cb.book_id = b.id ")
	args := make([]any, 0, len(targetCollectionIDs)+8)

	if hasStatusFilter {
		joins.WriteString(" LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ? ")
		args = append(args, userID)
	}
	hasFinishedFilter := finishedStartSec != nil || finishedEndSec != nil
	if sortKey == SortDateFinished || hasFinishedFilter {
		joins.WriteString(FinishedJoinSQL)
		args = append(args, userID)
	}

	where := make([]string, 0, 12)
	where = append(where, "cb.collection_id IN ("+makePlaceholders(len(targetCollectionIDs))+")")
	for _, cid := range targetCollectionIDs {
		args = append(args, cid)
	}
	if ordering.WhereSQL != "" {
		where = append(where, ordering.WhereSQL)
		args = append(args, ordering.WhereArgs...)
	}
	if physicalFilter != nil {
		where = append(where, "b.has_physical_copy = ?")
		args = append(args, *physicalFilter)
	}
	if audiobookFilter != nil {
		where = append(where, "b.has_audiobook_copy = ?")
		args = append(args, *audiobookFilter)
	}
	if title != "" {
		where = append(where, "b.title GLOB ?")
		args = append(args, TitleFilterGlob(title))
	}
	if shelfID != "" {
		where = append(where, "EXISTS (SELECT 1 FROM personal_shelf_books psb WHERE psb.shelf_id = ? AND psb.book_id = b.id)")
		args = append(args, shelfID)
	}
	if search != "" {
		glob := TitleFilterGlob(search)
		orParts := []string{
			"b.title GLOB ?",
			"EXISTS (SELECT 1 FROM book_authors ba INNER JOIN authors a ON a.id = ba.author_id WHERE ba.book_id = b.id AND a.name GLOB ?)",
		}
		args = append(args, glob, glob)
		if identNeedle != "" {
			orParts = append(orParts, "EXISTS (SELECT 1 FROM book_identifiers bi WHERE bi.book_id = b.id AND UPPER(REPLACE(REPLACE(bi.value, '-', ''), ' ', '')) LIKE ?)")
			args = append(args, "%"+identNeedle+"%")
		}
		where = append(where, "("+strings.Join(orParts, " OR ")+")")
	}
	if addedStartSec != nil {
		where = append(where, "CAST(b.created_at AS INTEGER) >= ?")
		args = append(args, *addedStartSec)
	}
	if addedEndSec != nil {
		where = append(where, "CAST(b.created_at AS INTEGER) <= ?")
		args = append(args, *addedEndSec)
	}
	// A finish-date range matches only finished books with a date in range.
	if finishedStartSec != nil {
		where = append(where, "fin.finished_at >= ?")
		args = append(args, *finishedStartSec)
	}
	if finishedEndSec != nil {
		where = append(where, "fin.finished_at <= ?")
		args = append(args, *finishedEndSec)
	}
	if filesFilter == "has" {
		where = append(where, "EXISTS (SELECT 1 FROM book_files bf WHERE bf.book_id = b.id)")
	} else if filesFilter == "none" {
		where = append(where, "NOT EXISTS (SELECT 1 FROM book_files bf WHERE bf.book_id = b.id)")
	}
	if hasStatusFilter {
		if includeNone && len(statuses) > 0 {
			where = append(where, "(ubs.status IN ("+makePlaceholders(len(statuses))+") OR ubs.status IS NULL)")
			for _, st := range statuses {
				args = append(args, st)
			}
		} else if includeNone {
			where = append(where, "ubs.status IS NULL")
		} else {
			where = append(where, "ubs.status IN ("+makePlaceholders(len(statuses))+")")
			for _, st := range statuses {
				args = append(args, st)
			}
		}
	}

	args = append(args, limit+1)
	sqlQuery := `SELECT ` + bookSelectColumns + ` FROM books b ` + joins.String() +
		` WHERE ` + strings.Join(where, " AND ") +
		` GROUP BY b.id ORDER BY ` + ordering.OrderSQL + ` LIMIT ?`

	rows, err := s.db.QueryContext(r.Context(), sqlQuery, args...)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books query failed", "Failed to fetch books", err)
		return
	}
	var found []bookRow
	for rows.Next() {
		b, err := scanBookRow(rows)
		if err != nil {
			_ = rows.Close()
			s.writeErrWithFallback(w, "GET /api/books scan failed", "Failed to fetch books", err)
			return
		}
		found = append(found, b)
	}
	if err := rows.Close(); err != nil {
		s.writeErrWithFallback(w, "GET /api/books close failed", "Failed to fetch books", err)
		return
	}

	hasMore := len(found) > limit
	page := found
	if hasMore {
		page = found[:limit]
	}

	var nextCursor *string
	if hasMore && len(page) > 0 {
		last := page[len(page)-1]
		nextCursor = NextBookCursor(sortKey, true, last.ID, last.CreatedAt, last.SortTitle, nullInt64Ptr(last.PublishedAt), nullInt64Ptr(last.Pages),
			finishedAtForCursor(r.Context(), s.db, sortKey, userID, last.ID))
	}

	if idsOnly {
		idOut := make([]map[string]string, len(page))
		for i, b := range page {
			idOut[i] = map[string]string{"id": b.ID}
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"books":      idOut,
				"nextCursor": nextCursor,
			},
		})
		return
	}

	if len(page) == 0 {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data":    map[string]any{"books": []any{}, "nextCursor": nil},
		})
		return
	}

	withRel, err := attachBookListRelations(r.Context(), s.db, page)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books relations failed", "Failed to fetch books", err)
		return
	}
	enriched, err := enrichBookViewPage(r.Context(), s.db, withRel, userID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books enrich failed", "Failed to fetch books", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"books":      enriched,
			"nextCursor": nextCursor,
		},
	})
}

// Field parsing helpers matching POST /api/books and PUT /api/books/:id.
type optString struct {
	set   bool
	value *string
}

func parseOptStringField(m map[string]json.RawMessage, key string) (optString, error) {
	raw, exists := m[key]
	if !exists {
		return optString{}, nil
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "null" {
		return optString{set: true, value: nil}, nil
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return optString{}, httpapi.NewError(http.StatusBadRequest, "Invalid string value")
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return optString{set: true, value: nil}, nil
	}
	return optString{set: true, value: &s}, nil
}

type optFloat struct {
	set   bool
	value *float64
}

func parseOptFloatField(m map[string]json.RawMessage, key string) (optFloat, error) {
	raw, exists := m[key]
	if !exists {
		return optFloat{}, nil
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return optFloat{set: true, value: nil}, nil
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil || math.IsNaN(f) || math.IsInf(f, 0) {
		return optFloat{}, httpapi.NewError(http.StatusBadRequest, "Invalid number value")
	}
	return optFloat{set: true, value: &f}, nil
}

type optInt struct {
	set   bool
	value *int64
}

func parseOptNonNegIntField(m map[string]json.RawMessage, key string) (optInt, error) {
	of, err := parseOptFloatField(m, key)
	if err != nil {
		return optInt{}, err
	}
	if !of.set || of.value == nil {
		return optInt{set: of.set, value: nil}, nil
	}
	f := *of.value
	if math.Trunc(f) != f || f < 0 {
		return optInt{}, httpapi.NewError(http.StatusBadRequest, "Invalid integer value")
	}
	n := int64(f)
	return optInt{set: true, value: &n}, nil
}

type optStringArray struct {
	set    bool
	values []string // nil means cleared/empty
}

func parseOptStringArrayField(m map[string]json.RawMessage, key string, dedupeLower bool) (optStringArray, error) {
	raw, exists := m[key]
	if !exists {
		return optStringArray{}, nil
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return optStringArray{set: true, values: nil}, nil
	}
	var items []any
	if err := json.Unmarshal(raw, &items); err != nil {
		return optStringArray{}, httpapi.NewError(http.StatusBadRequest, "Invalid "+key+" value")
	}
	cleaned := make([]string, 0, len(items))
	for _, it := range items {
		if str, ok := it.(string); ok {
			if norm := normalizeSpaces(str); norm != "" {
				cleaned = append(cleaned, norm)
			}
		}
	}
	if dedupeLower {
		cleaned = uniqByLower(cleaned)
	}
	if len(cleaned) == 0 {
		return optStringArray{set: true, values: nil}, nil
	}
	return optStringArray{set: true, values: cleaned}, nil
}

func parseIdentifiersString(rawOpt optString) (set bool, out []IdentifierInput) {
	if !rawOpt.set {
		return false, nil
	}
	if rawOpt.value == nil {
		return true, nil
	}
	byType := make(map[string]string)
	var order []string
	for _, line := range strings.Split(*rawOpt.value, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		idx := strings.IndexByte(line, ':')
		if idx <= 0 {
			continue
		}
		t := strings.ToLower(spacesRe.ReplaceAllString(strings.TrimSpace(line[:idx]), ""))
		v := strings.ReplaceAll(spacesRe.ReplaceAllString(strings.TrimSpace(line[idx+1:]), ""), "-", "")
		if t == "" || v == "" {
			continue
		}
		if _, exists := byType[t]; !exists {
			order = append(order, t)
		}
		byType[t] = v
	}
	out = make([]IdentifierInput, 0, len(order))
	for _, t := range order {
		out = append(out, IdentifierInput{Type: t, Value: byType[t]})
	}
	return true, out
}

func decodeBodyObject(r *http.Request) (map[string]json.RawMessage, error) {
	raw, err := httpapi.ReadBodyBounded(r, httpapi.DefaultMaxBodyBytes)
	if err != nil {
		return nil, err
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, httpapi.NewError(http.StatusBadRequest, "Missing request body")
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return nil, httpapi.NewError(http.StatusBadRequest, "Missing request body")
	}
	return m, nil
}

// parseCollectionIDsField parses optional `collectionIds` strictly matching resolveBookTarget.
func parseCollectionIDsField(m map[string]json.RawMessage) (provided bool, ids []string, err error) {
	raw, exists := m["collectionIds"]
	if !exists {
		return false, nil, nil
	}
	if strings.TrimSpace(string(raw)) == "null" {
		return true, nil, httpapi.NewError(http.StatusBadRequest, "Choose exactly one collection")
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return true, nil, httpapi.NewError(http.StatusBadRequest, "Choose exactly one collection")
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		var s string
		if err := json.Unmarshal(item, &s); err != nil || strings.TrimSpace(s) == "" {
			return true, nil, httpapi.NewError(http.StatusBadRequest, "Choose exactly one collection")
		}
		out = append(out, strings.TrimSpace(s))
	}
	return true, out, nil
}

// POST /api/books
func (s *Service) handleCreateBook(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	body, err := decodeBodyObject(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	titleOpt, err := parseOptStringField(body, "title")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if !titleOpt.set || titleOpt.value == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Title is required")
		return
	}
	title := *titleOpt.value

	authorsOpt, err := parseOptStringArrayField(body, "authors", false)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if !authorsOpt.set || len(authorsOpt.values) == 0 {
		httpapi.WriteError(w, http.StatusBadRequest, "At least one author is required")
		return
	}

	colProvided, colIDs, err := parseCollectionIDsField(body)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	collectionID, err := collections.ResolveBookTarget(r.Context(), s.db, userID, colProvided, colIDs)
	if err != nil {
		s.writeErr(w, "POST /api/books target failed", err)
		return
	}

	descOpt, err := parseOptStringField(body, "description")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	pubOpt, err := parseOptStringField(body, "published")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var publishedAt *int64
	if pubOpt.value != nil {
		publishedAt = NormalizePublishedAtUnix(*pubOpt.value)
	}
	langOpt, err := parseOptStringField(body, "language")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	pagesOpt, err := parseOptNonNegIntField(body, "pages")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	pubNameOpt, err := parseOptStringField(body, "publisherName")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	serNameOpt, err := parseOptStringField(body, "seriesName")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	serIdxOpt, err := parseOptFloatField(body, "seriesIndex")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	tagsOpt, err := parseOptStringArrayField(body, "tags", false)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	identsRawOpt, err := parseOptStringField(body, "identifiers")
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	_, idents := parseIdentifiersString(identsRawOpt)

	now := time.Now().UTC().Unix()
	bookID := uuid.NewString()

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "POST /api/books begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "POST /api/books lock failed", err)
		return
	}
	if err := collections.AssertCollectionEditor(r.Context(), tx, userID, collectionID); err != nil {
		s.writeErr(w, "POST /api/books auth failed", err)
		return
	}

	var publisherID *string
	if pubNameOpt.value != nil {
		pid, err := findOrCreatePublisherByName(r.Context(), tx, *pubNameOpt.value)
		if err != nil {
			s.writeErr(w, "POST /api/books publisher failed", err)
			return
		}
		publisherID = &pid
	}
	var seriesID *string
	if serNameOpt.value != nil {
		sid, err := findOrCreateSeriesByName(r.Context(), tx, *serNameOpt.value)
		if err != nil {
			s.writeErr(w, "POST /api/books series failed", err)
			return
		}
		seriesID = &sid
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO books (
			id, collection_id, added_by_user_id, added_at,
			title, sort_title, description, published, published_at,
			language, pages, publisher_id, series_id, series_index,
			created_by_user_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, bookID, collectionID, userID, now,
		title, MakeTitleSortKey(title), descOpt.value, pubOpt.value, publishedAt,
		langOpt.value, pagesOpt.value, publisherID, seriesID, serIdxOpt.value,
		userID, now, now); err != nil {
		s.writeErr(w, "POST /api/books insert failed", err)
		return
	}

	for pos, name := range authorsOpt.values {
		aid, err := findOrCreateAuthorByName(r.Context(), tx, name)
		if err != nil {
			s.writeErr(w, "POST /api/books author failed", err)
			return
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO book_authors (book_id, author_id, position)
			VALUES (?, ?, ?)
			ON CONFLICT(book_id, author_id) DO NOTHING
		`, bookID, aid, pos+1); err != nil {
			s.writeErr(w, "POST /api/books link author failed", err)
			return
		}
	}

	for _, name := range tagsOpt.values {
		tid, err := findOrCreateTagByName(r.Context(), tx, name)
		if err != nil {
			s.writeErr(w, "POST /api/books tag failed", err)
			return
		}
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO book_tags (book_id, tag_id)
			VALUES (?, ?)
			ON CONFLICT(book_id, tag_id) DO NOTHING
		`, bookID, tid); err != nil {
			s.writeErr(w, "POST /api/books link tag failed", err)
			return
		}
	}

	for _, ident := range idents {
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO book_identifiers (book_id, type, value)
			VALUES (?, ?, ?)
			ON CONFLICT(book_id, type) DO UPDATE SET value = excluded.value
		`, bookID, ident.Type, ident.Value); err != nil {
			s.writeErr(w, "POST /api/books link ident failed", err)
			return
		}
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "POST /api/books commit failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "book created",
		"bookId", bookID,
		"userId", userID,
		"collectionId", collectionID,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"book": map[string]any{
				"id":    bookID,
				"title": title,
			},
		},
	})
}

// GET /api/books/{id}
func (s *Service) handleGetBook(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	row := s.db.QueryRowContext(r.Context(), `
		SELECT `+bookSelectColumns+`
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID)
	book, err := scanBookRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "Book not found")
		return
	}
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id} query failed", "Failed to fetch book", err)
		return
	}

	var publisher *namedRef
	if book.PublisherID.Valid && book.PublisherID.String != "" {
		var p namedRef
		if err := s.db.QueryRowContext(r.Context(), `SELECT id, name FROM publishers WHERE id = ? LIMIT 1`, book.PublisherID.String).Scan(&p.ID, &p.Name); err == nil {
			publisher = &p
		}
	}

	var seriesOut *seriesDetailRef
	if book.SeriesID.Valid && book.SeriesID.String != "" {
		var sid, sname string
		if err := s.db.QueryRowContext(r.Context(), `SELECT id, name FROM series WHERE id = ? LIMIT 1`, book.SeriesID.String).Scan(&sid, &sname); err == nil {
			seriesOut = &seriesDetailRef{ID: sid, Name: sname, Index: nullFloat64Ptr(book.SeriesIndex)}
		}
	}

	aRows, err := s.db.QueryContext(r.Context(), `
		SELECT ba.author_id, a.name, ba.position
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id = ?
		ORDER BY ba.position ASC, a.name ASC
	`, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id} authors failed", "Failed to fetch book", err)
		return
	}
	authorsOut := make([]authorDetailRef, 0)
	for aRows.Next() {
		var aid, name string
		var pos sql.NullInt64
		if err := aRows.Scan(&aid, &name, &pos); err != nil {
			_ = aRows.Close()
			s.writeErrWithFallback(w, "GET /api/books/{id} author scan failed", "Failed to fetch book", err)
			return
		}
		authorsOut = append(authorsOut, authorDetailRef{ID: aid, Name: name, Position: nullInt64Ptr(pos)})
	}
	_ = aRows.Close()

	tRows, err := s.db.QueryContext(r.Context(), `
		SELECT bt.tag_id, t.name
		FROM book_tags bt
		INNER JOIN tags t ON t.id = bt.tag_id
		WHERE bt.book_id = ?
		ORDER BY t.name ASC
	`, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id} tags failed", "Failed to fetch book", err)
		return
	}
	tagsOut := make([]namedRef, 0)
	for tRows.Next() {
		var ref namedRef
		if err := tRows.Scan(&ref.ID, &ref.Name); err != nil {
			_ = tRows.Close()
			s.writeErrWithFallback(w, "GET /api/books/{id} tag scan failed", "Failed to fetch book", err)
			return
		}
		tagsOut = append(tagsOut, ref)
	}
	_ = tRows.Close()

	iRows, err := s.db.QueryContext(r.Context(), `
		SELECT type, value FROM book_identifiers WHERE book_id = ? ORDER BY type ASC, value ASC
	`, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id} idents failed", "Failed to fetch book", err)
		return
	}
	identsOut := make([]IdentifierInput, 0)
	for iRows.Next() {
		var ident IdentifierInput
		if err := iRows.Scan(&ident.Type, &ident.Value); err != nil {
			_ = iRows.Close()
			s.writeErrWithFallback(w, "GET /api/books/{id} ident scan failed", "Failed to fetch book", err)
			return
		}
		identsOut = append(identsOut, ident)
	}
	_ = iRows.Close()

	filesOut, err := listBookFilesDTO(r.Context(), s.db, bookID)
	if err != nil {
		s.writeErrWithFallback(w, "GET /api/books/{id} files failed", "Failed to fetch book", err)
		return
	}

	var userRating *int
	var rVal int
	if err := s.db.QueryRowContext(r.Context(), `SELECT rating FROM book_ratings WHERE book_id = ? AND user_id = ? LIMIT 1`, bookID, userID).Scan(&rVal); err == nil {
		userRating = &rVal
	}

	var (
		userStatus           *string
		userStatusStartedAt  *string
		userStatusFinishedAt *string
		userStatusDnfAt      *string
		userStatusTbrRank    *int64
	)
	var stRaw string
	var stStart, stFinish, stDnf, stRank sql.NullInt64
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT status, started_at, finished_at, dnf_at, tbr_rank
		FROM user_book_status
		WHERE book_id = ? AND user_id = ?
		LIMIT 1
	`, bookID, userID).Scan(&stRaw, &stStart, &stFinish, &stDnf, &stRank); err == nil {
		if isValidBookStatus(stRaw) {
			sVal := stRaw
			userStatus = &sVal
			userStatusStartedAt = formatNullUnixSecISO(stStart)
			userStatusFinishedAt = formatNullUnixSecISO(stFinish)
			userStatusDnfAt = formatNullUnixSecISO(stDnf)
			userStatusTbrRank = nullInt64Ptr(stRank)
		}
	}

	var progressSync int64
	userProgressSyncEnabled := false
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT progress_sync_enabled FROM user_book_preferences WHERE book_id = ? AND user_id = ? LIMIT 1
	`, bookID, userID).Scan(&progressSync); err == nil {
		userProgressSyncEnabled = progressSync != 0
	}

	var spineRevision *string
	var rev string
	if err := s.db.QueryRowContext(r.Context(), `SELECT revision FROM book_spines WHERE book_id = ? LIMIT 1`, bookID).Scan(&rev); err == nil {
		spineRevision = &rev
	}

	canEdit := false
	var role string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT role FROM collection_members WHERE collection_id = ? AND user_id = ? LIMIT 1
	`, book.CollectionID, userID).Scan(&role); err == nil {
		canEdit = role == "owner" || role == "editor"
	}

	type bookDetailJSON struct {
		bookBaseJSON
		SpineRevision           *string           `json:"spineRevision"`
		CanEdit                 bool              `json:"canEdit"`
		Publisher               *namedRef         `json:"publisher"`
		Series                  *seriesDetailRef  `json:"series"`
		Tags                    []namedRef        `json:"tags"`
		Identifiers             []IdentifierInput `json:"identifiers"`
		UserRating              *int              `json:"userRating"`
		UserStatus              *string           `json:"userStatus"`
		UserStatusStartedAt     *string           `json:"userStatusStartedAt"`
		UserStatusFinishedAt    *string           `json:"userStatusFinishedAt"`
		UserStatusDnfAt         *string           `json:"userStatusDnfAt"`
		UserStatusTbrRank       *int64            `json:"userStatusTbrRank"`
		UserProgressSyncEnabled bool              `json:"userProgressSyncEnabled"`
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"book": bookDetailJSON{
				bookBaseJSON:            book.toBaseJSON(),
				SpineRevision:           spineRevision,
				CanEdit:                 canEdit,
				Publisher:               publisher,
				Series:                  seriesOut,
				Tags:                    tagsOut,
				Identifiers:             identsOut,
				UserRating:              userRating,
				UserStatus:              userStatus,
				UserStatusStartedAt:     userStatusStartedAt,
				UserStatusFinishedAt:    userStatusFinishedAt,
				UserStatusDnfAt:         userStatusDnfAt,
				UserStatusTbrRank:       userStatusTbrRank,
				UserProgressSyncEnabled: userProgressSyncEnabled,
			},
			"authors": authorsOut,
			"files":   filesOut,
			"tags":    tagsOut,
		},
	})
}

func listBookFilesDTO(ctx context.Context, db *sql.DB, bookID string) ([]bookFileDTO, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT id, book_id, format, relative_path, created_at
		FROM book_files
		WHERE book_id = ?
	`, bookID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := make([]bookFileDTO, 0)
	for rows.Next() {
		var f bookFileDTO
		var createdSec int64
		if err := rows.Scan(&f.ID, &f.BookID, &f.Format, &f.RelativePath, &createdSec); err != nil {
			return nil, err
		}
		f.CreatedAt = formatUnixSecISO(createdSec)
		out = append(out, f)
	}
	return out, rows.Err()
}

// ComputeMetadataVersion mirrors server/utils/books/metadata-snapshot.ts metadataVersion.
func ComputeMetadataVersion(ctx context.Context, q collections.Queryable, bookID string) (string, error) {
	type bookMetaSnap struct {
		Title       string   `json:"title"`
		Description *string  `json:"description"`
		Published   *string  `json:"published"`
		Language    *string  `json:"language"`
		Pages       *int64   `json:"pages"`
		Publisher   *string  `json:"publisher"`
		Series      *string  `json:"series"`
		SeriesIndex *float64 `json:"seriesIndex"`
	}
	type nameRow struct {
		Name string `json:"name"`
	}
	type identRow struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	}
	type versionPayload struct {
		Book        bookMetaSnap `json:"book"`
		Authors     []nameRow    `json:"authors"`
		Tags        []nameRow    `json:"tags"`
		Identifiers []identRow   `json:"identifiers"`
	}

	var (
		title     string
		desc      sql.NullString
		pub       sql.NullString
		lang      sql.NullString
		pages     sql.NullInt64
		pubName   sql.NullString
		serName   sql.NullString
		serIdx    sql.NullFloat64
	)
	err := q.QueryRowContext(ctx, `
		SELECT b.title, b.description, b.published, b.language, b.pages, p.name, s.name, b.series_index
		FROM books b
		LEFT JOIN publishers p ON p.id = b.publisher_id
		LEFT JOIN series s ON s.id = b.series_id
		WHERE b.id = ?
		LIMIT 1
	`, bookID).Scan(&title, &desc, &pub, &lang, &pages, &pubName, &serName, &serIdx)
	if errors.Is(err, sql.ErrNoRows) {
		return "", httpapi.NewError(http.StatusNotFound, "Book not found.")
	}
	if err != nil {
		return "", err
	}

	authorRows, err := q.QueryContext(ctx, `
		SELECT a.name
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id = ?
		ORDER BY ba.position ASC, a.id ASC
	`, bookID)
	if err != nil {
		return "", err
	}
	authorsOut := make([]nameRow, 0)
	for authorRows.Next() {
		var n string
		if err := authorRows.Scan(&n); err != nil {
			_ = authorRows.Close()
			return "", err
		}
		authorsOut = append(authorsOut, nameRow{Name: n})
	}
	if err := authorRows.Close(); err != nil {
		return "", err
	}

	tagRows, err := q.QueryContext(ctx, `
		SELECT t.name
		FROM book_tags bt
		INNER JOIN tags t ON t.id = bt.tag_id
		WHERE bt.book_id = ?
		ORDER BY t.name ASC
	`, bookID)
	if err != nil {
		return "", err
	}
	tagsOut := make([]nameRow, 0)
	for tagRows.Next() {
		var n string
		if err := tagRows.Scan(&n); err != nil {
			_ = tagRows.Close()
			return "", err
		}
		tagsOut = append(tagsOut, nameRow{Name: n})
	}
	if err := tagRows.Close(); err != nil {
		return "", err
	}

	identRows, err := q.QueryContext(ctx, `
		SELECT type, value
		FROM book_identifiers
		WHERE book_id = ?
		ORDER BY type ASC, value ASC
	`, bookID)
	if err != nil {
		return "", err
	}
	identsOut := make([]identRow, 0)
	for identRows.Next() {
		var r identRow
		if err := identRows.Scan(&r.Type, &r.Value); err != nil {
			_ = identRows.Close()
			return "", err
		}
		identsOut = append(identsOut, r)
	}
	if err := identRows.Close(); err != nil {
		return "", err
	}

	payload := versionPayload{
		Book: bookMetaSnap{
			Title:       title,
			Description: nullStringPtr(desc),
			Published:   nullStringPtr(pub),
			Language:    nullStringPtr(lang),
			Pages:       nullInt64Ptr(pages),
			Publisher:   nullStringPtr(pubName),
			Series:      nullStringPtr(serName),
			SeriesIndex: nullFloat64Ptr(serIdx),
		},
		Authors:     authorsOut,
		Tags:        tagsOut,
		Identifiers: identsOut,
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return "", err
	}
	encoded := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

// UpdateBookMetadata updates a book's canonical metadata with optional optimistic
// concurrency (`expectedVersion`) and in-transaction authorization (`authorize`).
func (s *Service) UpdateBookMetadata(
	ctx context.Context,
	userID, bookID string,
	body map[string]json.RawMessage,
	expectedVersion string,
	authorize func(tx *sql.Tx) error,
) (bool, error) {
	var storageWarning bool
	err := storage.WithBookStorageLock(ctx, s.libraryDir, bookID, func() error {
		var prevPublisherID, prevSeriesID sql.NullString
		err := s.db.QueryRowContext(ctx, `
			SELECT b.publisher_id, b.series_id
			FROM books b
			INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
			WHERE b.id = ?
			LIMIT 1
		`, userID, bookID).Scan(&prevPublisherID, &prevSeriesID)
		if errors.Is(err, sql.ErrNoRows) {
			return httpapi.NewError(http.StatusNotFound, "Book not found")
		}
		if err != nil {
			return err
		}
		if _, err := collections.AssertBookEditor(ctx, s.db, userID, bookID); err != nil {
			return err
		}

		titleOpt, err := parseOptStringField(body, "title")
		if err != nil {
			return err
		}
		descOpt, err := parseOptStringField(body, "description")
		if err != nil {
			return err
		}
		pubOpt, err := parseOptStringField(body, "published")
		if err != nil {
			return err
		}
		langOpt, err := parseOptStringField(body, "language")
		if err != nil {
			return err
		}
		coverOpt, err := parseOptStringField(body, "coverImagePath")
		if err != nil {
			return err
		}
		pubNameOpt, err := parseOptStringField(body, "publisherName")
		if err != nil {
			return err
		}
		pubIDOpt, err := parseOptStringField(body, "publisherId")
		if err != nil {
			return err
		}
		serNameOpt, err := parseOptStringField(body, "seriesName")
		if err != nil {
			return err
		}
		serIDOpt, err := parseOptStringField(body, "seriesId")
		if err != nil {
			return err
		}
		serIdxOpt, err := parseOptFloatField(body, "seriesIndex")
		if err != nil {
			return err
		}
		pagesOpt, err := parseOptNonNegIntField(body, "pages")
		if err != nil {
			return err
		}
		tagsOpt, err := parseOptStringArrayField(body, "tags", true)
		if err != nil {
			return err
		}
		identsRawOpt, err := parseOptStringField(body, "identifiers")
		if err != nil {
			return err
		}
		hasIdentMutation, newIdents := parseIdentifiersString(identsRawOpt)

		authorSingleOpt, err := parseOptStringField(body, "author")
		if err != nil {
			return err
		}
		authorsListOpt, err := parseOptStringArrayField(body, "authors", true)
		if err != nil {
			return err
		}

		var hasAuthorMutation bool
		var newAuthors []string
		if authorsListOpt.set {
			hasAuthorMutation = true
			newAuthors = authorsListOpt.values
		} else if authorSingleOpt.set {
			hasAuthorMutation = true
			if authorSingleOpt.value != nil {
				newAuthors = []string{*authorSingleOpt.value}
			}
		}
		if hasAuthorMutation && len(newAuthors) == 0 {
			return httpapi.NewError(http.StatusBadRequest, "At least one author is required")
		}

		shouldMoveStorage := false

		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()

		if err := collections.LockCollectionChanges(ctx, tx); err != nil {
			return err
		}
		if _, err := collections.AssertBookEditor(ctx, tx, userID, bookID); err != nil {
			return err
		}
		if authorize != nil {
			if err := authorize(tx); err != nil {
				return err
			}
		}
		if expectedVersion != "" {
			curVer, err := ComputeMetadataVersion(ctx, tx, bookID)
			if err != nil {
				return err
			}
			if curVer != expectedVersion {
				return httpapi.NewError(http.StatusConflict, "Book metadata changed. Read the book again before updating it.")
			}
		}

		// Capture previous author & tag IDs for orphan cleanup.
		prevAuthorIDs, err := queryStringColumn(ctx, tx, `SELECT author_id FROM book_authors WHERE book_id = ?`, bookID)
		if err != nil {
			return err
		}
		prevTagIDs, err := queryStringColumn(ctx, tx, `SELECT tag_id FROM book_tags WHERE book_id = ?`, bookID)
		if err != nil {
			return err
		}

		setClauses := make([]string, 0, 12)
		setArgs := make([]any, 0, 14)
		now := time.Now().UTC().Unix()

		if titleOpt.set {
			if titleOpt.value == nil {
				return httpapi.NewError(http.StatusBadRequest, "Title is required")
			}
			setClauses = append(setClauses, "title = ?", "sort_title = ?")
			setArgs = append(setArgs, *titleOpt.value, MakeTitleSortKey(*titleOpt.value))
			shouldMoveStorage = true
		}
		if descOpt.set {
			setClauses = append(setClauses, "description = ?")
			setArgs = append(setArgs, descOpt.value)
		}
		if pubOpt.set {
			var pubAt *int64
			if pubOpt.value != nil {
				pubAt = NormalizePublishedAtUnix(*pubOpt.value)
			}
			setClauses = append(setClauses, "published = ?", "published_at = ?")
			setArgs = append(setArgs, pubOpt.value, pubAt)
		}
		if langOpt.set {
			setClauses = append(setClauses, "language = ?")
			setArgs = append(setArgs, langOpt.value)
		}
		if coverOpt.set {
			setClauses = append(setClauses, "cover_image_path = ?")
			setArgs = append(setArgs, coverOpt.value)
		}

		var newPublisherID *string
		publisherMutated := false
		if pubNameOpt.set {
			publisherMutated = true
			if pubNameOpt.value != nil {
				pid, err := findOrCreatePublisherByName(ctx, tx, *pubNameOpt.value)
				if err != nil {
					return err
				}
				newPublisherID = &pid
			}
			setClauses = append(setClauses, "publisher_id = ?")
			setArgs = append(setArgs, newPublisherID)
		} else if pubIDOpt.set {
			publisherMutated = true
			newPublisherID = pubIDOpt.value
			setClauses = append(setClauses, "publisher_id = ?")
			setArgs = append(setArgs, newPublisherID)
		}

		var newSeriesID *string
		seriesMutated := false
		if serNameOpt.set {
			seriesMutated = true
			if serNameOpt.value != nil {
				sid, err := findOrCreateSeriesByName(ctx, tx, *serNameOpt.value)
				if err != nil {
					return err
				}
				newSeriesID = &sid
			}
			setClauses = append(setClauses, "series_id = ?")
			setArgs = append(setArgs, newSeriesID)
		} else if serIDOpt.set {
			seriesMutated = true
			newSeriesID = serIDOpt.value
			setClauses = append(setClauses, "series_id = ?")
			setArgs = append(setArgs, newSeriesID)
		}

		if serIdxOpt.set {
			setClauses = append(setClauses, "series_index = ?")
			setArgs = append(setArgs, serIdxOpt.value)
		}
		if pagesOpt.set {
			setClauses = append(setClauses, "pages = ?")
			setArgs = append(setArgs, pagesOpt.value)
		}

		if len(setClauses) == 0 && !hasAuthorMutation && !tagsOpt.set && !hasIdentMutation {
			return httpapi.NewError(http.StatusBadRequest, "No updatable fields provided")
		}

		if len(setClauses) > 0 {
			setClauses = append(setClauses, "updated_at = ?")
			setArgs = append(setArgs, now, bookID)
			if _, err := tx.ExecContext(ctx, `
				UPDATE books SET `+strings.Join(setClauses, ", ")+` WHERE id = ?
			`, setArgs...); err != nil {
				return err
			}
		}

		if hasAuthorMutation {
			if _, err := tx.ExecContext(ctx, `DELETE FROM book_authors WHERE book_id = ?`, bookID); err != nil {
				return err
			}
			currentAuthorIDs := make(map[string]struct{}, len(newAuthors))
			for i, name := range newAuthors {
				aid, err := findOrCreateAuthorByName(ctx, tx, name)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)
				`, bookID, aid, i+1); err != nil {
					return err
				}
				currentAuthorIDs[aid] = struct{}{}
			}
			shouldMoveStorage = true
			for _, oldID := range dedupeStrings(prevAuthorIDs) {
				if _, kept := currentAuthorIDs[oldID]; !kept {
					if err := deleteAuthorIfUnreferenced(ctx, tx, oldID); err != nil {
						return err
					}
				}
			}
		}

		if tagsOpt.set {
			if _, err := tx.ExecContext(ctx, `DELETE FROM book_tags WHERE book_id = ?`, bookID); err != nil {
				return err
			}
			currentTagIDs := make(map[string]struct{}, len(tagsOpt.values))
			for _, name := range tagsOpt.values {
				tid, err := findOrCreateTagByName(ctx, tx, name)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?)
				`, bookID, tid); err != nil {
					return err
				}
				currentTagIDs[tid] = struct{}{}
			}
			for _, oldID := range dedupeStrings(prevTagIDs) {
				if _, kept := currentTagIDs[oldID]; !kept {
					if err := deleteTagIfUnreferenced(ctx, tx, oldID); err != nil {
						return err
					}
				}
			}
		}

		if hasIdentMutation {
			if _, err := tx.ExecContext(ctx, `DELETE FROM book_identifiers WHERE book_id = ?`, bookID); err != nil {
				return err
			}
			for _, ident := range newIdents {
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO book_identifiers (book_id, type, value)
					VALUES (?, ?, ?)
					ON CONFLICT(book_id, type) DO UPDATE SET value = excluded.value
				`, bookID, ident.Type, ident.Value); err != nil {
					return err
				}
			}
		}

		if publisherMutated && prevPublisherID.Valid && prevPublisherID.String != "" && (newPublisherID == nil || *newPublisherID != prevPublisherID.String) {
			if err := deletePublisherIfUnreferenced(ctx, tx, prevPublisherID.String); err != nil {
				return err
			}
		}
		if seriesMutated && prevSeriesID.Valid && prevSeriesID.String != "" && (newSeriesID == nil || *newSeriesID != prevSeriesID.String) {
			if err := deleteSeriesIfUnreferenced(ctx, tx, prevSeriesID.String); err != nil {
				return err
			}
		}

		if err := tx.Commit(); err != nil {
			return err
		}

		if shouldMoveStorage {
			if _, moveErr := storage.MoveBookStorageToCanonical(ctx, s.db, s.libraryDir, bookID, func(tx *sql.Tx) error {
				if err := collections.LockCollectionChanges(ctx, tx); err != nil {
					return err
				}
				if _, err := collections.AssertBookEditor(ctx, tx, userID, bookID); err != nil {
					return err
				}
				if authorize != nil {
					return authorize(tx)
				}
				return nil
			}); moveErr != nil {
				storageWarning = true
				s.logger.Warn("PUT /api/books/{id}: failed to move book storage to canonical path", "bookId", bookID, "error", moveErr)
			}
		}
		return nil
	})
	return storageWarning, err
}

// PUT /api/books/{id}
func (s *Service) handleUpdateBook(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	body, err := decodeBodyObject(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	storageWarning, err := s.UpdateBookMetadata(r.Context(), userID, bookID, body, "", nil)
	if err != nil {
		s.writeErrWithFallback(w, "PUT /api/books/{id} failed", "Failed to update book", err)
		return
	}

	if storageWarning {
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "storageWarning": true})
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true})
}

func queryStringColumn(ctx context.Context, q collections.Queryable, query string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []string
	for rows.Next() {
		var val string
		if err := rows.Scan(&val); err != nil {
			return nil, err
		}
		if val != "" {
			out = append(out, val)
		}
	}
	return out, rows.Err()
}

// DELETE /api/books/{id}
func (s *Service) handleDeleteBook(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	bookID := r.PathValue("id")
	if bookID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing book id")
		return
	}

	mode := strings.TrimSpace(r.URL.Query().Get("mode"))
	if mode != "db_only" && mode != "everything" {
		mode = "everything"
	}

	err := storage.WithBookStorageLock(r.Context(), s.libraryDir, bookID, func() error {
		var coverImagePath sql.NullString
		err := s.db.QueryRowContext(r.Context(), `SELECT cover_image_path FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&coverImagePath)
		if errors.Is(err, sql.ErrNoRows) {
			return httpapi.NewError(http.StatusNotFound, "Book not found")
		}
		if err != nil {
			return err
		}
		if _, err := collections.AssertBookEditor(r.Context(), s.db, userID, bookID); err != nil {
			return err
		}

		filePaths, err := queryStringColumn(r.Context(), s.db, `SELECT relative_path FROM book_files WHERE book_id = ?`, bookID)
		if err != nil {
			return err
		}

		var sources []string
		if mode == "everything" {
			candidates := append([]string(nil), filePaths...)
			if coverImagePath.Valid && coverImagePath.String != "" {
				candidates = append(candidates, coverImagePath.String)
			}
			for _, stored := range dedupeStrings(candidates) {
				if stored == "" {
					continue
				}
				var dummy string
				err1 := s.db.QueryRowContext(r.Context(), `SELECT id FROM book_files WHERE relative_path = ? AND book_id != ? LIMIT 1`, stored, bookID).Scan(&dummy)
				if err1 == nil {
					continue
				}
				err2 := s.db.QueryRowContext(r.Context(), `SELECT id FROM books WHERE cover_image_path = ? AND id != ? LIMIT 1`, stored, bookID).Scan(&dummy)
				if err2 == nil {
					continue
				}
				absFile, rerr := storage.ResolveUnderLibrary(s.libraryDir, stored)
				if rerr != nil {
					return rerr
				}
				if _, serr := os.Stat(absFile); serr == nil {
					sources = append(sources, absFile)
				} else if !errors.Is(serr, os.ErrNotExist) {
					return serr
				}
			}
		}

		commitDB := func(operationID string) error {
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
			if operationID != "" {
				if _, err := tx.ExecContext(r.Context(), `
					INSERT INTO storage_operations (id, book_id, kind, created_at)
					VALUES (?, ?, 'delete', ?)
				`, operationID, bookID, time.Now().UTC().Unix()); err != nil {
					return err
				}
			}
			deleteQueries := []string{
				`DELETE FROM book_spines WHERE book_id = ?`,
				`DELETE FROM personal_shelf_books WHERE book_id = ?`,
				`DELETE FROM book_files WHERE book_id = ?`,
				`DELETE FROM book_authors WHERE book_id = ?`,
				`DELETE FROM book_tags WHERE book_id = ?`,
				`DELETE FROM book_identifiers WHERE book_id = ?`,
				`DELETE FROM user_book_status WHERE book_id = ?`,
				`DELETE FROM book_ratings WHERE book_id = ?`,
				`DELETE FROM book_notes WHERE book_id = ?`,
				`DELETE FROM user_book_reviews WHERE book_id = ?`,
				`DELETE FROM user_book_rationale WHERE book_id = ?`,
				`DELETE FROM books WHERE id = ?`,
			}
			for _, q := range deleteQueries {
				if _, err := tx.ExecContext(r.Context(), q, bookID); err != nil {
					return err
				}
			}
			return tx.Commit()
		}

		if mode == "everything" {
			if err := os.MkdirAll(s.libraryDir, 0o755); err != nil {
				return err
			}
			return storage.DeleteStoredFiles(r.Context(), s.libraryDir, bookID, sources, storage.DBDeleteDecision(s.db), commitDB)
		}
		return commitDB("")
	})
	if err != nil {
		s.writeErrWithFallback(w, "DELETE /api/books/{id} failed", "Internal server error", err)
		return
	}

	s.logger.InfoContext(r.Context(), "book deleted",
		"bookId", bookID,
		"userId", userID,
		"mode", mode,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    map[string]string{"mode": mode},
	})
}
