package mcp

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
)

type mcpLibraryAccess struct {
	Role                 string `json:"role"`
	CanEditCatalog       bool   `json:"canEditCatalog"`
	RestrictedByTagRules bool   `json:"restrictedByTagRules"`
	ConnectionCanWrite   bool   `json:"connectionCanWrite"`
	ConnectionCanEdit    bool   `json:"connectionCanEditMetadata"`
}

// libraryAccess reports the signed-in account's server role and whether tag
// visibility rules hide part of the library from it.
func (s *Service) libraryAccess(ctx context.Context, actor *Actor) (mcpLibraryAccess, error) {
	role, err := library.UserRole(ctx, s.db, actor.UserID)
	if err != nil {
		return mcpLibraryAccess{}, err
	}
	restricted, err := library.HasTagRules(ctx, s.db, actor.UserID)
	if err != nil {
		return mcpLibraryAccess{}, err
	}
	return mcpLibraryAccess{
		Role:                 role,
		CanEditCatalog:       library.CanEditCatalogRole(role),
		RestrictedByTagRules: restricted,
		ConnectionCanWrite:   actor.CanWrite,
		ConnectionCanEdit:    actor.CanEditMetadata,
	}, nil
}

type searchBooksInput struct {
	Query    string
	After    string
	Limit    int
	ShelfID  string
	Statuses []string
}

type searchBookItem struct {
	ID         string   `json:"id"`
	Title      string   `json:"title"`
	Published  *string  `json:"published"`
	Status     *string  `json:"status"`
	StartedAt  *string  `json:"startedAt"`
	FinishedAt *string  `json:"finishedAt"`
	DnfAt      *string  `json:"dnfAt"`
	TbrRank    *int64   `json:"tbrRank"`
	Note       *string  `json:"note"`
	Authors    []string `json:"authors"`
}

type searchBooksResult struct {
	Items      []searchBookItem `json:"items"`
	NextCursor *string          `json:"nextCursor"`
}

func (s *Service) searchBooks(ctx context.Context, actor *Actor, input searchBooksInput) (*searchBooksResult, error) {
	where := []string{
		`EXISTS (SELECT 1 FROM visible_books vb WHERE vb.book_id = b.id AND vb.user_id = ?)`,
	}
	args := []any{actor.UserID, actor.UserID, actor.UserID}

	if len(input.Statuses) > 0 {
		var statusVals []string
		hasNone := false
		for _, st := range input.Statuses {
			if st == "none" {
				hasNone = true
			} else {
				statusVals = append(statusVals, st)
			}
		}
		var orParts []string
		if len(statusVals) > 0 {
			orParts = append(orParts, "ubs.status IN ("+makePlaceholders(len(statusVals))+")")
			for _, st := range statusVals {
				args = append(args, st)
			}
		}
		if hasNone {
			orParts = append(orParts, "ubs.status IS NULL")
		}
		if len(orParts) > 0 {
			where = append(where, "("+strings.Join(orParts, " OR ")+")")
		}
	}

	if input.After != "" {
		where = append(where, "b.id > ?")
		args = append(args, input.After)
	}
	if input.ShelfID != "" {
		where = append(where, `EXISTS (
			SELECT 1 FROM personal_shelf_books psb
			INNER JOIN personal_shelves ps ON ps.id = psb.shelf_id
			WHERE psb.book_id = b.id AND ps.id = ? AND ps.owner_id = ?
		)`)
		args = append(args, input.ShelfID, actor.UserID)
	}
	if input.Query != "" {
		term := "%" + books.EscapeLike(input.Query) + "%"
		where = append(where, `(
			b.title LIKE ? ESCAPE '\'
			OR EXISTS (
				SELECT 1 FROM book_authors ba
				INNER JOIN authors a ON a.id = ba.author_id
				WHERE ba.book_id = b.id AND a.name LIKE ? ESCAPE '\'
			)
			OR EXISTS (
				SELECT 1 FROM book_identifiers bi
				WHERE bi.book_id = b.id AND bi.value LIKE ? ESCAPE '\'
			)
		)`)
		args = append(args, term, term, term)
	}

	args = append(args, input.Limit+1)
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			b.id, b.title, b.published,
			ubs.status, ubs.started_at, ubs.finished_at, ubs.dnf_at, ubs.tbr_rank,
			ubr.text
		FROM books b
		LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		LEFT JOIN user_book_rationale ubr ON ubr.book_id = b.id AND ubr.user_id = ?
		WHERE `+strings.Join(where, " AND ")+`
		ORDER BY b.id ASC
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, err
	}
	var rawItems []searchBookItem
	for rows.Next() {
		var (
			id, title                    string
			pub, status, note            sql.NullString
			startedAt, finishedAt, dnfAt sql.NullInt64
			tbrRank                      sql.NullInt64
		)
		if err := rows.Scan(&id, &title, &pub, &status, &startedAt, &finishedAt, &dnfAt, &tbrRank, &note); err != nil {
			_ = rows.Close()
			return nil, err
		}
		rawItems = append(rawItems, searchBookItem{
			ID:         id,
			Title:      title,
			Published:  nullStringPtr(pub),
			Status:     nullStringPtr(status),
			StartedAt:  formatNullUnixSecISO(startedAt),
			FinishedAt: formatNullUnixSecISO(finishedAt),
			DnfAt:      formatNullUnixSecISO(dnfAt),
			TbrRank:    nullInt64Ptr(tbrRank),
			Note:       nullStringPtr(note),
			Authors:    []string{},
		})
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	hasMore := len(rawItems) > input.Limit
	page := rawItems
	if hasMore {
		page = rawItems[:input.Limit]
	}

	for i := range page {
		aRows, err := s.db.QueryContext(ctx, `
			SELECT a.name
			FROM book_authors ba
			INNER JOIN authors a ON a.id = ba.author_id
			WHERE ba.book_id = ?
			ORDER BY ba.position ASC
		`, page[i].ID)
		if err != nil {
			return nil, err
		}
		aList := make([]string, 0)
		for aRows.Next() {
			var name string
			if err := aRows.Scan(&name); err != nil {
				_ = aRows.Close()
				return nil, err
			}
			aList = append(aList, name)
		}
		if err := aRows.Close(); err != nil {
			return nil, err
		}
		page[i].Authors = aList
	}

	if page == nil {
		page = []searchBookItem{}
	}
	var nextCursor *string
	if hasMore && len(page) > 0 {
		lastID := page[len(page)-1].ID
		nextCursor = &lastID
	}
	return &searchBooksResult{
		Items:      page,
		NextCursor: nextCursor,
	}, nil
}

type mcpIdentifier struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type mcpBookDetail struct {
	ID                   string          `json:"id"`
	Title                string          `json:"title"`
	Description          *string         `json:"description"`
	Published            *string         `json:"published"`
	Language             *string         `json:"language"`
	Pages                *int64          `json:"pages"`
	HasPhysicalCopy      bool            `json:"hasPhysicalCopy"`
	HasAudiobookCopy     bool            `json:"hasAudiobookCopy"`
	Publisher            *string         `json:"publisher"`
	Series               *string         `json:"series"`
	SeriesIndex          *float64        `json:"seriesIndex"`
	Status               *string         `json:"status"`
	StartedAt            *string         `json:"startedAt"`
	FinishedAt           *string         `json:"finishedAt"`
	DnfAt                *string         `json:"dnfAt"`
	TbrRank              *int64          `json:"tbrRank"`
	Note                 *string         `json:"note"`
	MetadataVersion      string          `json:"metadataVersion"`
	Authors              []string        `json:"authors"`
	DescriptionTruncated bool            `json:"descriptionTruncated"`
	Identifiers          []mcpIdentifier `json:"identifiers"`
	IdentifiersTruncated bool            `json:"identifiersTruncated"`
	Tags                 []string        `json:"tags"`
	TagsTruncated        bool            `json:"tagsTruncated"`
	Genres               []string        `json:"genres"`
	GenresTruncated      bool            `json:"genresTruncated"`
}

func truncateUTF16(s string, maxUnits int) (string, bool) {
	u16 := utf16.Encode([]rune(s))
	if len(u16) <= maxUnits {
		return s, false
	}
	return string(utf16.Decode(u16[:maxUnits])), true
}

func (s *Service) getBook(ctx context.Context, actor *Actor, bookID string) (*mcpBookDetail, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var (
		id, title                    string
		desc, pub, lang              sql.NullString
		pages                        sql.NullInt64
		hasPhys, hasAudio            int64
		pubName, serName             sql.NullString
		serIdx                       sql.NullFloat64
		status, note                 sql.NullString
		startedAt, finishedAt, dnfAt sql.NullInt64
		tbrRank                      sql.NullInt64
	)
	err = tx.QueryRowContext(ctx, `
		SELECT
			b.id, b.title, b.description, b.published, b.language, b.pages,
			b.has_physical_copy, b.has_audiobook_copy,
			p.name, s.name, b.series_index,
			ubs.status, ubs.started_at, ubs.finished_at, ubs.dnf_at, ubs.tbr_rank,
			ubr.text
		FROM books b
		LEFT JOIN publishers p ON p.id = b.publisher_id
		LEFT JOIN series s ON s.id = b.series_id
		LEFT JOIN user_book_status ubs ON ubs.book_id = b.id AND ubs.user_id = ?
		LEFT JOIN user_book_rationale ubr ON ubr.book_id = b.id AND ubr.user_id = ?
		WHERE b.id = ?
		  AND EXISTS (SELECT 1 FROM visible_books vb WHERE vb.book_id = b.id AND vb.user_id = ?)
		LIMIT 1
	`, actor.UserID, actor.UserID, bookID, actor.UserID).Scan(
		&id, &title, &desc, &pub, &lang, &pages,
		&hasPhys, &hasAudio,
		&pubName, &serName, &serIdx,
		&status, &startedAt, &finishedAt, &dnfAt, &tbrRank,
		&note,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, httpapi.NewError(http.StatusNotFound, "Book not found.")
	}
	if err != nil {
		return nil, err
	}

	aRows, err := tx.QueryContext(ctx, `
		SELECT a.name
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id = ?
		ORDER BY ba.position ASC
	`, bookID)
	if err != nil {
		return nil, err
	}
	authorNames := make([]string, 0)
	for aRows.Next() {
		var name string
		if err := aRows.Scan(&name); err != nil {
			_ = aRows.Close()
			return nil, err
		}
		authorNames = append(authorNames, name)
	}
	_ = aRows.Close()

	iRows, err := tx.QueryContext(ctx, `
		SELECT type, value FROM book_identifiers WHERE book_id = ? LIMIT 101
	`, bookID)
	if err != nil {
		return nil, err
	}
	idents := make([]mcpIdentifier, 0)
	for iRows.Next() {
		var it mcpIdentifier
		if err := iRows.Scan(&it.Type, &it.Value); err != nil {
			_ = iRows.Close()
			return nil, err
		}
		idents = append(idents, it)
	}
	_ = iRows.Close()

	tRows, err := tx.QueryContext(ctx, `
		SELECT t.name
		FROM book_tags bt
		INNER JOIN tags t ON t.id = bt.tag_id
		WHERE bt.book_id = ?
		LIMIT 101
	`, bookID)
	if err != nil {
		return nil, err
	}
	tagNames := make([]string, 0)
	for tRows.Next() {
		var name string
		if err := tRows.Scan(&name); err != nil {
			_ = tRows.Close()
			return nil, err
		}
		tagNames = append(tagNames, name)
	}
	_ = tRows.Close()

	gRows, err := tx.QueryContext(ctx, `
		SELECT g.name
		FROM book_genres bg
		INNER JOIN genres g ON g.id = bg.genre_id
		WHERE bg.book_id = ?
		ORDER BY g.name ASC
		LIMIT 101
	`, bookID)
	if err != nil {
		return nil, err
	}
	genreNames := make([]string, 0)
	for gRows.Next() {
		var name string
		if err := gRows.Scan(&name); err != nil {
			_ = gRows.Close()
			return nil, err
		}
		genreNames = append(genreNames, name)
	}
	_ = gRows.Close()

	metaVer, err := books.ComputeMetadataVersion(ctx, tx, bookID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	var descPtr *string
	descTrunc := false
	if desc.Valid {
		truncated, wasTrunc := truncateUTF16(desc.String, 12000)
		descPtr = &truncated
		descTrunc = wasTrunc
	}
	identsTrunc := len(idents) > 100
	if identsTrunc {
		idents = idents[:100]
	}
	tagsTrunc := len(tagNames) > 100
	if tagsTrunc {
		tagNames = tagNames[:100]
	}
	genresTrunc := len(genreNames) > 100
	if genresTrunc {
		genreNames = genreNames[:100]
	}

	return &mcpBookDetail{
		ID:                   id,
		Title:                title,
		Description:          descPtr,
		Published:            nullStringPtr(pub),
		Language:             nullStringPtr(lang),
		Pages:                nullInt64Ptr(pages),
		HasPhysicalCopy:      hasPhys != 0,
		HasAudiobookCopy:     hasAudio != 0,
		Publisher:            nullStringPtr(pubName),
		Series:               nullStringPtr(serName),
		SeriesIndex:          nullFloat64Ptr(serIdx),
		Status:               nullStringPtr(status),
		StartedAt:            formatNullUnixSecISO(startedAt),
		FinishedAt:           formatNullUnixSecISO(finishedAt),
		DnfAt:                formatNullUnixSecISO(dnfAt),
		TbrRank:              nullInt64Ptr(tbrRank),
		Note:                 nullStringPtr(note),
		MetadataVersion:      metaVer,
		Authors:              authorNames,
		DescriptionTruncated: descTrunc,
		Identifiers:          idents,
		IdentifiersTruncated: identsTrunc,
		Tags:                 tagNames,
		TagsTruncated:        tagsTrunc,
		Genres:               genreNames,
		GenresTruncated:      genresTrunc,
	}, nil
}

func (s *Service) myShelves(ctx context.Context, actor *Actor) ([]bookshelf.ShelfSummaryDTO, error) {
	return s.bookshelf.ListShelves(ctx, actor.UserID)
}

type setStatusResult struct {
	BookID     string  `json:"bookId"`
	Status     *string `json:"status"`
	StartedAt  *string `json:"startedAt"`
	FinishedAt *string `json:"finishedAt"`
	DnfAt      *string `json:"dnfAt"`
	TbrRank    *int    `json:"tbrRank"`
}

func (s *Service) setStatus(ctx context.Context, actor *Actor, bookID string, change books.StatusChange) (*setStatusResult, error) {
	rows, err := books.TransitionBookStatuses(
		ctx, s.db, actor.UserID, []string{bookID}, change, time.Now(),
		func(tx *sql.Tx) error {
			return authorizeWrite(ctx, tx, actor, "personal")
		},
	)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, httpapi.NewError(http.StatusNotFound, "Book not found.")
	}
	row := rows[0]
	return &setStatusResult{
		BookID:     row.BookID,
		Status:     row.Status,
		StartedAt:  formatUnixSecPtrISO(row.StartedAt),
		FinishedAt: formatUnixSecPtrISO(row.FinishedAt),
		DnfAt:      formatUnixSecPtrISO(row.DnfAt),
		TbrRank:    row.TbrRank,
	}, nil
}

type tbrAuthorRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type tbrItem struct {
	ID      string         `json:"id"`
	Title   string         `json:"title"`
	Rank    int64          `json:"rank"`
	Note    string         `json:"note"`
	Authors []tbrAuthorRef `json:"authors"`
}

type listTbrResult struct {
	Items      []tbrItem `json:"items"`
	NextCursor *string   `json:"nextCursor"`
	Count      int       `json:"count"`
}

func (s *Service) listMyTbr(ctx context.Context, actor *Actor, after string, limit int) (*listTbrResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var hasCursor bool
	var cursorRank int64
	var cursorID string
	if after != "" {
		var rank sql.NullInt64
		err := tx.QueryRowContext(ctx, `
			SELECT b.id, ubs.tbr_rank
			FROM books b
			INNER JOIN user_book_status ubs ON ubs.book_id = b.id
			WHERE ubs.user_id = ?
			  AND ubs.status = 'to_be_read'
			  AND ubs.tbr_rank IS NOT NULL
			  AND EXISTS (SELECT 1 FROM visible_books vb WHERE vb.book_id = b.id AND vb.user_id = ?)
			  AND b.id = ?
			LIMIT 1
		`, actor.UserID, actor.UserID, after).Scan(&cursorID, &rank)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && !rank.Valid) {
			return nil, httpapi.NewError(http.StatusBadRequest, "TBR cursor is no longer available. Start again.")
		}
		if err != nil {
			return nil, err
		}
		hasCursor = true
		cursorRank = rank.Int64
	}

	var totalCount int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM books b
		INNER JOIN user_book_status ubs ON ubs.book_id = b.id
		WHERE ubs.user_id = ?
		  AND ubs.status = 'to_be_read'
		  AND ubs.tbr_rank IS NOT NULL
		  AND EXISTS (SELECT 1 FROM visible_books vb WHERE vb.book_id = b.id AND vb.user_id = ?)
	`, actor.UserID, actor.UserID).Scan(&totalCount); err != nil {
		return nil, err
	}

	args := []any{actor.UserID, actor.UserID, actor.UserID}
	cursorClause := ""
	if hasCursor {
		cursorClause = ` AND (ubs.tbr_rank > ? OR (ubs.tbr_rank = ? AND b.id > ?))`
		args = append(args, cursorRank, cursorRank, cursorID)
	}
	args = append(args, limit+1)

	rows, err := tx.QueryContext(ctx, `
		SELECT b.id, b.title, ubs.tbr_rank, ubr.text
		FROM books b
		INNER JOIN user_book_status ubs ON ubs.book_id = b.id
		LEFT JOIN user_book_rationale ubr ON ubr.book_id = b.id AND ubr.user_id = ?
		WHERE ubs.user_id = ?
		  AND ubs.status = 'to_be_read'
		  AND ubs.tbr_rank IS NOT NULL
		  AND EXISTS (SELECT 1 FROM visible_books vb WHERE vb.book_id = b.id AND vb.user_id = ?)
		`+cursorClause+`
		ORDER BY ubs.tbr_rank ASC, b.id ASC
		LIMIT ?
	`, args...)
	if err != nil {
		return nil, err
	}
	var all []tbrItem
	for rows.Next() {
		var (
			id, title string
			rank      int64
			note      sql.NullString
		)
		if err := rows.Scan(&id, &title, &rank, &note); err != nil {
			_ = rows.Close()
			return nil, err
		}
		all = append(all, tbrItem{
			ID:      id,
			Title:   title,
			Rank:    rank,
			Note:    note.String,
			Authors: []tbrAuthorRef{},
		})
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	hasMore := len(all) > limit
	page := all
	if hasMore {
		page = all[:limit]
	}

	for i := range page {
		aRows, err := tx.QueryContext(ctx, `
			SELECT a.id, a.name
			FROM book_authors ba
			INNER JOIN authors a ON a.id = ba.author_id
			WHERE ba.book_id = ?
			ORDER BY ba.position ASC, a.id ASC
		`, page[i].ID)
		if err != nil {
			return nil, err
		}
		aList := make([]tbrAuthorRef, 0)
		for aRows.Next() {
			var a tbrAuthorRef
			if err := aRows.Scan(&a.ID, &a.Name); err != nil {
				_ = aRows.Close()
				return nil, err
			}
			aList = append(aList, a)
		}
		if err := aRows.Close(); err != nil {
			return nil, err
		}
		page[i].Authors = aList
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	if page == nil {
		page = []tbrItem{}
	}
	var nextCursor *string
	if hasMore && len(page) > 0 {
		lastID := page[len(page)-1].ID
		nextCursor = &lastID
	}
	return &listTbrResult{
		Items:      page,
		NextCursor: nextCursor,
		Count:      totalCount,
	}, nil
}

func (s *Service) setTbrNote(ctx context.Context, actor *Actor, bookID, note string) (map[string]any, error) {
	saved, err := books.WriteRationale(
		ctx, s.db, actor.UserID, bookID, strings.TrimSpace(note),
		func(tx *sql.Tx) error {
			return authorizeWrite(ctx, tx, actor, "personal")
		},
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{"bookId": bookID, "note": saved}, nil
}

func (s *Service) editMetadata(ctx context.Context, actor *Actor, bookID, expectedVersion string, body map[string]json.RawMessage) (map[string]any, error) {
	_, hasDesc := body["description"]
	_, hasTags := body["tags"]
	_, hasGenres := body["genres"]
	_, hasIdents := body["identifiers"]

	storageWarning, err := s.books.UpdateBookMetadata(
		ctx, actor.UserID, bookID, body, expectedVersion,
		func(tx *sql.Tx) error {
			if err := authorizeWrite(ctx, tx, actor, "metadata"); err != nil {
				return err
			}
			if hasDesc {
				var curDesc sql.NullString
				if err := tx.QueryRowContext(ctx, `SELECT description FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&curDesc); err != nil && !errors.Is(err, sql.ErrNoRows) {
					return err
				}
				if curDesc.Valid && len(utf16.Encode([]rune(curDesc.String))) > 12000 {
					return httpapi.NewError(http.StatusBadRequest, "Description exceeds the MCP read limit. Edit it in Delb instead.")
				}
			}
			if hasTags {
				var cnt int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM book_tags WHERE book_id = ?`, bookID).Scan(&cnt); err != nil {
					return err
				}
				if cnt > 100 {
					return httpapi.NewError(http.StatusBadRequest, "This book has more tags than MCP can show. Edit tags in Delb instead.")
				}
			}
			if hasGenres {
				var cnt int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM book_genres WHERE book_id = ?`, bookID).Scan(&cnt); err != nil {
					return err
				}
				if cnt > 100 {
					return httpapi.NewError(http.StatusBadRequest, "This book has more genres than MCP can show. Edit genres in Delb instead.")
				}
			}
			if hasIdents {
				var cnt int
				if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM book_identifiers WHERE book_id = ?`, bookID).Scan(&cnt); err != nil {
					return err
				}
				if cnt > 100 {
					return httpapi.NewError(http.StatusBadRequest, "This book has more identifiers than MCP can show. Edit identifiers in Delb instead.")
				}
			}
			return nil
		},
	)
	if err != nil {
		return nil, err
	}
	bookDetail, err := s.getBook(ctx, actor, bookID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"book":           bookDetail,
		"storageWarning": storageWarning,
	}, nil
}

func (s *Service) setShelf(ctx context.Context, actor *Actor, shelfID, bookID string, present bool) (map[string]any, error) {
	action := "remove"
	if present {
		action = "add"
	}
	_, err := s.bookshelf.ChangeShelfBooks(
		ctx, actor.UserID, shelfID, []string{bookID}, action,
		func(tx *sql.Tx) error {
			return authorizeWrite(ctx, tx, actor, "personal")
		},
	)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"shelfId": shelfID,
		"bookId":  bookID,
		"present": present,
	}, nil
}

func (s *Service) getReadingProgress(ctx context.Context, actor *Actor, bookID string, limit int) (*books.ReadingProgressSnapshot, error) {
	return books.ReadReadingProgress(ctx, s.db, actor.UserID, bookID, limit)
}

func (s *Service) logReadingProgress(ctx context.Context, actor *Actor, bookID string, progressPercent *float64, pageNumber *int64, occurredSec int64) (*books.ManualProgressLog, error) {
	return books.RecordManualProgress(
		ctx, s.db, actor.UserID, bookID, progressPercent, pageNumber, occurredSec,
		func(tx *sql.Tx) error {
			return authorizeWrite(ctx, tx, actor, "personal")
		},
	)
}

func makePlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

func nullStringPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func nullInt64Ptr(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}

func nullFloat64Ptr(v sql.NullFloat64) *float64 {
	if !v.Valid {
		return nil
	}
	f := v.Float64
	return &f
}

func formatNullUnixSecISO(v sql.NullInt64) *string {
	if !v.Valid {
		return nil
	}
	s := time.Unix(v.Int64, 0).UTC().Format(iso8601Millis)
	return &s
}

func formatUnixSecPtrISO(v *int64) *string {
	if v == nil {
		return nil
	}
	s := time.Unix(*v, 0).UTC().Format(iso8601Millis)
	return &s
}
