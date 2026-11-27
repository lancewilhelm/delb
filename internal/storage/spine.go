package storage

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// SpineFileExt returns the file extension for a stored spine source MIME type.
func SpineFileExt(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg", "image/jpg":
		return "jpg"
	case "image/png":
		return "png"
	case "image/webp":
		return "webp"
	default:
		return "webp"
	}
}

// ResolveBookStorageDir locates the book's folder under libraryRoot (preferring
// existing book_files, cover_image_path, book_spines, or book_mini_covers paths,
// and falling back to the canonical Author/Title (id8) folder for reference-only books).
func ResolveBookStorageDir(ctx context.Context, db *sql.DB, libraryRoot, bookID string) (relDirPosix string, absDir string, err error) {
	absRoot, err := filepath.Abs(libraryRoot)
	if err != nil {
		return "", "", err
	}

	var title string
	var coverImagePath sql.NullString
	err = db.QueryRowContext(ctx, `SELECT title, cover_image_path FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&title, &coverImagePath)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if err != nil {
		return "", "", err
	}

	// 1. Prefer existing book_files folder (preferring EPUB).
	fRows, err := db.QueryContext(ctx, `SELECT format, relative_path FROM book_files WHERE book_id = ?`, bookID)
	if err != nil {
		return "", "", err
	}
	var firstFilePath, epubFilePath string
	for fRows.Next() {
		var format, rel string
		if scanErr := fRows.Scan(&format, &rel); scanErr != nil {
			_ = fRows.Close()
			return "", "", scanErr
		}
		if rel == "" {
			continue
		}
		if firstFilePath == "" {
			firstFilePath = rel
		}
		if strings.EqualFold(format, "epub") && epubFilePath == "" {
			epubFilePath = rel
		}
	}
	if err := fRows.Close(); err != nil {
		return "", "", err
	}
	if epubFilePath != "" {
		relDirPosix = dirnamePosix(epubFilePath)
	} else if firstFilePath != "" {
		relDirPosix = dirnamePosix(firstFilePath)
	}

	// 2. Cover image folder.
	if relDirPosix == "" && coverImagePath.Valid && coverImagePath.String != "" {
		relDirPosix = dirnamePosix(coverImagePath.String)
	}

	// 3. Existing spine or mini-cover spine folder.
	if relDirPosix == "" {
		var imgPath, origPath string
		if err := db.QueryRowContext(ctx, `SELECT image_path, original_path FROM book_spines WHERE book_id = ? LIMIT 1`, bookID).Scan(&imgPath, &origPath); err == nil {
			if imgPath != "" {
				relDirPosix = dirnamePosix(imgPath)
			} else if origPath != "" {
				relDirPosix = dirnamePosix(origPath)
			}
		}
	}
	if relDirPosix == "" {
		var imgPath, srcPath string
		if err := db.QueryRowContext(ctx, `SELECT spine_image_path, spine_source_path FROM book_mini_covers WHERE book_id = ? LIMIT 1`, bookID).Scan(&imgPath, &srcPath); err == nil {
			if imgPath != "" {
				relDirPosix = dirnamePosix(imgPath)
			} else if srcPath != "" {
				relDirPosix = dirnamePosix(srcPath)
			}
		}
	}

	// 4. Canonical folder for reference-only books with no files yet.
	if relDirPosix == "" {
		type authorLink struct {
			name     string
			position sql.NullInt64
		}
		aRows, err := db.QueryContext(ctx, `
			SELECT a.name, ba.position
			FROM book_authors ba
			INNER JOIN authors a ON a.id = ba.author_id
			WHERE ba.book_id = ?
		`, bookID)
		if err != nil {
			return "", "", err
		}
		var links []authorLink
		for aRows.Next() {
			var l authorLink
			if scanErr := aRows.Scan(&l.name, &l.position); scanErr != nil {
				_ = aRows.Close()
				return "", "", scanErr
			}
			links = append(links, l)
		}
		if err := aRows.Close(); err != nil {
			return "", "", err
		}
		sort.Slice(links, func(i, j int) bool {
			ap := int64(10000)
			if links[i].position.Valid {
				ap = links[i].position.Int64
			}
			bp := int64(10000)
			if links[j].position.Valid {
				bp = links[j].position.Int64
			}
			if ap != bp {
				return ap < bp
			}
			return links[i].name < links[j].name
		})
		authors := make([]string, 0, len(links))
		for _, l := range links {
			if l.name != "" {
				authors = append(authors, l.name)
			}
		}
		relDirPosix = GetCanonicalBookPaths(authors, title, bookID).BookDir
	}

	absDir, err = ResolveUnderLibrary(absRoot, relDirPosix)
	if err != nil {
		return "", "", err
	}
	return NormalizePosix(relDirPosix), absDir, nil
}

// WriteBookSpineFiles writes spine files atomically inside targetDirAbs using
// Delb's journaled asset transaction (recovering via RecoverBookCovers on crash).
// Callers must hold the book storage lock before calling this function.
func WriteBookSpineFiles(
	ctx context.Context,
	db *sql.DB,
	libraryRoot string,
	bookID string,
	targetDirAbs string,
	files []CoverUpdateFile,
	staleAbsPaths []string,
	commitDB func(operationID string) error,
) error {
	absRoot, err := filepath.Abs(libraryRoot)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(targetDirAbs, 0o755); err != nil {
		return err
	}
	dec := DBCoverDecision(db, bookID)
	if _, err := CommitCoverUpdate(ctx, CommitCoverUpdateOptions{
		OperationParent: targetDirAbs,
		AllowedRoot:     absRoot,
		BookID:          bookID,
		Files:           files,
		CommitDatabase:  commitDB,
		Decision:        &dec,
	}); err != nil {
		return err
	}

	// Best-effort cleanup of replaced source files with a different extension.
	written := make(map[string]struct{}, len(files))
	for _, f := range files {
		written[filepath.Clean(f.TargetPath)] = struct{}{}
	}
	for _, stale := range staleAbsPaths {
		if stale == "" {
			continue
		}
		cleaned := filepath.Clean(stale)
		if _, ok := written[cleaned]; ok {
			continue
		}
		if !IsStrictlyInside(absRoot, cleaned) {
			continue
		}
		_ = os.Remove(cleaned)
	}
	return nil
}
