package dropbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/epub"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

const maxDropboxFileBytes int64 = 100 * 1024 * 1024

var supportedBookFormats = []string{"epub", "pdf", "mobi", "azw3"}

type IngestResult struct {
	BookID       string
	RelativePath string
	Title        string
	Author       string
	Format       string
}

func ensureSupportedBookFormat(filename string) (string, error) {
	ext := strings.ToLower(strings.TrimPrefix(filepath.Ext(filename), "."))
	for _, f := range supportedBookFormats {
		if ext == f {
			return ext, nil
		}
	}
	return "", httpapi.NewError(http.StatusBadRequest, "Unsupported format. Supported: .epub, .pdf, .mobi, .azw3")
}

func readBoundedFile(absPath string, maxBytes int64) ([]byte, error) {
	f, err := os.Open(absPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maxBytes {
		return nil, errors.New("Dropbox file exceeds the 100 MiB limit")
	}
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, errors.New("Dropbox file exceeds the 100 MiB limit")
	}
	return data, nil
}

func findOrCreateAuthorByName(ctx context.Context, q collections.Queryable, name string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM authors WHERE name = ? LIMIT 1`, name).Scan(&id)
	if err == nil && id != "" {
		return id, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = uuid.NewString()
	nowSec := time.Now().UTC().Unix()
	if _, err := q.ExecContext(ctx, `
		INSERT INTO authors (id, name, sort_name, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?)
	`, id, name, books.MakeAuthorSortKey(name), nowSec, nowSec); err != nil {
		return "", err
	}
	return id, nil
}

func ingestDropboxFile(
	ctx context.Context,
	db *sql.DB,
	libraryDir string,
	logger *slog.Logger,
	fileAbs, originalFilename, operationID string,
	target Target,
) (*IngestResult, error) {
	format, err := ensureSupportedBookFormat(originalFilename)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(fileAbs)
	if err != nil {
		return nil, err
	}
	if st.Size() > maxDropboxFileBytes {
		return nil, errors.New("Dropbox file exceeds the 100 MiB limit")
	}
	buf, err := readBoundedFile(fileAbs, maxDropboxFileBytes)
	if err != nil {
		return nil, err
	}

	fallbackTitle := strings.TrimSuffix(filepath.Base(originalFilename), filepath.Ext(originalFilename))
	if fallbackTitle == "" {
		fallbackTitle = "Untitled"
	}

	var (
		title       = fallbackTitle
		authorName  = "Unknown Author"
		description string
		language    string
		published   string
	)
	if format == "epub" {
		meta, err := epub.ParseMetadataFromBytes(buf, fallbackTitle)
		if err != nil {
			return nil, err
		}
		if meta.Title != "" {
			title = meta.Title
		}
		if meta.Author != "" {
			authorName = meta.Author
		}
		description = meta.Description
		language = meta.Language
		published = meta.Published
	}

	bookID := uuid.NewString()
	safeTitle := storage.ToSafePathSegment(title, "Untitled", 80)
	relativePath := storage.BuildBookStorageRelativePath([]string{authorName}, title, bookID, safeTitle+"."+format)
	absoluteDest, err := storage.ResolveUnderLibrary(libraryDir, relativePath)
	if err != nil {
		return nil, err
	}
	bookDirAbs := filepath.Dir(absoluteDest)

	if err := os.MkdirAll(filepath.Dir(bookDirAbs), 0o755); err != nil {
		return nil, err
	}
	if err := os.Mkdir(bookDirAbs, 0o755); err != nil {
		return nil, err
	}

	cleanupOnFailure := true
	defer func() {
		if cleanupOnFailure {
			_ = os.RemoveAll(bookDirAbs)
		}
	}()

	if err := storage.CopyVerifiedExclusive(fileAbs, absoluteDest); err != nil {
		return nil, err
	}

	var coverImagePath *string
	if format == "epub" {
		if coverBytes, mimeType, ok, cerr := epub.ExtractCoverFromBytes(buf); cerr == nil && ok && len(coverBytes) > 0 {
			dirRelPosix := filepath.ToSlash(filepath.Dir(relativePath))
			if _, thumb, _, eerr := books.EnsureCoverOutputsFromBytes(coverBytes, mimeType, "", books.CoverProcessingOpts{
				OutputDirAbs:      bookDirAbs,
				OutputDirRelPosix: dirRelPosix,
				SourceBaseName:    "source",
				ThumbFileName:     "thumb.webp",
				ThumbMaxWidth:     320,
			}); eerr == nil {
				p := thumb.RelativePath
				coverImagePath = &p
			} else if logger != nil {
				logger.Debug("dropbox: failed to extract cover (continuing without cover)", "error", eerr)
			}
		} else if cerr != nil && logger != nil {
			logger.Debug("dropbox: failed to extract cover (continuing without cover)", "error", cerr)
		}
	}

	nowSec := time.Now().UTC().Unix()
	var descPtr, pubPtr, langPtr *string
	var pubAtPtr *int64
	if description != "" {
		d := description
		descPtr = &d
	}
	if published != "" {
		p := published
		pubPtr = &p
		pubAtPtr = books.NormalizePublishedAtUnix(published)
	}
	if language != "" {
		l := language
		langPtr = &l
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(ctx, tx); err != nil {
		return nil, err
	}
	collectionID, err := collections.ResolveBookTarget(ctx, tx, target.OwnerUserID, len(target.CollectionIDs) > 0, target.CollectionIDs)
	if err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO storage_operations (id, book_id, kind, created_at)
		VALUES (?, ?, 'dropbox', ?)
	`, operationID, bookID, nowSec); err != nil {
		return nil, fmt.Errorf("insert dropbox storage operation: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO books (
			id, collection_id, added_by_user_id, added_at,
			title, sort_title, description, published, published_at,
			language, cover_image_path, created_by_user_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, bookID, collectionID, target.OwnerUserID, nowSec,
		title, books.MakeTitleSortKey(title), descPtr, pubPtr, pubAtPtr,
		langPtr, coverImagePath, target.OwnerUserID, nowSec, nowSec); err != nil {
		return nil, fmt.Errorf("insert dropbox book: %w", err)
	}

	authorID, err := findOrCreateAuthorByName(ctx, tx, authorName)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, 1)
	`, bookID, authorID); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO book_files (id, book_id, format, relative_path, created_at)
		VALUES (?, ?, ?, ?, ?)
	`, uuid.NewString(), bookID, format, relativePath, nowSec); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	cleanupOnFailure = false

	return &IngestResult{
		BookID:       bookID,
		RelativePath: relativePath,
		Title:        title,
		Author:       authorName,
		Format:       format,
	}, nil
}
