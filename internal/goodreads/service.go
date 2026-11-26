package goodreads

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	maxUploadBytes   int64 = 32 << 20
	maxApplyBytes    int64 = 64 << 20
	maxRows                = 20000
	maxCreateBatch         = 50
	tbrUnrankedStart       = 1_000_000
)

// ServiceOptions configures the Goodreads import service.
type ServiceOptions struct {
	DB               *sql.DB
	AuthService      *auth.Service
	BooksService     *books.Service
	BookshelfService *bookshelf.Service
	Logger           *slog.Logger
}

// Service implements /api/import/goodreads/*.
type Service struct {
	db        *sql.DB
	auth      *auth.Service
	books     *books.Service
	bookshelf *bookshelf.Service
	logger    *slog.Logger
}

// NewService creates the Goodreads import service.
func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		db:        opts.DB,
		auth:      opts.AuthService,
		books:     opts.BooksService,
		bookshelf: opts.BookshelfService,
		logger:    logger,
	}
}

// RegisterRoutes mounts the import endpoints.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	reqSess := func(h http.HandlerFunc) http.HandlerFunc {
		return httpapi.RequireSessionFunc(s.auth, s.logger, h)
	}
	mux.HandleFunc("POST /api/import/goodreads/preview", reqSess(s.handlePreview))
	mux.HandleFunc("POST /api/import/goodreads/books", reqSess(s.handleCreateBooks))
	mux.HandleFunc("POST /api/import/goodreads/apply", reqSess(s.handleApply))
}

func (s *Service) writeErr(w http.ResponseWriter, logMsg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

// PreviewRow pairs a parsed row with the importer's match.
type PreviewRow struct {
	Row
	Match Match `json:"match"`
}

// ShelfCount summarizes one Goodreads shelf in the export.
type ShelfCount struct {
	Name     string `json:"name"`
	Count    int    `json:"count"`
	Existing bool   `json:"existing,omitempty"`
}

// Preview is the dry-run result that the import review screen displays.
type Preview struct {
	Rows             []PreviewRow                      `json:"rows"`
	Existing         map[string]*books.ExistingReading `json:"existing"`
	ExclusiveShelves []ShelfCount                      `json:"exclusiveShelves"`
	Shelves          []ShelfCount                      `json:"shelves"`
}

func readUpload(w http.ResponseWriter, r *http.Request) (io.Reader, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	mediaType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if mediaType == "multipart/form-data" {
		file, _, err := r.FormFile("file")
		if err != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Choose a Goodreads export file of at most 32 MB.")
		}
		return file, nil
	}
	return r.Body, nil
}

// POST /api/import/goodreads/preview
func (s *Service) handlePreview(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	body, err := readUpload(w, r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	rows, err := Parse(body)
	if err != nil {
		var maxErr *http.MaxBytesError
		switch {
		case errors.As(err, &maxErr):
			httpapi.WriteError(w, http.StatusRequestEntityTooLarge, "The export is larger than 32 MB.")
		case errors.Is(err, ErrNotGoodreadsExport):
			httpapi.WriteError(w, http.StatusBadRequest, "This file does not look like a Goodreads library export. Export it from My Books → Import and export.")
		default:
			httpapi.WriteError(w, http.StatusBadRequest, "Could not read the export as CSV.")
		}
		return
	}
	if len(rows) > maxRows {
		httpapi.WriteError(w, http.StatusBadRequest, fmt.Sprintf("The export has more than %d books.", maxRows))
		return
	}
	preview, err := s.buildPreview(r.Context(), userID, rows)
	if err != nil {
		s.writeErr(w, "POST /api/import/goodreads/preview failed", err)
		return
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": preview})
}

func (s *Service) buildPreview(ctx context.Context, userID string, rows []Row) (*Preview, error) {
	idx, err := loadLibrary(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	out := &Preview{Rows: make([]PreviewRow, 0, len(rows))}
	candidateIDs := make(map[string]struct{})
	exclusive := make(map[string]int)
	shelves := make(map[string]*ShelfCount)
	for _, row := range rows {
		m := idx.match(row)
		for _, c := range m.Candidates {
			candidateIDs[c.BookID] = struct{}{}
		}
		out.Rows = append(out.Rows, PreviewRow{Row: row, Match: m})
		exclusive[row.ExclusiveShelf]++
		for _, name := range row.Shelves {
			key := strings.ToLower(name)
			if sc, ok := shelves[key]; ok {
				sc.Count++
			} else {
				shelves[key] = &ShelfCount{Name: name, Count: 1}
			}
		}
	}

	ids := make([]string, 0, len(candidateIDs))
	for id := range candidateIDs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	existing, err := books.LoadExistingReading(ctx, s.db, userID, ids)
	if err != nil {
		return nil, err
	}
	out.Existing = existing

	existingShelves := make(map[string]struct{})
	shelfRows, err := s.db.QueryContext(ctx, `SELECT name FROM personal_shelves WHERE owner_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	for shelfRows.Next() {
		var name string
		if err := shelfRows.Scan(&name); err != nil {
			_ = shelfRows.Close()
			return nil, err
		}
		existingShelves[strings.ToLower(name)] = struct{}{}
	}
	if err := shelfRows.Close(); err != nil {
		return nil, err
	}

	out.ExclusiveShelves = make([]ShelfCount, 0, len(exclusive))
	for name, count := range exclusive {
		out.ExclusiveShelves = append(out.ExclusiveShelves, ShelfCount{Name: name, Count: count})
	}
	sort.Slice(out.ExclusiveShelves, func(i, j int) bool {
		return out.ExclusiveShelves[i].Count > out.ExclusiveShelves[j].Count ||
			(out.ExclusiveShelves[i].Count == out.ExclusiveShelves[j].Count && out.ExclusiveShelves[i].Name < out.ExclusiveShelves[j].Name)
	})
	out.Shelves = make([]ShelfCount, 0, len(shelves))
	for key, sc := range shelves {
		_, sc.Existing = existingShelves[key]
		out.Shelves = append(out.Shelves, *sc)
	}
	sort.Slice(out.Shelves, func(i, j int) bool {
		return out.Shelves[i].Count > out.Shelves[j].Count ||
			(out.Shelves[i].Count == out.Shelves[j].Count && strings.ToLower(out.Shelves[i].Name) < strings.ToLower(out.Shelves[j].Name))
	})
	return out, nil
}

type createBooksRequest struct {
	CollectionID string `json:"collectionId"`
	Enrich       bool   `json:"enrich"`
	AllowShared  bool   `json:"allowShared"`
	Rows         []Row  `json:"rows"`
}

// CreatedBook reports the catalog entry for one row.
type CreatedBook struct {
	Index           int    `json:"index"`
	BookID          string `json:"bookId,omitempty"`
	Reused          bool   `json:"reused,omitempty"`
	Enriched        bool   `json:"enriched,omitempty"`
	EnrichmentError string `json:"enrichmentError,omitempty"`
	Error           string `json:"error,omitempty"`
}

// POST /api/import/goodreads/books
func (s *Service) handleCreateBooks(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	var req createBooksRequest
	if err := httpapi.DecodeJSON(r, &req, 8<<20, false); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if len(req.Rows) == 0 || len(req.Rows) > maxCreateBatch {
		httpapi.WriteError(w, http.StatusBadRequest, fmt.Sprintf("Send 1 to %d books per request.", maxCreateBatch))
		return
	}
	collectionID, err := collections.ResolveBookTarget(r.Context(), s.db, userID, true, []string{strings.TrimSpace(req.CollectionID)})
	if err != nil {
		s.writeErr(w, "POST /api/import/goodreads/books target failed", err)
		return
	}

	if !req.AllowShared {
		if err := collections.AssertCollectionPrivate(r.Context(), s.db, userID, collectionID); err != nil {
			s.writeErr(w, "POST /api/import/goodreads/books privacy check failed", err)
			return
		}
	}
	options := books.ImportedBookOptions{Enrich: req.Enrich, AllowShared: req.AllowShared}

	results := make([]CreatedBook, 0, len(req.Rows))
	for _, row := range req.Rows {
		res := CreatedBook{Index: row.Index}
		if strings.TrimSpace(row.Title) == "" {
			res.Error = "Missing title"
			results = append(results, res)
			continue
		}
		if existingID, err := s.findByGoodreadsID(r.Context(), userID, row.GoodreadsID); err != nil {
			s.writeErr(w, "POST /api/import/goodreads/books lookup failed", err)
			return
		} else if existingID != "" {
			res.BookID = existingID
			res.Reused = true
			results = append(results, res)
			continue
		}
		created, err := s.books.CreateImportedBook(r.Context(), userID, collectionID, importedBookFromRow(row), options)
		if err != nil {
			var httpErr *httpapi.HTTPError
			if errors.As(err, &httpErr) {
				res.Error = httpErr.Message
			} else {
				s.logger.Error("goodreads import create failed", "error", err)
				res.Error = "Could not create this book."
			}
			results = append(results, res)
			continue
		}
		res.BookID = created.BookID
		res.Enriched = created.Enriched
		res.EnrichmentError = created.EnrichmentError
		results = append(results, res)
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": map[string]any{"results": results}})
}

func (s *Service) findByGoodreadsID(ctx context.Context, userID, goodreadsID string) (string, error) {
	goodreadsID = strings.TrimSpace(goodreadsID)
	if goodreadsID == "" {
		return "", nil
	}
	var id string
	err := s.db.QueryRowContext(ctx, `
		SELECT b.id FROM book_identifiers bi
		INNER JOIN books b ON b.id = bi.book_id
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE bi.type = 'goodreads' AND bi.value = ?
		ORDER BY b.created_at ASC LIMIT 1
	`, userID, goodreadsID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func importedBookFromRow(row Row) books.ImportedBook {
	in := books.ImportedBook{
		Title:           strings.TrimSpace(row.Title),
		Authors:         row.Authors,
		SeriesName:      row.SeriesName,
		SeriesIndex:     row.SeriesIndex,
		Publisher:       row.Publisher,
		Published:       row.Published,
		Pages:           row.Pages,
		HasPhysicalCopy: row.OwnedCopies > 0,
	}
	if v := cleanISBN(row.ISBN13); v != "" {
		in.Identifiers = append(in.Identifiers, books.IdentifierInput{Type: "isbn13", Value: v})
	}
	if v := cleanISBN(row.ISBN10); v != "" {
		in.Identifiers = append(in.Identifiers, books.IdentifierInput{Type: "isbn10", Value: v})
	}
	if v := strings.TrimSpace(row.GoodreadsID); v != "" {
		in.Identifiers = append(in.Identifiers, books.IdentifierInput{Type: "goodreads", Value: v})
	}
	return in
}

type applyItem struct {
	Index          int      `json:"index"`
	BookID         string   `json:"bookId"`
	GoodreadsID    string   `json:"goodreadsId"`
	ExclusiveShelf string   `json:"exclusiveShelf"`
	DateRead       string   `json:"dateRead"`
	DateAdded      string   `json:"dateAdded"`
	TbrPosition    *int     `json:"tbrPosition"`
	Rating         int      `json:"rating"`
	Review         string   `json:"review"`
	Spoiler        bool     `json:"spoiler"`
	PrivateNotes   string   `json:"privateNotes"`
	Shelves        []string `json:"shelves"`
	// Overwrite chooses the Goodreads value when it differs from Delb's.
	Overwrite bool `json:"overwrite"`
}

type applyInclude struct {
	Statuses bool `json:"statuses"`
	Ratings  bool `json:"ratings"`
	Reviews  bool `json:"reviews"`
	Notes    bool `json:"notes"`
	Shelves  bool `json:"shelves"`
}

type applyRequest struct {
	Items     []applyItem        `json:"items"`
	StatusMap map[string]*string `json:"statusMap"`
	Include   applyInclude       `json:"include"`
	Shelves   []string           `json:"shelves"`
}

// ApplyResult summarizes an applied import.
type ApplyResult struct {
	Reading           books.ImportReadingResult `json:"reading"`
	ShelvesCreated    int                       `json:"shelvesCreated"`
	ShelvesUpdated    int                       `json:"shelvesUpdated"`
	ShelfBooksAdded   int                       `json:"shelfBooksAdded"`
	IdentifiersLinked int                       `json:"identifiersLinked"`
	Errors            []string                  `json:"errors"`
}

func parseLocalDate(s string) *int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	t, err := time.ParseInLocation("2006-01-02", s, time.Local)
	if err != nil {
		return nil
	}
	v := t.Unix()
	return &v
}

// tbrOrder puts books with a Goodreads queue position first, then the rest by
// the date they were added to Goodreads, and then by export order.
func tbrOrder(it applyItem) int {
	if it.TbrPosition != nil && *it.TbrPosition > 0 && *it.TbrPosition < tbrUnrankedStart {
		return *it.TbrPosition
	}
	if added := parseLocalDate(it.DateAdded); added != nil {
		return tbrUnrankedStart + int(*added/86400)
	}
	return 3*tbrUnrankedStart + it.Index
}

// POST /api/import/goodreads/apply
func (s *Service) handleApply(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID
	var req applyRequest
	if err := httpapi.DecodeJSON(r, &req, maxApplyBytes, false); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if len(req.Items) == 0 || len(req.Items) > maxRows {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose at least one book to import.")
		return
	}
	statusMap := make(map[string]string, len(req.StatusMap))
	for shelf, status := range req.StatusMap {
		if status == nil || *status == "" {
			continue
		}
		switch *status {
		case "to_be_read", "reading", "finished", "dnf":
			statusMap[strings.ToLower(strings.TrimSpace(shelf))] = *status
		default:
			httpapi.WriteError(w, http.StatusBadRequest, "Choose a valid Delb status for each Goodreads shelf.")
			return
		}
	}

	readings := make([]books.ImportedReading, 0, len(req.Items))
	for _, it := range req.Items {
		it.BookID = strings.TrimSpace(it.BookID)
		if it.BookID == "" {
			continue
		}
		rd := books.ImportedReading{
			BookID:    it.BookID,
			TbrOrder:  tbrOrder(it),
			Overwrite: it.Overwrite,
		}
		if req.Include.Statuses {
			if st, ok := statusMap[strings.ToLower(strings.TrimSpace(it.ExclusiveShelf))]; ok {
				status := st
				rd.Status = &status
				if st == "finished" || st == "dnf" {
					rd.EndedAt = parseLocalDate(it.DateRead)
				}
			}
		}
		if req.Include.Ratings && it.Rating >= 1 && it.Rating <= 5 {
			v := it.Rating * 2
			rd.Rating = &v
		}
		if req.Include.Reviews {
			rd.Review = it.Review
			rd.ReviewSpoilers = it.Spoiler
		}
		if req.Include.Notes {
			rd.Note = it.PrivateNotes
		}
		readings = append(readings, rd)
	}

	reading, err := books.ApplyImportedReading(r.Context(), s.db, userID, readings, time.Now())
	if err != nil {
		s.writeErr(w, "POST /api/import/goodreads/apply reading failed", err)
		return
	}
	result := ApplyResult{Reading: reading, Errors: []string{}}
	unavailable := make(map[string]struct{}, len(reading.Unavailable))
	for _, id := range reading.Unavailable {
		unavailable[id] = struct{}{}
	}

	linked, err := s.linkGoodreadsIDs(r.Context(), userID, req.Items, unavailable)
	if err != nil {
		s.logger.Error("goodreads import identifier link failed", "error", err)
		result.Errors = append(result.Errors, "Could not record Goodreads IDs on matched books.")
	}
	result.IdentifiersLinked = linked

	if req.Include.Shelves {
		s.applyShelves(r.Context(), userID, req, unavailable, &result)
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{"success": true, "data": result})
}

// linkGoodreadsIDs records the Goodreads ID on matched books in collections the
// reader can edit, so a later import matches them directly. Books that already
// have a Goodreads ID keep it.
func (s *Service) linkGoodreadsIDs(ctx context.Context, userID string, items []applyItem, unavailable map[string]struct{}) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := collections.LockCollectionChanges(ctx, tx); err != nil {
		return 0, err
	}
	linked := 0
	for _, it := range items {
		bookID := strings.TrimSpace(it.BookID)
		gid := strings.TrimSpace(it.GoodreadsID)
		if bookID == "" || gid == "" {
			continue
		}
		if _, skip := unavailable[bookID]; skip {
			continue
		}
		res, err := tx.ExecContext(ctx, `
			INSERT INTO book_identifiers (book_id, type, value)
			SELECT ?, 'goodreads', ?
			WHERE EXISTS (
				SELECT 1 FROM books b
				INNER JOIN collection_members cm ON cm.collection_id = b.collection_id
				WHERE b.id = ? AND cm.user_id = ? AND cm.role IN ('owner', 'editor')
			)
			AND NOT EXISTS (
				SELECT 1 FROM book_identifiers WHERE book_id = ? AND type = 'goodreads'
			)
		`, bookID, gid, bookID, userID, bookID)
		if err != nil {
			return 0, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			linked++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return linked, nil
}

func (s *Service) applyShelves(ctx context.Context, userID string, req applyRequest, unavailable map[string]struct{}, result *ApplyResult) {
	wanted := make(map[string]string)
	order := make([]string, 0, len(req.Shelves))
	for _, name := range req.Shelves {
		clean := strings.TrimSpace(name)
		key := strings.ToLower(clean)
		if clean == "" {
			continue
		}
		if _, ok := wanted[key]; ok {
			continue
		}
		wanted[key] = clean
		order = append(order, key)
	}
	members := make(map[string][]string)
	for _, it := range req.Items {
		bookID := strings.TrimSpace(it.BookID)
		if bookID == "" {
			continue
		}
		if _, skip := unavailable[bookID]; skip {
			continue
		}
		for _, name := range it.Shelves {
			key := strings.ToLower(strings.TrimSpace(name))
			if _, ok := wanted[key]; ok {
				members[key] = append(members[key], bookID)
			}
		}
	}
	for _, key := range order {
		ids := members[key]
		if len(ids) == 0 {
			continue
		}
		shelfID, created, err := s.bookshelf.EnsureNamedShelf(ctx, userID, wanted[key])
		if err != nil {
			result.Errors = append(result.Errors, fmt.Sprintf("Could not create the shelf %q.", wanted[key]))
			continue
		}
		before := s.shelfSize(ctx, shelfID)
		if _, err := s.bookshelf.ChangeShelfBooks(ctx, userID, shelfID, ids, "add", nil); err != nil {
			var httpErr *httpapi.HTTPError
			msg := "Could not add books to the shelf."
			if errors.As(err, &httpErr) {
				msg = httpErr.Message
			} else {
				s.logger.Error("goodreads import shelf update failed", "error", err)
			}
			result.Errors = append(result.Errors, fmt.Sprintf("%s (%s)", msg, wanted[key]))
			continue
		}
		if created {
			result.ShelvesCreated++
		} else {
			result.ShelvesUpdated++
		}
		result.ShelfBooksAdded += s.shelfSize(ctx, shelfID) - before
	}
}

func (s *Service) shelfSize(ctx context.Context, shelfID string) int {
	var n int
	_ = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM personal_shelf_books WHERE shelf_id = ?`, shelfID).Scan(&n)
	return n
}
