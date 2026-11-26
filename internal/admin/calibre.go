package admin

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
	"github.com/lancewilhelm/delb/internal/storage"
)

type calibreImportScanned struct {
	CalibreBooks              int `json:"calibreBooks"`
	CalibreAuthors            int `json:"calibreAuthors"`
	CalibreTags               int `json:"calibreTags"`
	CalibrePublishers         int `json:"calibrePublishers"`
	CalibreSeries             int `json:"calibreSeries"`
	CalibreBookAuthorLinks    int `json:"calibreBookAuthorLinks"`
	CalibreBookTagLinks       int `json:"calibreBookTagLinks"`
	CalibreBookPublisherLinks int `json:"calibreBookPublisherLinks"`
	CalibreBookSeriesLinks    int `json:"calibreBookSeriesLinks"`
	CalibreIdentifiers        int `json:"calibreIdentifiers"`
	CalibreFormatFilesFromDB  int `json:"calibreFormatFilesFromDb"`
}

type calibreImportResults struct {
	BooksCreated               int      `json:"booksCreated"`
	BooksUpdated               int      `json:"booksUpdated"`
	FilesUpserted              int      `json:"filesUpserted"`
	AuthorsCreated             int      `json:"authorsCreated"`
	TagsCreated                int      `json:"tagsCreated"`
	PublishersCreated          int      `json:"publishersCreated"`
	SeriesCreated              int      `json:"seriesCreated"`
	IdentifiersUpserted        int      `json:"identifiersUpserted"`
	BookAuthorLinksUpserted    int      `json:"bookAuthorLinksUpserted"`
	BookTagLinksUpserted       int      `json:"bookTagLinksUpserted"`
	BookPublisherLinksUpserted int      `json:"bookPublisherLinksUpserted"`
	BookSeriesLinksUpserted    int      `json:"bookSeriesLinksUpserted"`
	CoverCandidatesFound       int      `json:"coverCandidatesFound"`
	CoverPathsSet              int      `json:"coverPathsSet"`
	BookPathsMissingInCalibre  int      `json:"bookPathsMissingInCalibre"`
	FilesDiscoveredByDirScan   int      `json:"filesDiscoveredByDirScan"`
	Warnings                   []string `json:"warnings"`
}

type calibreImportSummary struct {
	Action        string               `json:"action"`
	DryRun        bool                 `json:"dryRun"`
	LibraryRoot   string               `json:"libraryRoot"`
	CalibreDBPath string               `json:"calibreDbPath"`
	Scanned       calibreImportScanned `json:"scanned"`
	Results       calibreImportResults `json:"results"`
}

func safeNonEmptyStringPtr(p *string) *string {
	if p == nil {
		return nil
	}
	s := strings.TrimSpace(*p)
	if s == "" {
		return nil
	}
	return &s
}

func uniqInt64(in []int64) []int64 {
	seen := make(map[int64]struct{}, len(in))
	out := make([]int64, 0, len(in))
	for _, v := range in {
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

func scanCalibreBookDirForFormats(book calibreBookRow, calibreRootAbs string) []calibreFormatFile {
	relDirPtr := safeNonEmptyStringPtr(book.Path)
	if relDirPtr == nil {
		return nil
	}
	relDir := *relDirPtr
	dirAbs, err := confinedCalibrePath(calibreRootAbs, relDir)
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(dirAbs)
	if err != nil {
		return nil
	}
	var out []calibreFormatFile
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		filename := e.Name()
		if filename == "" {
			continue
		}
		lower := strings.ToLower(filename)
		if lower == "metadata.opf" || lower == "cover.jpg" || lower == "cover.jpeg" || lower == "cover.png" {
			continue
		}
		ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))
		switch ext {
		case "epub", "pdf", "mobi", "azw3":
			out = append(out, calibreFormatFile{
				CalibreBookID: book.CalibreBookID,
				Format:        ext,
				RelativePath:  relDir + "/" + filename,
			})
		}
	}
	return out
}

func copyFileIfMissing(srcAbs, destAbs string) (bool, error) {
	if existsFile(destAbs) {
		return false, nil
	}
	if err := os.MkdirAll(filepath.Dir(destAbs), 0o755); err != nil {
		return false, err
	}
	in, err := os.Open(srcAbs)
	if err != nil {
		return false, err
	}
	defer func() { _ = in.Close() }()

	out, err := os.Create(destAbs)
	if err != nil {
		return false, err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return false, copyErr
	}
	if closeErr != nil {
		return false, closeErr
	}
	return true, nil
}

// POST /api/settings/admin/calibre
func (s *Service) handleAdminCalibre(w http.ResponseWriter, r *http.Request) {
	swu, ok := s.requireAdminOrOwner(w, r)
	if !ok {
		return
	}
	userID := swu.User.ID

	var body struct {
		Action    string `json:"action"`
		ImportNew bool   `json:"importNew"`
		DryRun    bool   `json:"dryRun"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	if body.Action != "import" && body.Action != "rescan" {
		httpapi.WriteError(w, http.StatusBadRequest, "Missing or invalid `action` (import|rescan)")
		return
	}

	startTime := time.Now()
	ctx := r.Context()
	s.logger.InfoContext(ctx, "starting calibre operation",
		"action", body.Action,
		"dryRun", body.DryRun,
		"actorUserId", userID,
	)
	if err := library.RequireCatalogEditor(ctx, s.db, userID); err != nil {
		s.writeErr(w, "POST /api/settings/admin/calibre auth failed", err)
		return
	}

	reader, err := openCalibreReader(s.calibreDir)
	if err != nil {
		s.writeErr(w, "POST /api/settings/admin/calibre open reader failed", err)
		return
	}
	defer func() { _ = reader.Close() }()

	snap, err := reader.getSnapshot(ctx)
	if err != nil {
		s.writeErr(w, "POST /api/settings/admin/calibre snapshot failed", err)
		return
	}

	summary := calibreImportSummary{
		Action:        body.Action,
		DryRun:        body.DryRun,
		LibraryRoot:   "calibre",
		CalibreDBPath: "calibre/metadata.db",
		Scanned: calibreImportScanned{
			CalibreBooks:              len(snap.Books),
			CalibreAuthors:            len(snap.Authors),
			CalibreTags:               len(snap.Tags),
			CalibrePublishers:         len(snap.Publishers),
			CalibreSeries:             len(snap.Series),
			CalibreBookAuthorLinks:    len(snap.BookAuthors),
			CalibreBookTagLinks:       len(snap.BookTags),
			CalibreBookPublisherLinks: len(snap.BookPublishers),
			CalibreBookSeriesLinks:    len(snap.BookSeries),
			CalibreIdentifiers:        len(snap.Identifiers),
			CalibreFormatFilesFromDB:  len(snap.FormatFiles),
		},
		Results: calibreImportResults{
			Warnings: make([]string, 0),
		},
	}

	calibreAuthorByID := make(map[int64]calibreAuthorRow, len(snap.Authors))
	for _, a := range snap.Authors {
		calibreAuthorByID[a.CalibreAuthorID] = a
	}
	calibreTagByID := make(map[int64]calibreTagRow, len(snap.Tags))
	for _, t := range snap.Tags {
		calibreTagByID[t.CalibreTagID] = t
	}
	calibrePublisherByID := make(map[int64]calibrePublisherRow, len(snap.Publishers))
	for _, p := range snap.Publishers {
		calibrePublisherByID[p.CalibrePublisherID] = p
	}
	calibreSeriesByID := make(map[int64]calibreSeriesRow, len(snap.Series))
	for _, sr := range snap.Series {
		calibreSeriesByID[sr.CalibreSeriesID] = sr
	}

	calibreAuthorsByBookID := make(map[int64][]int64)
	for _, l := range snap.BookAuthors {
		calibreAuthorsByBookID[l.CalibreBookID] = append(calibreAuthorsByBookID[l.CalibreBookID], l.CalibreAuthorID)
	}
	calibreTagsByBookID := make(map[int64][]int64)
	for _, l := range snap.BookTags {
		calibreTagsByBookID[l.CalibreBookID] = append(calibreTagsByBookID[l.CalibreBookID], l.CalibreTagID)
	}
	calibrePublisherByBookID := make(map[int64]int64)
	for _, l := range snap.BookPublishers {
		calibrePublisherByBookID[l.CalibreBookID] = l.CalibrePublisherID
	}
	calibreSeriesByBookID := make(map[int64]int64)
	for _, l := range snap.BookSeries {
		calibreSeriesByBookID[l.CalibreBookID] = l.CalibreSeriesID
	}
	calibreCommentByBookID := make(map[int64]string)
	for _, c := range snap.Comments {
		if c.Text != nil && *c.Text != "" {
			calibreCommentByBookID[c.CalibreBookID] = *c.Text
		}
	}
	calibreIdentifiersByBookID := make(map[int64][]calibreIdentifierRow)
	for _, ident := range snap.Identifiers {
		calibreIdentifiersByBookID[ident.CalibreBookID] = append(calibreIdentifiersByBookID[ident.CalibreBookID], ident)
	}
	calibreLanguagesByBookID := make(map[int64][]string)
	for _, lang := range snap.Languages {
		calibreLanguagesByBookID[lang.CalibreBookID] = append(calibreLanguagesByBookID[lang.CalibreBookID], lang.LangCode)
	}
	calibreFormatFilesByBookID := make(map[int64][]calibreFormatFile)
	for _, f := range snap.FormatFiles {
		calibreFormatFilesByBookID[f.CalibreBookID] = append(calibreFormatFilesByBookID[f.CalibreBookID], f)
	}

	// Load existing Delb books keyed by calibre_book_id
	delbBookIDByCalibreID := make(map[int64]string)
	existingRows, err := s.db.QueryContext(ctx, `SELECT id, calibre_book_id FROM books WHERE calibre_book_id IS NOT NULL`)
	if err != nil {
		s.writeErr(w, "POST /api/settings/admin/calibre query existing failed", err)
		return
	}
	for existingRows.Next() {
		var id string
		var cid sql.NullInt64
		if err := existingRows.Scan(&id, &cid); err != nil {
			_ = existingRows.Close()
			s.writeErr(w, "POST /api/settings/admin/calibre scan existing failed", err)
			return
		}
		if cid.Valid {
			delbBookIDByCalibreID[cid.Int64] = id
		}
	}
	_ = existingRows.Close()

	// Entity caches for dry-run accuracy and speed
	authorIDByName := make(map[string]string)
	tagIDByName := make(map[string]string)
	publisherIDByName := make(map[string]string)
	seriesIDByName := make(map[string]string)

	upsertAuthor := func(q library.Queryable, name string, sortName *string) (string, error) {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			return "00000000-0000-0000-0000-000000000000", nil
		}
		if cached, ok := authorIDByName[trimmed]; ok {
			return cached, nil
		}
		var foundID string
		err := q.QueryRowContext(ctx, `SELECT id FROM authors WHERE name = ? LIMIT 1`, trimmed).Scan(&foundID)
		if err == nil && foundID != "" {
			authorIDByName[trimmed] = foundID
			return foundID, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		id := uuid.NewString()
		nowSec := time.Now().UTC().Unix()
		sk := books.MakeAuthorSortKey(trimmed)
		if sortName != nil && *sortName != "" {
			sk = *sortName
		}
		if !body.DryRun {
			if _, err := q.ExecContext(ctx, `
				INSERT INTO authors (id, name, sort_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
			`, id, trimmed, sk, nowSec, nowSec); err != nil {
				return "", err
			}
		}
		authorIDByName[trimmed] = id
		summary.Results.AuthorsCreated++
		return id, nil
	}

	upsertTag := func(q library.Queryable, name string) (string, error) {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			return "00000000-0000-0000-0000-000000000000", nil
		}
		if cached, ok := tagIDByName[trimmed]; ok {
			return cached, nil
		}
		var foundID string
		err := q.QueryRowContext(ctx, `SELECT id FROM tags WHERE name = ? LIMIT 1`, trimmed).Scan(&foundID)
		if err == nil && foundID != "" {
			tagIDByName[trimmed] = foundID
			return foundID, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		id := uuid.NewString()
		nowSec := time.Now().UTC().Unix()
		if !body.DryRun {
			if _, err := q.ExecContext(ctx, `
				INSERT INTO tags (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
			`, id, trimmed, nowSec, nowSec); err != nil {
				return "", err
			}
		}
		tagIDByName[trimmed] = id
		summary.Results.TagsCreated++
		return id, nil
	}

	upsertPublisher := func(q library.Queryable, name string) (string, error) {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			return "00000000-0000-0000-0000-000000000000", nil
		}
		if cached, ok := publisherIDByName[trimmed]; ok {
			return cached, nil
		}
		var foundID string
		err := q.QueryRowContext(ctx, `SELECT id FROM publishers WHERE name = ? LIMIT 1`, trimmed).Scan(&foundID)
		if err == nil && foundID != "" {
			publisherIDByName[trimmed] = foundID
			return foundID, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		id := uuid.NewString()
		nowSec := time.Now().UTC().Unix()
		if !body.DryRun {
			if _, err := q.ExecContext(ctx, `
				INSERT INTO publishers (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
			`, id, trimmed, nowSec, nowSec); err != nil {
				return "", err
			}
		}
		publisherIDByName[trimmed] = id
		summary.Results.PublishersCreated++
		return id, nil
	}

	upsertSeries := func(q library.Queryable, name string) (string, error) {
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			return "00000000-0000-0000-0000-000000000000", nil
		}
		if cached, ok := seriesIDByName[trimmed]; ok {
			return cached, nil
		}
		var foundID string
		err := q.QueryRowContext(ctx, `SELECT id FROM series WHERE name = ? LIMIT 1`, trimmed).Scan(&foundID)
		if err == nil && foundID != "" {
			seriesIDByName[trimmed] = foundID
			return foundID, nil
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return "", err
		}
		id := uuid.NewString()
		nowSec := time.Now().UTC().Unix()
		if !body.DryRun {
			if _, err := q.ExecContext(ctx, `
				INSERT INTO series (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
			`, id, trimmed, nowSec, nowSec); err != nil {
				return "", err
			}
		}
		seriesIDByName[trimmed] = id
		summary.Results.SeriesCreated++
		return id, nil
	}

	for _, calibreBook := range snap.Books {
		if calibreBook.CalibreBookID <= 0 {
			continue
		}
		knownDelbBookID := delbBookIDByCalibreID[calibreBook.CalibreBookID]
		if body.Action == "rescan" && knownDelbBookID == "" && !body.ImportNew {
			continue
		}
		if safeNonEmptyStringPtr(calibreBook.Path) == nil {
			summary.Results.BookPathsMissingInCalibre++
		}

		calibreAuthorIDs := uniqInt64(calibreAuthorsByBookID[calibreBook.CalibreBookID])
		authorNames := make([]string, 0, len(calibreAuthorIDs))
		for _, aid := range calibreAuthorIDs {
			if a, ok := calibreAuthorByID[aid]; ok {
				if trimmed := strings.TrimSpace(a.Name); trimmed != "" {
					authorNames = append(authorNames, trimmed)
				}
			}
		}
		effectiveAuthorNames := authorNames
		if len(effectiveAuthorNames) == 0 {
			effectiveAuthorNames = []string{"Unknown Author"}
		}

		bookTitle := calibreBook.Title
		if bookTitle == "" {
			bookTitle = "Unknown"
		}

		delbBookID := knownDelbBookID
		if delbBookID == "" {
			delbBookID = uuid.NewString()
		}
		nowSec := time.Now().UTC().Unix()

		perform := func() error {
			tx, err := s.db.BeginTx(ctx, nil)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback() }()

			if err := library.RequireCatalogEditor(ctx, tx, userID); err != nil {
				return err
			}
			if knownDelbBookID != "" {
				if err := library.AssertBookEditor(ctx, tx, userID, knownDelbBookID); err != nil {
					return err
				}
			}

			var publisherID *string
			if pid, hasPub := calibrePublisherByBookID[calibreBook.CalibreBookID]; hasPub {
				if p, ok := calibrePublisherByID[pid]; ok && p.Name != "" {
					id, err := upsertPublisher(tx, p.Name)
					if err != nil {
						return err
					}
					publisherID = &id
				}
			}

			var seriesID *string
			if sid, hasSer := calibreSeriesByBookID[calibreBook.CalibreBookID]; hasSer {
				if sr, ok := calibreSeriesByID[sid]; ok && sr.Name != "" {
					id, err := upsertSeries(tx, sr.Name)
					if err != nil {
						return err
					}
					seriesID = &id
				}
			}

			var description *string
			if desc, ok := calibreCommentByBookID[calibreBook.CalibreBookID]; ok {
				d := desc
				description = &d
			}

			var language *string
			if langs := calibreLanguagesByBookID[calibreBook.CalibreBookID]; len(langs) > 0 {
				l := langs[0]
				language = &l
			}

			published := safeNonEmptyStringPtr(calibreBook.Pubdate)
			if published == nil {
				published = safeNonEmptyStringPtr(calibreBook.Timestamp)
			}
			var publishedAt *int64
			if published != nil {
				publishedAt = books.NormalizePublishedAtUnix(*published)
			}

			delbPaths := storage.GetCanonicalBookPaths(effectiveAuthorNames, bookTitle, delbBookID)
			delbBookDirRelPosix := delbPaths.BookDir
			delbBookDirAbs, err := storage.ResolveUnderLibrary(s.libraryDir, delbBookDirRelPosix)
			if err != nil {
				return err
			}

			var coverImagePath *string
			coverCandidates := reader.getCoverCandidates(calibreBook)
			summary.Results.CoverCandidatesFound += len(coverCandidates)

			for _, c := range coverCandidates {
				coverSource, cerr := confinedCalibrePath(s.calibreDir, c.AbsPath)
				if cerr != nil || !existsFile(coverSource) {
					continue
				}
				if !body.DryRun {
					srcBytes, rerr := os.ReadFile(coverSource)
					if rerr != nil {
						s.logger.Warn("calibre import: failed to read cover", "error", rerr)
						coverImagePath = nil
					} else {
						ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(c.Filename), "."))
						_, thumb, _, eerr := books.EnsureCoverOutputsFromBytes(srcBytes, "", ext, books.CoverProcessingOpts{
							OutputDirAbs:      delbBookDirAbs,
							OutputDirRelPosix: delbBookDirRelPosix,
							SourceBaseName:    "cover",
							ThumbFileName:     "thumb.webp",
							ThumbMaxWidth:     320,
						})
						if eerr != nil {
							s.logger.Warn("calibre import: failed to generate Delb cover assets (continuing without cover)", "error", eerr)
							coverImagePath = nil
						} else {
							p := thumb.RelativePath
							coverImagePath = &p
						}
					}
				} else {
					p := path.Join(delbBookDirRelPosix, "thumb.webp")
					coverImagePath = &p
				}
				break
			}

			sortTitle := books.MakeTitleSortKey(bookTitle)
			if st := safeNonEmptyStringPtr(calibreBook.Sort); st != nil {
				sortTitle = *st
			}

			if knownDelbBookID != "" {
				if !body.DryRun {
					if _, err := tx.ExecContext(ctx, `
						UPDATE books SET
							title = ?,
							sort_title = ?,
							description = ?,
							language = ?,
							published = ?,
							published_at = ?,
							publisher_id = ?,
							series_id = ?,
							series_index = ?,
							cover_image_path = ?,
							updated_at = ?,
							calibre_book_id = ?
						WHERE id = ?
					`, bookTitle, sortTitle, description, language, published, publishedAt,
						publisherID, seriesID, calibreBook.SeriesIndex, coverImagePath,
						nowSec, calibreBook.CalibreBookID, knownDelbBookID); err != nil {
						return err
					}
				}
				summary.Results.BooksUpdated++
			} else {
				if !body.DryRun {
					if _, err := tx.ExecContext(ctx, `
						INSERT INTO books (
							id, added_by_user_id, added_at,
							title, sort_title, description, language, published, published_at,
							publisher_id, series_id, series_index, cover_image_path,
							created_by_user_id, created_at, updated_at, calibre_book_id
						) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					`, delbBookID, userID, nowSec,
						bookTitle, sortTitle, description, language, published, publishedAt,
						publisherID, seriesID, calibreBook.SeriesIndex, coverImagePath,
						userID, nowSec, nowSec, calibreBook.CalibreBookID); err != nil {
						return err
					}
				}
				summary.Results.BooksCreated++
				delbBookIDByCalibreID[calibreBook.CalibreBookID] = delbBookID
			}

			if coverImagePath != nil {
				summary.Results.CoverPathsSet++
			}

			// Authors
			for i, name := range effectiveAuthorNames {
				var sortPtr *string
				if i < len(calibreAuthorIDs) {
					if ca, ok := calibreAuthorByID[calibreAuthorIDs[i]]; ok {
						sortPtr = ca.Sort
					}
				}
				aID, err := upsertAuthor(tx, name, sortPtr)
				if err != nil {
					return err
				}
				if !body.DryRun {
					if _, err := tx.ExecContext(ctx, `
						INSERT INTO book_authors (book_id, author_id, position)
						VALUES (?, ?, ?)
						ON CONFLICT DO NOTHING
					`, delbBookID, aID, i+1); err != nil {
						return err
					}
				}
				summary.Results.BookAuthorLinksUpserted++
			}

			// Tags
			for _, tid := range uniqInt64(calibreTagsByBookID[calibreBook.CalibreBookID]) {
				ct, ok := calibreTagByID[tid]
				if !ok || ct.Name == "" {
					continue
				}
				tID, err := upsertTag(tx, ct.Name)
				if err != nil {
					return err
				}
				if !body.DryRun {
					if _, err := tx.ExecContext(ctx, `
						INSERT INTO book_tags (book_id, tag_id)
						VALUES (?, ?)
						ON CONFLICT DO NOTHING
					`, delbBookID, tID); err != nil {
						return err
					}
				}
				summary.Results.BookTagLinksUpserted++
			}

			if publisherID != nil {
				summary.Results.BookPublisherLinksUpserted++
			}
			if seriesID != nil {
				summary.Results.BookSeriesLinksUpserted++
			}

			// Identifiers
			for _, ident := range calibreIdentifiersByBookID[calibreBook.CalibreBookID] {
				typ := strings.ToLower(strings.TrimSpace(ident.Type))
				val := strings.TrimSpace(ident.Value)
				if typ == "" || val == "" {
					continue
				}
				if !body.DryRun {
					if _, err := tx.ExecContext(ctx, `
						INSERT INTO book_identifiers (book_id, type, value)
						VALUES (?, ?, ?)
						ON CONFLICT(book_id, type) DO UPDATE SET value = excluded.value
					`, delbBookID, typ, val); err != nil {
						return err
					}
				}
				summary.Results.IdentifiersUpserted++
			}

			// Format files
			formatFiles := calibreFormatFilesByBookID[calibreBook.CalibreBookID]
			if len(formatFiles) == 0 {
				scanned := scanCalibreBookDirForFormats(calibreBook, s.calibreDir)
				if len(scanned) > 0 {
					summary.Results.FilesDiscoveredByDirScan += len(scanned)
					formatFiles = scanned
				}
			}

			for _, f := range formatFiles {
				format := strings.ToLower(strings.TrimSpace(f.Format))
				rawRel := strings.TrimSpace(f.RelativePath)
				if format == "" || rawRel == "" {
					continue
				}
				sourceRel := strings.TrimPrefix(strings.TrimPrefix(rawRel, "library/"), "library\\")
				sourceRel = strings.TrimPrefix(strings.TrimPrefix(sourceRel, "calibre/"), "calibre\\")

				sourceAbs, cerr := confinedCalibrePath(s.calibreDir, sourceRel)
				if cerr != nil {
					summary.Results.Warnings = append(summary.Results.Warnings, fmt.Sprintf("Invalid or missing Calibre source: %s", sourceRel))
					continue
				}

				destFileName := bookTitle + "." + format
				relativePath := storage.BuildBookStorageRelativePath(effectiveAuthorNames, bookTitle, delbBookID, destFileName)
				destAbs, derr := storage.ResolveUnderLibrary(s.libraryDir, relativePath)
				if derr != nil {
					summary.Results.Warnings = append(summary.Results.Warnings, fmt.Sprintf("Failed to resolve destination for calibreBookId=%d: %s", calibreBook.CalibreBookID, sourceRel))
					continue
				}

				if !existsFile(sourceAbs) {
					summary.Results.Warnings = append(summary.Results.Warnings, fmt.Sprintf("Missing source file for calibreBookId=%d: %s", calibreBook.CalibreBookID, sourceRel))
					continue
				}

				if !body.DryRun {
					if _, cerr := copyFileIfMissing(sourceAbs, destAbs); cerr != nil {
						s.logger.Warn("calibre import: failed to copy format file", "error", cerr)
						summary.Results.Warnings = append(summary.Results.Warnings, fmt.Sprintf("Failed to copy file for calibreBookId=%d: %s", calibreBook.CalibreBookID, sourceRel))
						continue
					}
					var existingFileID string
					err := tx.QueryRowContext(ctx, `
						SELECT id FROM book_files WHERE book_id = ? AND relative_path = ? LIMIT 1
					`, delbBookID, relativePath).Scan(&existingFileID)
					if errors.Is(err, sql.ErrNoRows) {
						if _, ierr := tx.ExecContext(ctx, `
							INSERT INTO book_files (id, book_id, format, relative_path, created_at)
							VALUES (?, ?, ?, ?, ?)
						`, uuid.NewString(), delbBookID, format, relativePath, nowSec); ierr != nil {
							return ierr
						}
						summary.Results.FilesUpserted++
					} else if err != nil {
						return err
					}
				} else {
					summary.Results.FilesUpserted++
				}
			}

			return tx.Commit()
		}

		if body.DryRun {
			err = perform()
		} else {
			err = storage.WithBookStorageLock(ctx, s.libraryDir, delbBookID, perform)
		}
		if err != nil {
			s.writeErr(w, "POST /api/settings/admin/calibre book import failed", err)
			return
		}
	}

	if hasBooks, _ := reader.hasTable(ctx, "books"); !hasBooks {
		summary.Results.Warnings = append(summary.Results.Warnings, "Calibre DB missing `books` table (unexpected).")
	}

	s.logger.InfoContext(ctx, "completed calibre operation",
		"action", body.Action,
		"dryRun", body.DryRun,
		"actorUserId", userID,
		"scannedBooks", summary.Scanned.CalibreBooks,
		"booksCreated", summary.Results.BooksCreated,
		"booksUpdated", summary.Results.BooksUpdated,
		"filesUpserted", summary.Results.FilesUpserted,
		"warnings", len(summary.Results.Warnings),
		"durationMs", time.Since(startTime).Milliseconds(),
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    summary,
	})
}
