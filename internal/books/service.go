package books

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const iso8601Millis = "2006-01-02T15:04:05.000Z"

var userBookStatuses = []string{"to_be_read", "reading", "finished", "dnf"}

func isValidBookStatus(s string) bool {
	for _, st := range userBookStatuses {
		if st == s {
			return true
		}
	}
	return false
}

// ServiceOptions configures the Books/Catalog/ReadingState/TBR/Dashboard/Search service.
type ServiceOptions struct {
	DB                  *sql.DB
	AuthService         *auth.Service
	LibraryDir          string
	Logger              *slog.Logger
	HTTPClient          *http.Client
	GoogleBooksEndpoint string
}

// Service implements all Phase 2B HTTP endpoints.
type Service struct {
	db                  *sql.DB
	auth                *auth.Service
	libraryDir          string
	logger              *slog.Logger
	httpClient          *http.Client
	googleBooksEndpoint string
}

func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	libraryDir := opts.LibraryDir
	if libraryDir == "" {
		libraryDir = "library"
	}
	absLib, err := filepath.Abs(libraryDir)
	if err == nil {
		libraryDir = absLib
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	gbEndpoint := strings.TrimSpace(opts.GoogleBooksEndpoint)
	if gbEndpoint == "" {
		gbEndpoint = googleBooksEndpoint
	}
	return &Service{
		db:                  opts.DB,
		auth:                opts.AuthService,
		libraryDir:          libraryDir,
		logger:              logger,
		httpClient:          httpClient,
		googleBooksEndpoint: gbEndpoint,
	}
}

// RegisterRoutes mounts all Phase 2B routes onto mux.
// IMPORTANT: /api/books/{id}/spine, /api/books/{id}/spine-generate*, and
// /api/books/{id}/shelves are intentionally NOT registered here so they fall
// through cleanly to Nitro until Phase 2C.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	reqSess := func(h http.HandlerFunc) http.HandlerFunc {
		return httpapi.RequireSessionFunc(s.auth, s.logger, h)
	}

	// Books core CRUD
	mux.HandleFunc("GET /api/books", reqSess(s.handleListBooks))
	mux.HandleFunc("POST /api/books", reqSess(s.handleCreateBook))
	mux.HandleFunc("GET /api/books/{id}", reqSess(s.handleGetBook))
	mux.HandleFunc("PUT /api/books/{id}", reqSess(s.handleUpdateBook))
	mux.HandleFunc("DELETE /api/books/{id}", reqSess(s.handleDeleteBook))

	// Books uploads, covers, downloads, files
	mux.HandleFunc("POST /api/books/upload", reqSess(s.handleUploadBooks))
	mux.HandleFunc("GET /api/books/{id}/cover", reqSess(s.handleGetBookCover))
	mux.HandleFunc("POST /api/books/{id}/cover", reqSess(s.handleUploadBookCover))
	mux.HandleFunc("GET /api/books/{id}/download", reqSess(s.handleDownloadBook))
	mux.HandleFunc("GET /api/books/{id}/files", reqSess(s.handleListBookFiles))

	// Books collections, moves, bulk operations
	mux.HandleFunc("GET /api/books/{id}/collections", reqSess(s.handleGetBookCollections))
	mux.HandleFunc("PUT /api/books/{id}/collections", reqSess(s.handlePutBookCollections))
	mux.HandleFunc("POST /api/books/move", reqSess(s.handleMoveBooks))
	mux.HandleFunc("POST /api/books/collection-sources", reqSess(s.handleBookCollectionSources))
	mux.HandleFunc("POST /api/books/bulk/copies", reqSess(s.handleBulkCopies))
	mux.HandleFunc("POST /api/books/bulk/status", reqSess(s.handleBulkStatus))

	// Metadata search & import (note: GET /api/books/metadata/search matches Nitro without auth check)
	mux.HandleFunc("GET /api/books/metadata/search", s.handleMetadataSearch)
	mux.HandleFunc("GET /api/books/metadata/hardcover/search", reqSess(s.handleHardcoverSearch))
	mux.HandleFunc("GET /api/books/metadata/cover", reqSess(s.handleMetadataCover))
	mux.HandleFunc("POST /api/books/metadata-import/create", reqSess(s.handleMetadataImportCreate))

	// Reading state, progress, TBR & Dashboard
	mux.HandleFunc("POST /api/books/{id}/rating", reqSess(s.handlePostRating))
	mux.HandleFunc("GET /api/books/{id}/status", reqSess(s.handleGetStatus))
	mux.HandleFunc("POST /api/books/{id}/status", reqSess(s.handlePostStatus))
	mux.HandleFunc("GET /api/books/{id}/rationale", reqSess(s.handleGetRationale))
	mux.HandleFunc("PUT /api/books/{id}/rationale", reqSess(s.handlePutRationale))
	mux.HandleFunc("GET /api/books/{id}/reading-position", reqSess(s.handleGetReadingPosition))
	mux.HandleFunc("PUT /api/books/{id}/reading-position", reqSess(s.handlePutReadingPosition))
	mux.HandleFunc("GET /api/books/{id}/progress", reqSess(s.handleGetProgress))
	mux.HandleFunc("GET /api/books/{id}/progress-logs", reqSess(s.handleGetProgressLogs))
	mux.HandleFunc("POST /api/books/{id}/progress-logs", reqSess(s.handlePostProgressLog))
	mux.HandleFunc("PUT /api/books/{id}/progress-sync", reqSess(s.handlePutProgressSync))
	mux.HandleFunc("GET /api/tbr", reqSess(s.handleGetTbr))
	mux.HandleFunc("GET /api/dashboard", s.handleGetDashboard)

	// Catalog entities & global search
	mux.HandleFunc("GET /api/authors", reqSess(s.handleListAuthors))
	mux.HandleFunc("GET /api/authors/search", s.handleSearchAuthors)
	mux.HandleFunc("GET /api/authors/{id}/books", reqSess(s.handleListAuthorBooks))

	mux.HandleFunc("GET /api/publishers", reqSess(s.handleListPublishers))
	mux.HandleFunc("GET /api/publishers/search", s.handleSearchPublishers)
	mux.HandleFunc("GET /api/publishers/{id}/books", reqSess(s.handleListPublisherBooks))

	mux.HandleFunc("GET /api/series", reqSess(s.handleListSeries))
	mux.HandleFunc("GET /api/series/search", s.handleSearchSeries)
	mux.HandleFunc("GET /api/series/{id}/books", reqSess(s.handleListSeriesBooks))

	mux.HandleFunc("GET /api/tags", reqSess(s.handleListTags))
	mux.HandleFunc("GET /api/tags/search", s.handleSearchTags)
	mux.HandleFunc("GET /api/tags/{id}/books", reqSess(s.handleListTagBooks))
	mux.HandleFunc("DELETE /api/tags/{id}", reqSess(s.handleDeleteTag))
	mux.HandleFunc("POST /api/tags/{id}/merge", reqSess(s.handleMergeTag))

	mux.HandleFunc("GET /api/search", reqSess(s.handleGlobalSearch))
}

func (s *Service) writeErr(w http.ResponseWriter, logMsg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

func (s *Service) writeErrWithFallback(w http.ResponseWriter, logMsg string, fallback string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, fallback)
}

func formatUnixSecISO(sec int64) string {
	return time.Unix(sec, 0).UTC().Format(iso8601Millis)
}

func formatNullUnixSecISO(v sql.NullInt64) *string {
	if !v.Valid {
		return nil
	}
	s := formatUnixSecISO(v.Int64)
	return &s
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

func makePlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

func clampIntQuery(raw string, minVal, maxVal, fallback int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
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

func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func uniqByLower(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, v := range values {
		cleaned := strings.TrimSpace(v)
		if cleaned == "" {
			continue
		}
		k := strings.ToLower(cleaned)
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, cleaned)
	}
	return out
}

func getUserMemberCollectionIDs(ctx context.Context, q collections.Queryable, userID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT collection_id FROM collection_members WHERE user_id = ?`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	seen := make(map[string]struct{})
	var ids []string
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		if cid == "" {
			continue
		}
		if _, ok := seen[cid]; !ok {
			seen[cid] = struct{}{}
			ids = append(ids, cid)
		}
	}
	return ids, rows.Err()
}

func isBookVisibleToUser(ctx context.Context, q collections.Queryable, userID, bookID string) (bool, error) {
	var found string
	err := q.QueryRowContext(ctx, `
		SELECT b.id
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func findOrCreateAuthorByName(ctx context.Context, q collections.Queryable, name string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM authors WHERE name = ? LIMIT 1`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = uuid.NewString()
	now := time.Now().UTC().Unix()
	if _, err := q.ExecContext(ctx, `
		INSERT INTO authors (id, name, sort_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
	`, id, name, MakeAuthorSortKey(name), now, now); err != nil {
		return "", err
	}
	return id, nil
}

func findOrCreateTagByName(ctx context.Context, q collections.Queryable, name string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM tags WHERE name = ? LIMIT 1`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = uuid.NewString()
	now := time.Now().UTC().Unix()
	if _, err := q.ExecContext(ctx, `
		INSERT INTO tags (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, id, name, now, now); err != nil {
		return "", err
	}
	return id, nil
}

func findOrCreatePublisherByName(ctx context.Context, q collections.Queryable, name string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM publishers WHERE name = ? LIMIT 1`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = uuid.NewString()
	now := time.Now().UTC().Unix()
	if _, err := q.ExecContext(ctx, `
		INSERT INTO publishers (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, id, name, now, now); err != nil {
		return "", err
	}
	return id, nil
}

func findOrCreateSeriesByName(ctx context.Context, q collections.Queryable, name string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM series WHERE name = ? LIMIT 1`, name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = uuid.NewString()
	now := time.Now().UTC().Unix()
	if _, err := q.ExecContext(ctx, `
		INSERT INTO series (id, name, created_at, updated_at)
		VALUES (?, ?, ?, ?)
	`, id, name, now, now); err != nil {
		return "", err
	}
	return id, nil
}

func deleteAuthorIfUnreferenced(ctx context.Context, q collections.Queryable, authorID string) error {
	var used string
	err := q.QueryRowContext(ctx, `SELECT author_id FROM book_authors WHERE author_id = ? LIMIT 1`, authorID).Scan(&used)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = q.ExecContext(ctx, `DELETE FROM authors WHERE id = ?`, authorID)
	return err
}

func deleteTagIfUnreferenced(ctx context.Context, q collections.Queryable, tagID string) error {
	var used string
	err := q.QueryRowContext(ctx, `SELECT tag_id FROM book_tags WHERE tag_id = ? LIMIT 1`, tagID).Scan(&used)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = q.ExecContext(ctx, `DELETE FROM tags WHERE id = ?`, tagID)
	return err
}

func deletePublisherIfUnreferenced(ctx context.Context, q collections.Queryable, publisherID string) error {
	var used string
	err := q.QueryRowContext(ctx, `SELECT id FROM books WHERE publisher_id = ? LIMIT 1`, publisherID).Scan(&used)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = q.ExecContext(ctx, `DELETE FROM publishers WHERE id = ?`, publisherID)
	return err
}

func deleteSeriesIfUnreferenced(ctx context.Context, q collections.Queryable, seriesID string) error {
	var used string
	err := q.QueryRowContext(ctx, `SELECT id FROM books WHERE series_id = ? LIMIT 1`, seriesID).Scan(&used)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = q.ExecContext(ctx, `DELETE FROM series WHERE id = ?`, seriesID)
	return err
}
