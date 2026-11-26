package books

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

// catalogEntryInput holds the shared metadata for a new catalog entry.
type catalogEntryInput struct {
	Title           string
	Authors         []string
	Description     *string
	Language        *string
	Published       *string
	PublishedAt     *int64
	Publisher       *string
	Series          *string
	SeriesIndex     *float64
	Pages           *int64
	Categories      []string
	Identifiers     []IdentifierInput
	CoverURL        string
	HasPhysicalCopy bool

	RequirePrivateCollection bool
}

// createCatalogEntry inserts a book without ebook files into collectionID, then
// creates its canonical directory and fetches its cover on a best-effort basis.
func (s *Service) createCatalogEntry(ctx context.Context, userID, collectionID string, in catalogEntryInput) (string, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = "Untitled"
	}
	authorNames := uniqByLower(in.Authors)
	if len(authorNames) == 0 {
		authorNames = []string{"Unknown Author"}
	}
	collectionIDs := []string{collectionID}

	bookID := uuid.NewString()
	now := time.Now().UTC().Unix()
	physInt := 0
	if in.HasPhysicalCopy {
		physInt = 1
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(ctx, tx); err != nil {
		return "", err
	}
	if _, err := collections.ResolveBookTarget(ctx, tx, userID, true, collectionIDs); err != nil {
		return "", err
	}

	if in.RequirePrivateCollection {
		if err := collections.AssertCollectionPrivate(ctx, tx, userID, collectionID); err != nil {
			return "", err
		}
	}

	var publisherID, seriesID *string
	var seriesIndex *float64
	if in.Publisher != nil && strings.TrimSpace(*in.Publisher) != "" {
		pid, err := findOrCreatePublisherByName(ctx, tx, strings.TrimSpace(*in.Publisher))
		if err != nil {
			return "", err
		}
		publisherID = &pid
	}
	if in.Series != nil && strings.TrimSpace(*in.Series) != "" {
		sid, err := findOrCreateSeriesByName(ctx, tx, strings.TrimSpace(*in.Series))
		if err != nil {
			return "", err
		}
		seriesID = &sid
		seriesIndex = in.SeriesIndex
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO books (
			id, collection_id, added_by_user_id, added_at,
			title, sort_title, description, published, published_at,
			language, pages, has_physical_copy, publisher_id, series_id, series_index,
			created_by_user_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, bookID, collectionID, userID, now,
		title, MakeTitleSortKey(title), in.Description, in.Published, in.PublishedAt,
		in.Language, in.Pages, physInt, publisherID, seriesID, seriesIndex,
		userID, now, now); err != nil {
		return "", err
	}

	for i, name := range authorNames {
		aid, err := findOrCreateAuthorByName(ctx, tx, name)
		if err != nil {
			return "", err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)`, bookID, aid, i+1); err != nil {
			return "", err
		}
	}
	for _, name := range uniqByLower(in.Categories) {
		gid, err := findOrCreateGenreByName(ctx, tx, name)
		if err != nil {
			return "", err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO book_genres (book_id, genre_id) VALUES (?, ?) ON CONFLICT(book_id, genre_id) DO NOTHING`, bookID, gid); err != nil {
			return "", err
		}
	}
	seenIdent := make(map[string]struct{}, len(in.Identifiers))
	for _, ident := range in.Identifiers {
		t := strings.ToLower(strings.TrimSpace(ident.Type))
		v := strings.TrimSpace(ident.Value)
		if t == "" || v == "" {
			continue
		}
		if _, dup := seenIdent[t]; dup {
			continue
		}
		seenIdent[t] = struct{}{}
		if _, err := tx.ExecContext(ctx, `INSERT INTO book_identifiers (book_id, type, value) VALUES (?, ?, ?)`, bookID, t, v); err != nil {
			return "", err
		}
	}

	if err := tx.Commit(); err != nil {
		return "", err
	}

	s.ensureCanonicalDirBestEffort(authorNames, title, bookID)
	if in.CoverURL != "" {
		validateDest := func(tx *sql.Tx, id string) error {
			target, err := collections.ResolveBookTarget(ctx, tx, userID, true, collectionIDs)
			if err != nil {
				return err
			}
			cur, err := collections.AssertBookEditor(ctx, tx, userID, id)
			if err != nil {
				return err
			}
			if cur != target {
				return httpapi.NewError(http.StatusConflict, "This entry belongs to another collection.")
			}
			return nil
		}
		_ = storage.WithBookStorageLock(ctx, s.libraryDir, bookID, func() error {
			s.fetchAndAttachImportedCoverBestEffort(ctx, userID, collectionIDs, bookID, authorNames, title, in.CoverURL, validateDest)
			return nil
		})
	}
	return bookID, nil
}

// ImportedBook describes a catalog entry that an external import creates.
type ImportedBook struct {
	Title           string
	Authors         []string
	SeriesName      string
	SeriesIndex     *float64
	Publisher       string
	Published       string
	Pages           *int64
	Identifiers     []IdentifierInput
	HasPhysicalCopy bool
}

// ImportedBookResult reports how CreateImportedBook created an entry.
type ImportedBookResult struct {
	BookID   string
	Enriched bool
	// EnrichmentError is set when enrichment was requested but the provider
	// returned no acceptable record. The entry is still created from the
	// imported data.
	EnrichmentError string
}

func optionalString(s string) *string {
	t := strings.TrimSpace(s)
	if t == "" {
		return nil
	}
	return &t
}

type ImportedBookOptions struct {
	Enrich      bool
	AllowShared bool
}

// CreateImportedBook creates a catalog entry (without ebook files) from imported
// data. When enrich is true, it first looks the book up with the default
// metadata provider and fills in description, cover, and other fields from an
// accepted result.
func (s *Service) CreateImportedBook(ctx context.Context, userID, collectionID string, in ImportedBook, options ImportedBookOptions) (ImportedBookResult, error) {
	entry := catalogEntryInput{
		Title:           in.Title,
		Authors:         in.Authors,
		Publisher:       optionalString(in.Publisher),
		Series:          optionalString(in.SeriesName),
		SeriesIndex:     in.SeriesIndex,
		Pages:           in.Pages,
		Identifiers:     append([]IdentifierInput(nil), in.Identifiers...),
		HasPhysicalCopy: in.HasPhysicalCopy,

		RequirePrivateCollection: !options.AllowShared,
	}
	if p := optionalString(in.Published); p != nil {
		entry.Published = p
		entry.PublishedAt = NormalizePublishedAtUnix(*p)
	}

	result := ImportedBookResult{}
	if options.Enrich {
		item, err := s.lookupImportedBook(ctx, in)
		if err != nil {
			result.EnrichmentError = err.Error()
		} else {
			mergeProviderRecord(&entry, item)
			result.Enriched = true
		}
	}

	bookID, err := s.createCatalogEntry(ctx, userID, collectionID, entry)
	if err != nil {
		return ImportedBookResult{}, err
	}
	result.BookID = bookID
	return result, nil
}

func firstISBN(idents []IdentifierInput) string {
	for _, want := range []string{"isbn13", "isbn10", "isbn"} {
		for _, id := range idents {
			if strings.EqualFold(id.Type, want) && strings.TrimSpace(id.Value) != "" {
				return strings.TrimSpace(id.Value)
			}
		}
	}
	return ""
}

var errNoAcceptableMatch = errors.New("no matching metadata record")

// lookupImportedBook asks the default provider for the book and accepts the top
// result only when it plausibly describes the same title and author.
func (s *Service) lookupImportedBook(ctx context.Context, in ImportedBook) (*googleBookItem, error) {
	provider := s.getDefaultMetadataProvider(ctx)
	author := ""
	if len(in.Authors) > 0 {
		author = in.Authors[0]
	}
	titleTokens := FuzzyTokens(in.Title)
	authorTokens := FuzzyTokens(author)

	accept := func(item *googleBookItem, threshold float64) bool {
		if item == nil {
			return false
		}
		score := FuzzyTitleAuthorScore(titleTokens, authorTokens,
			FuzzyTokens(item.VolumeInfo.Title), FuzzyTokens(strings.Join(item.VolumeInfo.Authors, " ")))
		return score >= threshold
	}

	if isbn := firstISBN(in.Identifiers); isbn != "" {
		query := isbn
		if provider != "hardcover" {
			query = "isbn:" + isbn
		}
		_, item, err := s.fetchTopMetadataItem(ctx, query)
		// An ISBN lookup can return a record whose title differs in
		// subtitle or edition wording, so it needs only a loose title match.
		if err == nil && accept(item, 0.4) {
			return item, nil
		}
		if err != nil && isProviderUnavailable(err) {
			return nil, err
		}
	}

	query := strings.TrimSpace(in.Title + " " + author)
	if query == "" {
		return nil, errNoAcceptableMatch
	}
	_, item, err := s.fetchTopMetadataItem(ctx, query)
	if err != nil {
		return nil, err
	}
	if !accept(item, FuzzyDuplicateThreshold) {
		return nil, errNoAcceptableMatch
	}
	return item, nil
}

func isProviderUnavailable(err error) bool {
	var httpErr *httpapi.HTTPError
	if errors.As(err, &httpErr) {
		return httpErr.Status != http.StatusNotFound
	}
	return true
}

// mergeProviderRecord fills fields that the import lacks from a provider record.
// The imported title and authors are kept, because they describe the edition
// that the reader recorded and are what later imports match against.
func mergeProviderRecord(entry *catalogEntryInput, item *googleBookItem) {
	vi := item.VolumeInfo
	if d := optionalString(vi.Description); d != nil {
		entry.Description = d
	}
	if l := optionalString(vi.Language); l != nil {
		entry.Language = l
	}
	if entry.Published == nil {
		if p := optionalString(vi.PublishedDate); p != nil {
			entry.Published = p
			entry.PublishedAt = NormalizePublishedAtUnix(*p)
		}
	}
	if entry.Publisher == nil {
		entry.Publisher = optionalString(vi.Publisher)
	}
	if entry.Series == nil {
		if sn := optionalString(vi.Series); sn != nil {
			entry.Series = sn
			if vi.SeriesIndex != nil && !math.IsNaN(*vi.SeriesIndex) && !math.IsInf(*vi.SeriesIndex, 0) {
				v := *vi.SeriesIndex
				entry.SeriesIndex = &v
			}
		}
	}
	if entry.Pages == nil && vi.PageCount != nil && !math.IsNaN(*vi.PageCount) && !math.IsInf(*vi.PageCount, 0) && *vi.PageCount > 0 {
		p := int64(*vi.PageCount)
		entry.Pages = &p
	}
	entry.Categories = vi.Categories
	have := make(map[string]struct{}, len(entry.Identifiers))
	for _, id := range entry.Identifiers {
		have[strings.ToLower(id.Type)] = struct{}{}
	}
	for _, raw := range vi.IndustryIdentifiers {
		t := normalizeProviderIdentifierType(raw.Type)
		v := identStripDashRe.ReplaceAllString(strings.TrimSpace(raw.Identifier), "")
		if t == "" || v == "" {
			continue
		}
		if _, ok := have[t]; ok {
			continue
		}
		have[t] = struct{}{}
		entry.Identifiers = append(entry.Identifiers, IdentifierInput{Type: t, Value: v})
	}
	if vi.ImageLinks != nil {
		cover := vi.ImageLinks.Thumbnail
		if cover == "" {
			cover = vi.ImageLinks.SmallThumbnail
		}
		entry.CoverURL = strings.ReplaceAll(cover, "&edge=curl", "")
	}
}

// ImportedReading holds the personal reading data that an import applies to one book.
type ImportedReading struct {
	BookID string
	// Status is nil when the import leaves the status unchanged.
	Status *string
	// EndedAt is the finish date for "finished" or the DNF date for "dnf".
	// A nil value leaves that date empty rather than defaulting to today.
	EndedAt *int64
	// TbrOrder orders books that join the To be read queue. Lower values come first.
	TbrOrder int
	// Rating is on Delb's 1..10 half-star scale. Nil leaves the rating unchanged.
	Rating         *int
	Review         string
	ReviewSpoilers bool
	Note           string
	// Overwrite replaces existing Delb values that differ from the imported ones.
	Overwrite bool
}

// ImportReadingResult counts what ApplyImportedReading changed.
type ImportReadingResult struct {
	StatusesSet  int      `json:"statusesSet"`
	StatusesKept int      `json:"statusesKept"`
	RatingsSet   int      `json:"ratingsSet"`
	RatingsKept  int      `json:"ratingsKept"`
	ReviewsSet   int      `json:"reviewsSet"`
	ReviewsKept  int      `json:"reviewsKept"`
	NotesAdded   int      `json:"notesAdded"`
	Unavailable  []string `json:"unavailable"`
}

// ExistingReading is a reader's current Delb data for one book.
type ExistingReading struct {
	Status    *string  `json:"status"`
	StartedAt *int64   `json:"-"`
	EndedAt   *int64   `json:"-"`
	EndedDate *string  `json:"endedDate"`
	Rating    *int     `json:"rating"`
	Review    string   `json:"review"`
	HasReview bool     `json:"hasReview"`
	TbrRank   *int64   `json:"tbrRank"`
	NoteTexts []string `json:"-"`
}

// StatusDiffers reports whether an imported status and end date would change
// the existing status. Dates are compared by calendar day.
func (e ExistingReading) StatusDiffers(status string, endedAt *int64) bool {
	if e.Status == nil {
		return false
	}
	if *e.Status != status {
		return true
	}
	if status != "finished" && status != "dnf" {
		return false
	}
	if (e.EndedAt == nil) != (endedAt == nil) {
		return true
	}
	if e.EndedAt == nil {
		return false
	}
	return calendarDateLocal(*e.EndedAt) != calendarDateLocal(*endedAt)
}

// LoadExistingReading returns the reader's current status, rating, review, and
// notes for the given books, keyed by book ID. Books without any data are omitted.
func LoadExistingReading(ctx context.Context, q collections.Queryable, userID string, bookIDs []string) (map[string]*ExistingReading, error) {
	out := make(map[string]*ExistingReading)
	get := func(id string) *ExistingReading {
		e, ok := out[id]
		if !ok {
			e = &ExistingReading{}
			out[id] = e
		}
		return e
	}
	for i := 0; i < len(bookIDs); i += 400 {
		end := i + 400
		if end > len(bookIDs) {
			end = len(bookIDs)
		}
		chunk := bookIDs[i:end]
		args := make([]any, 0, len(chunk)+1)
		args = append(args, userID)
		for _, id := range chunk {
			args = append(args, id)
		}
		ph := makePlaceholders(len(chunk))

		rows, err := q.QueryContext(ctx, `
			SELECT book_id, status, started_at, finished_at, dnf_at, tbr_rank
			FROM user_book_status WHERE user_id = ? AND book_id IN (`+ph+`)
		`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, status string
			var started, finished, dnf, rank sql.NullInt64
			if err := rows.Scan(&id, &status, &started, &finished, &dnf, &rank); err != nil {
				_ = rows.Close()
				return nil, err
			}
			e := get(id)
			st := status
			e.Status = &st
			e.StartedAt = nullInt64Ptr(started)
			if status == "finished" {
				e.EndedAt = nullInt64Ptr(finished)
			} else if status == "dnf" {
				e.EndedAt = nullInt64Ptr(dnf)
			}
			if e.EndedAt != nil {
				d := calendarDateLocal(*e.EndedAt)
				e.EndedDate = &d
			}
			e.TbrRank = nullInt64Ptr(rank)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}

		rows, err = q.QueryContext(ctx, `
			SELECT book_id, rating FROM book_ratings WHERE user_id = ? AND book_id IN (`+ph+`)
		`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			var rating int
			if err := rows.Scan(&id, &rating); err != nil {
				_ = rows.Close()
				return nil, err
			}
			r := rating
			get(id).Rating = &r
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}

		rows, err = q.QueryContext(ctx, `
			SELECT book_id, text FROM user_book_reviews WHERE user_id = ? AND book_id IN (`+ph+`)
		`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, text string
			if err := rows.Scan(&id, &text); err != nil {
				_ = rows.Close()
				return nil, err
			}
			e := get(id)
			e.Review = text
			e.HasReview = strings.TrimSpace(text) != ""
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}

		rows, err = q.QueryContext(ctx, `
			SELECT book_id, text FROM book_notes WHERE user_id = ? AND book_id IN (`+ph+`)
		`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id, text string
			if err := rows.Scan(&id, &text); err != nil {
				_ = rows.Close()
				return nil, err
			}
			e := get(id)
			e.NoteTexts = append(e.NoteTexts, text)
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// ApplyImportedReading writes imported statuses, ratings, reviews, and notes in
// one transaction. Unlike TransitionBookStatuses, it never fills a missing date
// with today's date, and it ranks newly queued To be read books after the
// existing queue in TbrOrder.
func ApplyImportedReading(ctx context.Context, db *sql.DB, userID string, items []ImportedReading, now time.Time) (ImportReadingResult, error) {
	result := ImportReadingResult{Unavailable: []string{}}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer func() { _ = tx.Rollback() }()

	ids := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, it := range items {
		if _, dup := seen[it.BookID]; dup {
			continue
		}
		seen[it.BookID] = struct{}{}
		ids = append(ids, it.BookID)
	}

	visiblePages := make(map[string]*int64, len(ids))
	for i := 0; i < len(ids); i += 400 {
		end := i + 400
		if end > len(ids) {
			end = len(ids)
		}
		chunk := ids[i:end]
		args := make([]any, 0, len(chunk)+1)
		args = append(args, userID)
		for _, id := range chunk {
			args = append(args, id)
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT b.id, b.pages FROM books b
			INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
			WHERE b.id IN (`+makePlaceholders(len(chunk))+`)
		`, args...)
		if err != nil {
			return result, err
		}
		for rows.Next() {
			var id string
			var pages sql.NullInt64
			if err := rows.Scan(&id, &pages); err != nil {
				_ = rows.Close()
				return result, err
			}
			visiblePages[id] = nullInt64Ptr(pages)
		}
		if err := rows.Close(); err != nil {
			return result, err
		}
	}

	existing, err := LoadExistingReading(ctx, tx, userID, ids)
	if err != nil {
		return result, err
	}
	nowSec := now.UTC().Unix()

	var newlyQueued []importQueued
	queueChanged := false
	handled := make(map[string]struct{}, len(items))

	for _, it := range items {
		if _, ok := visiblePages[it.BookID]; !ok {
			result.Unavailable = append(result.Unavailable, it.BookID)
			continue
		}
		if _, dup := handled[it.BookID]; dup {
			continue
		}
		handled[it.BookID] = struct{}{}
		ex := existing[it.BookID]
		if ex == nil {
			ex = &ExistingReading{}
		}

		if it.Status != nil && isValidBookStatus(*it.Status) {
			st := *it.Status
			endedAt := it.EndedAt
			if st != "finished" && st != "dnf" {
				endedAt = nil
			}
			switch {
			case ex.Status == nil || (ex.StatusDiffers(st, endedAt) && it.Overwrite):
				// Goodreads exports no start dates, so keep a recorded start
				// date when it still precedes the imported end date.
				var startedAt *int64
				if st != "to_be_read" && ex.StartedAt != nil && (endedAt == nil || *ex.StartedAt <= *endedAt) {
					startedAt = ex.StartedAt
				}
				var finishedAt, dnfAt *int64
				if st == "finished" {
					finishedAt = endedAt
				} else if st == "dnf" {
					dnfAt = endedAt
				}
				var keepRank *int64
				if st == "to_be_read" && ex.Status != nil && *ex.Status == "to_be_read" {
					keepRank = ex.TbrRank
				}
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO user_book_status (user_id, book_id, status, started_at, finished_at, dnf_at, tbr_rank, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(user_id, book_id) DO UPDATE SET
						status = excluded.status,
						started_at = excluded.started_at,
						finished_at = excluded.finished_at,
						dnf_at = excluded.dnf_at,
						tbr_rank = excluded.tbr_rank,
						updated_at = excluded.updated_at
				`, userID, it.BookID, st, startedAt, finishedAt, dnfAt, keepRank, nowSec); err != nil {
					return result, err
				}
				if st == "to_be_read" && keepRank == nil {
					newlyQueued = append(newlyQueued, importQueued{bookID: it.BookID, order: it.TbrOrder})
					queueChanged = true
				}
				if st != "to_be_read" && ex.Status != nil && *ex.Status == "to_be_read" {
					// The book left the queue; close the gap in the ranks.
					queueChanged = true
				}
				if st == "finished" && finishedAt != nil {
					if err := upsertFinishedProgressLog(ctx, tx, userID, it.BookID, visiblePages[it.BookID], *finishedAt, nowSec); err != nil {
						return result, err
					}
				}
				result.StatusesSet++
			case ex.StatusDiffers(st, endedAt):
				result.StatusesKept++
			}
		}

		if it.Rating != nil && *it.Rating >= 1 && *it.Rating <= 10 {
			switch {
			case ex.Rating == nil || (*ex.Rating != *it.Rating && it.Overwrite):
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO book_ratings (user_id, book_id, rating, updated_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT(user_id, book_id) DO UPDATE SET rating = excluded.rating, updated_at = excluded.updated_at
				`, userID, it.BookID, *it.Rating, nowSec); err != nil {
					return result, err
				}
				result.RatingsSet++
			case *ex.Rating != *it.Rating:
				result.RatingsKept++
			}
		}

		review := strings.TrimSpace(it.Review)
		if review != "" && utf16Len(review) <= MaxReviewLength {
			existingReview := strings.TrimSpace(ex.Review)
			switch {
			case existingReview == "" || (existingReview != review && it.Overwrite):
				if err := writeReview(ctx, tx, userID, it.BookID, review, it.ReviewSpoilers, nowSec); err != nil {
					return result, err
				}
				result.ReviewsSet++
			case existingReview != review:
				result.ReviewsKept++
			}
		}

		note := strings.TrimSpace(it.Note)
		if note != "" && utf16Len(note) <= MaxNoteLength {
			duplicate := false
			for _, t := range ex.NoteTexts {
				if strings.TrimSpace(t) == note {
					duplicate = true
					break
				}
			}
			if !duplicate {
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO book_notes (id, user_id, book_id, text, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?)
				`, uuid.NewString(), userID, it.BookID, note, nowSec, nowSec); err != nil {
					return result, err
				}
				result.NotesAdded++
			}
		}
	}

	if queueChanged {
		if err := rerankAfterImport(ctx, tx, userID, newlyQueued); err != nil {
			return result, err
		}
	}

	if err := tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}

func upsertFinishedProgressLog(ctx context.Context, tx *sql.Tx, userID, bookID string, pages *int64, finishedAt, nowSec int64) error {
	var logID string
	err := tx.QueryRowContext(ctx, `
		SELECT id FROM user_book_progress_log
		WHERE user_id = ? AND book_id = ? AND source = 'status-finished'
		LIMIT 1
	`, userID, bookID).Scan(&logID)
	if err == nil {
		_, err = tx.ExecContext(ctx, `
			UPDATE user_book_progress_log
			SET progress_percent = 100, page_number = ?, occurred_at = ?
			WHERE id = ?
		`, pages, finishedAt, logID)
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO user_book_progress_log (
			id, user_id, book_id, progress_percent, page_number, location, source, occurred_at, created_at
		) VALUES (?, ?, ?, 100, ?, NULL, 'status-finished', ?, ?)
	`, uuid.NewString(), userID, bookID, pages, finishedAt, nowSec)
	return err
}

type importQueued struct {
	bookID string
	order  int
}

// rerankAfterImport keeps the visible To be read queue contiguous: books that
// were already queued keep their order, and newly queued books follow them.
func rerankAfterImport(ctx context.Context, tx *sql.Tx, userID string, newlyQueued []importQueued) error {
	isNew := make(map[string]struct{}, len(newlyQueued))
	for _, q := range newlyQueued {
		isNew[q.bookID] = struct{}{}
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT ubs.book_id, ubs.tbr_rank
		FROM user_book_status ubs
		WHERE ubs.user_id = ? AND ubs.status = 'to_be_read'
		  AND EXISTS (
			SELECT 1 FROM collection_books cb
			INNER JOIN collection_members cm ON cm.collection_id = cb.collection_id
			WHERE cb.book_id = ubs.book_id AND cm.user_id = ?
		  )
	`, userID, userID)
	if err != nil {
		return err
	}
	type ranked struct {
		id   string
		rank int64
	}
	var kept []ranked
	for rows.Next() {
		var id string
		var rank sql.NullInt64
		if err := rows.Scan(&id, &rank); err != nil {
			_ = rows.Close()
			return err
		}
		if _, ok := isNew[id]; ok {
			continue
		}
		r := int64(math.MaxInt64)
		if rank.Valid {
			r = rank.Int64
		}
		kept = append(kept, ranked{id: id, rank: r})
	}
	if err := rows.Close(); err != nil {
		return err
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].rank != kept[j].rank {
			return kept[i].rank < kept[j].rank
		}
		return kept[i].id < kept[j].id
	})
	sort.SliceStable(newlyQueued, func(i, j int) bool { return newlyQueued[i].order < newlyQueued[j].order })

	order := make([]string, 0, len(kept)+len(newlyQueued))
	for _, k := range kept {
		order = append(order, k.id)
	}
	for _, q := range newlyQueued {
		order = append(order, q.bookID)
	}
	for i, id := range order {
		if _, err := tx.ExecContext(ctx, `
			UPDATE user_book_status SET tbr_rank = ? WHERE user_id = ? AND book_id = ?
		`, i+1, userID, id); err != nil {
			return err
		}
	}
	return nil
}
