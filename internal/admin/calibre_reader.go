package admin

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
	_ "modernc.org/sqlite"
)

type calibreBookRow struct {
	CalibreBookID int64
	Title         string
	Sort          *string
	Timestamp     *string
	Pubdate       *string
	LastModified  *string
	Path          *string
	SeriesIndex   *float64
}

type calibreAuthorRow struct {
	CalibreAuthorID int64
	Name            string
	Sort            *string
}

type calibreTagRow struct {
	CalibreTagID int64
	Name         string
}

type calibrePublisherRow struct {
	CalibrePublisherID int64
	Name               string
	Sort               *string
	Link               *string
}

type calibreSeriesRow struct {
	CalibreSeriesID int64
	Name            string
	Sort            *string
	Link            *string
}

type calibreBookAuthorLink struct {
	CalibreBookID   int64
	CalibreAuthorID int64
}

type calibreBookTagLink struct {
	CalibreBookID int64
	CalibreTagID  int64
}

type calibreBookPublisherLink struct {
	CalibreBookID      int64
	CalibrePublisherID int64
}

type calibreBookSeriesLink struct {
	CalibreBookID   int64
	CalibreSeriesID int64
	SeriesIndex     *float64
}

type calibreCommentRow struct {
	CalibreBookID int64
	Text          *string
}

type calibreIdentifierRow struct {
	CalibreBookID int64
	Type          string
	Value         string
}

type calibreLanguageRow struct {
	CalibreBookID int64
	LangCode      string
}

type calibreFormatFile struct {
	CalibreBookID int64
	Format        string
	RelativePath  string
}

type calibreCoverCandidate struct {
	Filename     string
	RelativePath string
	AbsPath      string
}

type calibreSnapshot struct {
	Books          []calibreBookRow
	Authors        []calibreAuthorRow
	Tags           []calibreTagRow
	Publishers     []calibrePublisherRow
	Series         []calibreSeriesRow
	BookAuthors    []calibreBookAuthorLink
	BookTags       []calibreBookTagLink
	BookPublishers []calibreBookPublisherLink
	BookSeries     []calibreBookSeriesLink
	Comments       []calibreCommentRow
	Identifiers    []calibreIdentifierRow
	Languages      []calibreLanguageRow
	FormatFiles    []calibreFormatFile
}

type calibreReader struct {
	db             *sql.DB
	libraryRootAbs string
}

func openCalibreReader(libraryRootAbs string) (*calibreReader, error) {
	dbAbs := filepath.Join(libraryRootAbs, "metadata.db")
	if _, err := os.Stat(dbAbs); err != nil {
		return nil, httpapi.NewError(http.StatusBadRequest, fmt.Sprintf("Calibre metadata database not found at: %s", dbAbs))
	}

	q := url.Values{}
	q.Set("mode", "ro")
	q.Add("_pragma", "busy_timeout(5000)")
	dsn := "file:" + filepath.ToSlash(dbAbs) + "?" + q.Encode()

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open calibre metadata.db: %w", err)
	}
	db.SetMaxOpenConns(1)
	return &calibreReader{
		db:             db,
		libraryRootAbs: libraryRootAbs,
	}, nil
}

func (r *calibreReader) Close() error {
	if r.db == nil {
		return nil
	}
	return r.db.Close()
}

func escapeSQLIdent(ident string) string {
	return `"` + strings.ReplaceAll(ident, `"`, `""`) + `"`
}

func (r *calibreReader) hasTable(ctx context.Context, tableName string) (bool, error) {
	var name string
	err := r.db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`, tableName).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return name != "", nil
}

func (r *calibreReader) hasColumn(ctx context.Context, tableName, columnName string) (bool, error) {
	ok, err := r.hasTable(ctx, tableName)
	if err != nil || !ok {
		return false, err
	}
	rows, err := r.db.QueryContext(ctx, `PRAGMA table_info(`+escapeSQLIdent(tableName)+`)`)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var (
			cid     int
			name    string
			colType string
			notNull int
			dfltVal any
			pk      int
		)
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltVal, &pk); err != nil {
			return false, err
		}
		if name == columnName {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (r *calibreReader) getCoverCandidates(book calibreBookRow) []calibreCoverCandidate {
	if book.Path == nil {
		return nil
	}
	relDir := strings.TrimSpace(*book.Path)
	if relDir == "" {
		return nil
	}
	candidates := []string{
		"thumb.webp",
		"cover.source.jpg",
		"cover.source.jpeg",
		"cover.source.png",
		"cover.source.webp",
		"source.jpg",
		"source.jpeg",
		"source.png",
		"source.webp",
		"cover.jpg",
		"cover.jpeg",
		"cover.png",
	}
	out := make([]calibreCoverCandidate, 0, len(candidates))
	for _, filename := range candidates {
		out = append(out, calibreCoverCandidate{
			Filename:     filename,
			RelativePath: strings.Join([]string{"library", relDir, filename}, "/"),
			AbsPath:      filepath.Join(r.libraryRootAbs, filepath.FromSlash(relDir), filename),
		})
	}
	return out
}

func (r *calibreReader) getBooks(ctx context.Context) ([]calibreBookRow, error) {
	ok, err := r.hasTable(ctx, "books")
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, httpapi.NewError(http.StatusBadRequest, "Calibre metadata.db is missing required table: books")
	}

	hasSort, _ := r.hasColumn(ctx, "books", "sort")
	hasTimestamp, _ := r.hasColumn(ctx, "books", "timestamp")
	hasPubdate, _ := r.hasColumn(ctx, "books", "pubdate")
	hasLastMod, _ := r.hasColumn(ctx, "books", "last_modified")
	hasPath, _ := r.hasColumn(ctx, "books", "path")
	hasSeriesIdx, _ := r.hasColumn(ctx, "books", "series_index")

	fields := []string{"id", "title"}
	if hasSort {
		fields = append(fields, "sort")
	}
	if hasTimestamp {
		fields = append(fields, "timestamp")
	}
	if hasPubdate {
		fields = append(fields, "pubdate")
	}
	if hasLastMod {
		fields = append(fields, "last_modified")
	}
	if hasPath {
		fields = append(fields, "path")
	}
	if hasSeriesIdx {
		fields = append(fields, "series_index")
	}

	rows, err := r.db.QueryContext(ctx, `SELECT `+strings.Join(fields, ", ")+` FROM books ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]calibreBookRow, 0)
	for rows.Next() {
		var (
			id        sql.NullInt64
			title     sql.NullString
			sortVal   sql.NullString
			tsVal     sql.NullString
			pubVal    sql.NullString
			lastVal   sql.NullString
			pathVal   sql.NullString
			serIdxVal sql.NullFloat64
		)
		dests := []any{&id, &title}
		if hasSort {
			dests = append(dests, &sortVal)
		}
		if hasTimestamp {
			dests = append(dests, &tsVal)
		}
		if hasPubdate {
			dests = append(dests, &pubVal)
		}
		if hasLastMod {
			dests = append(dests, &lastVal)
		}
		if hasPath {
			dests = append(dests, &pathVal)
		}
		if hasSeriesIdx {
			dests = append(dests, &serIdxVal)
		}
		if err := rows.Scan(dests...); err != nil {
			return nil, err
		}
		t := title.String
		if t == "" {
			t = "Unknown"
		}
		row := calibreBookRow{
			CalibreBookID: id.Int64,
			Title:         t,
		}
		if hasSort && sortVal.Valid {
			v := sortVal.String
			row.Sort = &v
		}
		if hasTimestamp && tsVal.Valid {
			v := tsVal.String
			row.Timestamp = &v
		}
		if hasPubdate && pubVal.Valid {
			v := pubVal.String
			row.Pubdate = &v
		}
		if hasLastMod && lastVal.Valid {
			v := lastVal.String
			row.LastModified = &v
		}
		if hasPath && pathVal.Valid {
			v := pathVal.String
			row.Path = &v
		}
		if hasSeriesIdx && serIdxVal.Valid {
			v := serIdxVal.Float64
			row.SeriesIndex = &v
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

func (r *calibreReader) getAuthors(ctx context.Context) ([]calibreAuthorRow, error) {
	if ok, err := r.hasTable(ctx, "authors"); err != nil || !ok {
		return nil, err
	}
	hasSort, _ := r.hasColumn(ctx, "authors", "sort")
	q := `SELECT id, name FROM authors ORDER BY id ASC`
	if hasSort {
		q = `SELECT id, name, sort FROM authors ORDER BY id ASC`
	}
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreAuthorRow
	for rows.Next() {
		var id sql.NullInt64
		var name, sortVal sql.NullString
		if hasSort {
			if err := rows.Scan(&id, &name, &sortVal); err != nil {
				return nil, err
			}
		} else {
			if err := rows.Scan(&id, &name); err != nil {
				return nil, err
			}
		}
		n := name.String
		if n == "" {
			n = "Unknown"
		}
		item := calibreAuthorRow{CalibreAuthorID: id.Int64, Name: n}
		if hasSort && sortVal.Valid {
			v := sortVal.String
			item.Sort = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *calibreReader) getTags(ctx context.Context) ([]calibreTagRow, error) {
	if ok, err := r.hasTable(ctx, "tags"); err != nil || !ok {
		return nil, err
	}
	rows, err := r.db.QueryContext(ctx, `SELECT id, name FROM tags ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreTagRow
	for rows.Next() {
		var id sql.NullInt64
		var name sql.NullString
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		n := name.String
		if n == "" {
			n = "Unknown"
		}
		out = append(out, calibreTagRow{CalibreTagID: id.Int64, Name: n})
	}
	return out, rows.Err()
}

func (r *calibreReader) getPublishers(ctx context.Context) ([]calibrePublisherRow, error) {
	if ok, err := r.hasTable(ctx, "publishers"); err != nil || !ok {
		return nil, err
	}
	hasSort, _ := r.hasColumn(ctx, "publishers", "sort")
	hasLink, _ := r.hasColumn(ctx, "publishers", "link")
	fields := []string{"id", "name"}
	if hasSort {
		fields = append(fields, "sort")
	}
	if hasLink {
		fields = append(fields, "link")
	}
	rows, err := r.db.QueryContext(ctx, `SELECT `+strings.Join(fields, ", ")+` FROM publishers ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibrePublisherRow
	for rows.Next() {
		var id sql.NullInt64
		var name, sortVal, linkVal sql.NullString
		dests := []any{&id, &name}
		if hasSort {
			dests = append(dests, &sortVal)
		}
		if hasLink {
			dests = append(dests, &linkVal)
		}
		if err := rows.Scan(dests...); err != nil {
			return nil, err
		}
		n := name.String
		if n == "" {
			n = "Unknown"
		}
		item := calibrePublisherRow{CalibrePublisherID: id.Int64, Name: n}
		if hasSort && sortVal.Valid {
			v := sortVal.String
			item.Sort = &v
		}
		if hasLink && linkVal.Valid {
			v := linkVal.String
			item.Link = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *calibreReader) getSeries(ctx context.Context) ([]calibreSeriesRow, error) {
	if ok, err := r.hasTable(ctx, "series"); err != nil || !ok {
		return nil, err
	}
	hasSort, _ := r.hasColumn(ctx, "series", "sort")
	hasLink, _ := r.hasColumn(ctx, "series", "link")
	fields := []string{"id", "name"}
	if hasSort {
		fields = append(fields, "sort")
	}
	if hasLink {
		fields = append(fields, "link")
	}
	rows, err := r.db.QueryContext(ctx, `SELECT `+strings.Join(fields, ", ")+` FROM series ORDER BY id ASC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreSeriesRow
	for rows.Next() {
		var id sql.NullInt64
		var name, sortVal, linkVal sql.NullString
		dests := []any{&id, &name}
		if hasSort {
			dests = append(dests, &sortVal)
		}
		if hasLink {
			dests = append(dests, &linkVal)
		}
		if err := rows.Scan(dests...); err != nil {
			return nil, err
		}
		n := name.String
		if n == "" {
			n = "Unknown"
		}
		item := calibreSeriesRow{CalibreSeriesID: id.Int64, Name: n}
		if hasSort && sortVal.Valid {
			v := sortVal.String
			item.Sort = &v
		}
		if hasLink && linkVal.Valid {
			v := linkVal.String
			item.Link = &v
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *calibreReader) firstExistingCol(ctx context.Context, table string, candidates ...string) string {
	for _, c := range candidates {
		if ok, _ := r.hasColumn(ctx, table, c); ok {
			return c
		}
	}
	return ""
}

func (r *calibreReader) getBookAuthorLinks(ctx context.Context) ([]calibreBookAuthorLink, error) {
	const table = "books_authors_link"
	if ok, err := r.hasTable(ctx, table); err != nil || !ok {
		return nil, err
	}
	bookCol := r.firstExistingCol(ctx, table, "book", "book_id")
	authorCol := r.firstExistingCol(ctx, table, "author", "author_id")
	if bookCol == "" || authorCol == "" {
		return nil, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(authorCol)+` FROM `+escapeSQLIdent(table))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreBookAuthorLink
	for rows.Next() {
		var bid, aid sql.NullInt64
		if err := rows.Scan(&bid, &aid); err != nil {
			return nil, err
		}
		if bid.Int64 > 0 && aid.Int64 > 0 {
			out = append(out, calibreBookAuthorLink{CalibreBookID: bid.Int64, CalibreAuthorID: aid.Int64})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getBookTagLinks(ctx context.Context) ([]calibreBookTagLink, error) {
	const table = "books_tags_link"
	if ok, err := r.hasTable(ctx, table); err != nil || !ok {
		return nil, err
	}
	bookCol := r.firstExistingCol(ctx, table, "book", "book_id")
	tagCol := r.firstExistingCol(ctx, table, "tag", "tag_id")
	if bookCol == "" || tagCol == "" {
		return nil, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(tagCol)+` FROM `+escapeSQLIdent(table))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreBookTagLink
	for rows.Next() {
		var bid, tid sql.NullInt64
		if err := rows.Scan(&bid, &tid); err != nil {
			return nil, err
		}
		if bid.Int64 > 0 && tid.Int64 > 0 {
			out = append(out, calibreBookTagLink{CalibreBookID: bid.Int64, CalibreTagID: tid.Int64})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getBookPublisherLinks(ctx context.Context) ([]calibreBookPublisherLink, error) {
	const linkTable = "books_publishers_link"
	if ok, err := r.hasTable(ctx, linkTable); err != nil {
		return nil, err
	} else if ok {
		bookCol := r.firstExistingCol(ctx, linkTable, "book", "book_id")
		pubCol := r.firstExistingCol(ctx, linkTable, "publisher", "publisher_id")
		if bookCol == "" || pubCol == "" {
			return nil, nil
		}
		rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(pubCol)+` FROM `+escapeSQLIdent(linkTable))
		if err != nil {
			return nil, err
		}
		defer func() { _ = rows.Close() }()
		var out []calibreBookPublisherLink
		for rows.Next() {
			var bid, pid sql.NullInt64
			if err := rows.Scan(&bid, &pid); err != nil {
				return nil, err
			}
			if bid.Int64 > 0 && pid.Int64 > 0 {
				out = append(out, calibreBookPublisherLink{CalibreBookID: bid.Int64, CalibrePublisherID: pid.Int64})
			}
		}
		return out, rows.Err()
	}

	if ok, _ := r.hasColumn(ctx, "books", "publisher"); !ok {
		return nil, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT id, publisher FROM books WHERE publisher IS NOT NULL`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreBookPublisherLink
	for rows.Next() {
		var bid, pid sql.NullInt64
		if err := rows.Scan(&bid, &pid); err != nil {
			return nil, err
		}
		if bid.Int64 > 0 && pid.Int64 > 0 {
			out = append(out, calibreBookPublisherLink{CalibreBookID: bid.Int64, CalibrePublisherID: pid.Int64})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getBookSeriesLinks(ctx context.Context) ([]calibreBookSeriesLink, error) {
	const linkTable = "books_series_link"
	hasIdx, _ := r.hasColumn(ctx, "books", "series_index")

	if ok, err := r.hasTable(ctx, linkTable); err != nil {
		return nil, err
	} else if ok {
		bookCol := r.firstExistingCol(ctx, linkTable, "book", "book_id")
		seriesCol := r.firstExistingCol(ctx, linkTable, "series", "series_id")
		if bookCol == "" || seriesCol == "" {
			return nil, nil
		}
		var idxByBook map[int64]*float64
		if hasIdx {
			idxByBook = make(map[int64]*float64)
			if iRows, err := r.db.QueryContext(ctx, `SELECT id, series_index FROM books`); err == nil {
				for iRows.Next() {
					var bid sql.NullInt64
					var idx sql.NullFloat64
					if err := iRows.Scan(&bid, &idx); err == nil && bid.Int64 > 0 {
						if idx.Valid {
							v := idx.Float64
							idxByBook[bid.Int64] = &v
						}
					}
				}
				_ = iRows.Close()
			}
		}
		rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(seriesCol)+` FROM `+escapeSQLIdent(linkTable))
		if err != nil {
			return nil, err
		}
		defer func() { _ = rows.Close() }()
		var out []calibreBookSeriesLink
		for rows.Next() {
			var bid, sid sql.NullInt64
			if err := rows.Scan(&bid, &sid); err != nil {
				return nil, err
			}
			if bid.Int64 > 0 && sid.Int64 > 0 {
				out = append(out, calibreBookSeriesLink{
					CalibreBookID:   bid.Int64,
					CalibreSeriesID: sid.Int64,
					SeriesIndex:     idxByBook[bid.Int64],
				})
			}
		}
		return out, rows.Err()
	}

	if ok, _ := r.hasColumn(ctx, "books", "series"); !ok {
		return nil, nil
	}
	q := `SELECT id, series FROM books WHERE series IS NOT NULL`
	if hasIdx {
		q = `SELECT id, series, series_index FROM books WHERE series IS NOT NULL`
	}
	rows, err := r.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreBookSeriesLink
	for rows.Next() {
		var bid, sid sql.NullInt64
		var idx sql.NullFloat64
		if hasIdx {
			if err := rows.Scan(&bid, &sid, &idx); err != nil {
				return nil, err
			}
		} else {
			if err := rows.Scan(&bid, &sid); err != nil {
				return nil, err
			}
		}
		if bid.Int64 > 0 && sid.Int64 > 0 {
			var idxPtr *float64
			if hasIdx && idx.Valid {
				v := idx.Float64
				idxPtr = &v
			}
			out = append(out, calibreBookSeriesLink{
				CalibreBookID:   bid.Int64,
				CalibreSeriesID: sid.Int64,
				SeriesIndex:     idxPtr,
			})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getComments(ctx context.Context) ([]calibreCommentRow, error) {
	const table = "comments"
	if ok, err := r.hasTable(ctx, table); err != nil || !ok {
		return nil, err
	}
	bookCol := r.firstExistingCol(ctx, table, "book", "book_id")
	textCol := r.firstExistingCol(ctx, table, "text")
	if bookCol == "" || textCol == "" {
		return nil, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(textCol)+` FROM `+escapeSQLIdent(table))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreCommentRow
	for rows.Next() {
		var bid sql.NullInt64
		var text sql.NullString
		if err := rows.Scan(&bid, &text); err != nil {
			return nil, err
		}
		if bid.Int64 > 0 {
			var ptr *string
			if text.Valid {
				v := text.String
				ptr = &v
			}
			out = append(out, calibreCommentRow{CalibreBookID: bid.Int64, Text: ptr})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getIdentifiers(ctx context.Context) ([]calibreIdentifierRow, error) {
	const table = "identifiers"
	if ok, err := r.hasTable(ctx, table); err != nil || !ok {
		return nil, err
	}
	bookCol := r.firstExistingCol(ctx, table, "book", "book_id")
	typeCol := r.firstExistingCol(ctx, table, "type")
	valCol := r.firstExistingCol(ctx, table, "val", "value")
	if bookCol == "" || typeCol == "" || valCol == "" {
		return nil, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(typeCol)+`, `+escapeSQLIdent(valCol)+` FROM `+escapeSQLIdent(table))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreIdentifierRow
	for rows.Next() {
		var bid sql.NullInt64
		var typ, val sql.NullString
		if err := rows.Scan(&bid, &typ, &val); err != nil {
			return nil, err
		}
		t := strings.ToLower(strings.TrimSpace(typ.String))
		v := val.String
		if bid.Int64 > 0 && t != "" && v != "" {
			out = append(out, calibreIdentifierRow{CalibreBookID: bid.Int64, Type: t, Value: v})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getLanguages(ctx context.Context) ([]calibreLanguageRow, error) {
	const linkTable = "books_languages_link"
	if ok, err := r.hasTable(ctx, linkTable); err != nil || !ok {
		return nil, err
	}
	bookCol := r.firstExistingCol(ctx, linkTable, "book", "book_id")
	directLangCol := r.firstExistingCol(ctx, linkTable, "lang_code", "lang")
	if bookCol != "" && directLangCol != "" {
		rows, err := r.db.QueryContext(ctx, `SELECT `+escapeSQLIdent(bookCol)+`, `+escapeSQLIdent(directLangCol)+` FROM `+escapeSQLIdent(linkTable))
		if err != nil {
			return nil, err
		}
		defer func() { _ = rows.Close() }()
		var out []calibreLanguageRow
		for rows.Next() {
			var bid sql.NullInt64
			var lc sql.NullString
			if err := rows.Scan(&bid, &lc); err != nil {
				return nil, err
			}
			if bid.Int64 > 0 && lc.String != "" {
				out = append(out, calibreLanguageRow{CalibreBookID: bid.Int64, LangCode: lc.String})
			}
		}
		return out, rows.Err()
	}

	langIDCol := r.firstExistingCol(ctx, linkTable, "language", "lang_id")
	if bookCol == "" || langIDCol == "" {
		return nil, nil
	}
	if ok, err := r.hasTable(ctx, "languages"); err != nil || !ok {
		return nil, err
	}
	langPK := r.firstExistingCol(ctx, "languages", "id")
	codeCol := r.firstExistingCol(ctx, "languages", "lang_code", "code", "lang")
	if langPK == "" || codeCol == "" {
		return nil, nil
	}
	rows, err := r.db.QueryContext(ctx, `
		SELECT bl.`+escapeSQLIdent(bookCol)+`, l.`+escapeSQLIdent(codeCol)+`
		FROM `+escapeSQLIdent(linkTable)+` bl
		JOIN languages l ON l.`+escapeSQLIdent(langPK)+` = bl.`+escapeSQLIdent(langIDCol)+`
	`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []calibreLanguageRow
	for rows.Next() {
		var bid sql.NullInt64
		var lc sql.NullString
		if err := rows.Scan(&bid, &lc); err != nil {
			return nil, err
		}
		if bid.Int64 > 0 && lc.String != "" {
			out = append(out, calibreLanguageRow{CalibreBookID: bid.Int64, LangCode: lc.String})
		}
	}
	return out, rows.Err()
}

func (r *calibreReader) getFormatFiles(ctx context.Context, bookList []calibreBookRow, scanDiskFallback bool) ([]calibreFormatFile, error) {
	out := make([]calibreFormatFile, 0)

	// 1. Best-effort DB-derived mapping (books_data_link + data)
	if ok, _ := r.hasTable(ctx, "books_data_link"); ok {
		bookCol := r.firstExistingCol(ctx, "books_data_link", "book", "book_id")
		dataCol := r.firstExistingCol(ctx, "books_data_link", "data", "data_id")
		fmtCol := r.firstExistingCol(ctx, "books_data_link", "format")
		if bookCol != "" && dataCol != "" && fmtCol != "" {
			if hasData, _ := r.hasTable(ctx, "data"); hasData {
				dataPK := r.firstExistingCol(ctx, "data", "id")
				nameCol := r.firstExistingCol(ctx, "data", "name")
				if dataPK != "" && nameCol != "" {
					if rows, err := r.db.QueryContext(ctx, `
						SELECT bdl.`+escapeSQLIdent(bookCol)+`, bdl.`+escapeSQLIdent(fmtCol)+`, d.`+escapeSQLIdent(nameCol)+`
						FROM books_data_link bdl
						JOIN data d ON d.`+escapeSQLIdent(dataPK)+` = bdl.`+escapeSQLIdent(dataCol)+`
					`); err == nil {
						booksByID := make(map[int64]calibreBookRow, len(bookList))
						for _, b := range bookList {
							booksByID[b.CalibreBookID] = b
						}
						for rows.Next() {
							var bid sql.NullInt64
							var fmtStr, name sql.NullString
							if err := rows.Scan(&bid, &fmtStr, &name); err != nil {
								break
							}
							bk, exists := booksByID[bid.Int64]
							if !exists || bk.Path == nil || *bk.Path == "" || name.String == "" || fmtStr.String == "" || bid.Int64 <= 0 {
								continue
							}
							rel := path.Join(
								strings.ReplaceAll(*bk.Path, "\\", "/"),
								strings.ReplaceAll(name.String, "\\", "/"),
							)
							out = append(out, calibreFormatFile{
								CalibreBookID: bid.Int64,
								Format:        strings.ToUpper(fmtStr.String),
								RelativePath:  rel,
							})
						}
						_ = rows.Close()
					}
				}
			}
		}
	}

	if len(out) > 0 || !scanDiskFallback {
		return out, nil
	}

	// 2. Disk fallback scan
	knownExts := map[string]struct{}{
		"EPUB": {}, "MOBI": {}, "AZW": {}, "AZW3": {}, "PDF": {},
		"CBZ": {}, "CBR": {}, "TXT": {}, "RTF": {}, "DJVU": {},
		"DOC": {}, "DOCX": {}, "HTML": {}, "HTM": {},
	}
	for _, b := range bookList {
		if b.Path == nil || *b.Path == "" {
			continue
		}
		dirAbs := filepath.Join(r.libraryRootAbs, filepath.FromSlash(*b.Path))
		entries, err := os.ReadDir(dirAbs)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			ext := strings.ToUpper(strings.TrimPrefix(filepath.Ext(e.Name()), "."))
			if _, ok := knownExts[ext]; !ok {
				continue
			}
			out = append(out, calibreFormatFile{
				CalibreBookID: b.CalibreBookID,
				Format:        ext,
				RelativePath: path.Join(
					strings.ReplaceAll(*b.Path, "\\", "/"),
					strings.ReplaceAll(e.Name(), "\\", "/"),
				),
			})
		}
	}
	return out, nil
}

func (r *calibreReader) getSnapshot(ctx context.Context) (*calibreSnapshot, error) {
	bookList, err := r.getBooks(ctx)
	if err != nil {
		return nil, err
	}
	authorList, err := r.getAuthors(ctx)
	if err != nil {
		return nil, err
	}
	tagList, err := r.getTags(ctx)
	if err != nil {
		return nil, err
	}
	pubList, err := r.getPublishers(ctx)
	if err != nil {
		return nil, err
	}
	serList, err := r.getSeries(ctx)
	if err != nil {
		return nil, err
	}
	baLinks, err := r.getBookAuthorLinks(ctx)
	if err != nil {
		return nil, err
	}
	btLinks, err := r.getBookTagLinks(ctx)
	if err != nil {
		return nil, err
	}
	bpLinks, err := r.getBookPublisherLinks(ctx)
	if err != nil {
		return nil, err
	}
	bsLinks, err := r.getBookSeriesLinks(ctx)
	if err != nil {
		return nil, err
	}
	comments, err := r.getComments(ctx)
	if err != nil {
		return nil, err
	}
	idents, err := r.getIdentifiers(ctx)
	if err != nil {
		return nil, err
	}
	langs, err := r.getLanguages(ctx)
	if err != nil {
		return nil, err
	}
	files, err := r.getFormatFiles(ctx, bookList, true)
	if err != nil {
		return nil, err
	}
	return &calibreSnapshot{
		Books:          bookList,
		Authors:        authorList,
		Tags:           tagList,
		Publishers:     pubList,
		Series:         serList,
		BookAuthors:    baLinks,
		BookTags:       btLinks,
		BookPublishers: bpLinks,
		BookSeries:     bsLinks,
		Comments:       comments,
		Identifiers:    idents,
		Languages:      langs,
		FormatFiles:    files,
	}, nil
}

// confinedCalibrePath mirrors server/utils/books/storage/calibre-path.ts confinedCalibrePath.
func confinedCalibrePath(root, candidate string) (string, error) {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	resolved := candidate
	if !filepath.IsAbs(resolved) {
		resolved = filepath.Join(root, filepath.FromSlash(candidate))
	}
	realCandidate, err := filepath.EvalSymlinks(resolved)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(realRoot, realCandidate)
	if err != nil {
		return "", err
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("Calibre path escapes the configured library")
	}
	return realCandidate, nil
}
