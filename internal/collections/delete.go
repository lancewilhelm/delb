package collections

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

var sidecarFileRe = regexp.MustCompile(`(?i)^(cover[.-]|thumb\.webp$)`)

type DeleteCollectionOptions struct {
	DB               *sql.DB
	LibraryRoot      string
	UserID           string
	CollectionID     string
	ConfirmationName string
}

type DeleteCollectionResult struct {
	DeletedBooks int `json:"deletedBooks"`
}

type deletePlan struct {
	Entries     []deletePlanEntry
	Files       []deletePlanFile
	Paths       []string
	SidecarDirs []string
}

type deletePlanEntry struct {
	ID    string
	Cover string
}

type deletePlanFile struct {
	ID   string
	Path string
}

// DeleteCollection mirrors server/utils/collections/delete.ts:
// acquires the collection-delete lock and sorted per-book storage locks,
// snapshots book files & sidecar thumbnails not referenced outside the
// collection, executes journaled deleteStoredFiles with transactional DB
// deletion, and removes files safely after commit.
func DeleteCollection(ctx context.Context, opts DeleteCollectionOptions) (DeleteCollectionResult, error) {
	root, err := filepath.Abs(opts.LibraryRoot)
	if err != nil {
		return DeleteCollectionResult{}, err
	}
	lockID := "collection-delete:" + opts.CollectionID

	authorize := func(q queryable) error {
		if err := requireCollectionModel(ctx, q); err != nil {
			return err
		}
		c, err := assertCollectionManager(ctx, q, opts.UserID, opts.CollectionID, true)
		if err != nil {
			return err
		}
		if c.IsDefault {
			return httpapi.NewError(http.StatusConflict, "Choose a replacement default before deleting this collection")
		}
		if opts.ConfirmationName != c.Name {
			return httpapi.NewError(http.StatusConflict, "The collection name changed. Review deletion and type its current name.")
		}
		return nil
	}

	buildPlan := func(q queryable) (deletePlan, error) {
		var p deletePlan

		rows, err := q.QueryContext(ctx, `
			SELECT id, cover_image_path FROM books WHERE collection_id = ? ORDER BY id
		`, opts.CollectionID)
		if err != nil {
			return p, err
		}
		for rows.Next() {
			var id string
			var cover sql.NullString
			if err := rows.Scan(&id, &cover); err != nil {
				_ = rows.Close()
				return p, err
			}
			p.Entries = append(p.Entries, deletePlanEntry{ID: id, Cover: cover.String})
		}
		if err := rows.Close(); err != nil {
			return p, err
		}
		if err := rows.Err(); err != nil {
			return p, err
		}

		frows, err := q.QueryContext(ctx, `
			SELECT bf.id, bf.relative_path
			FROM book_files bf
			INNER JOIN books b ON b.id = bf.book_id
			WHERE b.collection_id = ?
			ORDER BY bf.id
		`, opts.CollectionID)
		if err != nil {
			return p, err
		}
		for frows.Next() {
			var f deletePlanFile
			if err := frows.Scan(&f.ID, &f.Path); err != nil {
				_ = frows.Close()
				return p, err
			}
			p.Files = append(p.Files, f)
		}
		if err := frows.Close(); err != nil {
			return p, err
		}
		if err := frows.Err(); err != nil {
			return p, err
		}

		outside := make(map[string]struct{})
		otherF, err := q.QueryContext(ctx, `
			SELECT bf.relative_path
			FROM book_files bf
			INNER JOIN books b ON b.id = bf.book_id
			WHERE b.collection_id != ?
		`, opts.CollectionID)
		if err != nil {
			return p, err
		}
		for otherF.Next() {
			var rel sql.NullString
			if err := otherF.Scan(&rel); err != nil {
				_ = otherF.Close()
				return p, err
			}
			if rel.Valid && rel.String != "" {
				outside[rel.String] = struct{}{}
			}
		}
		if err := otherF.Close(); err != nil {
			return p, err
		}
		if err := otherF.Err(); err != nil {
			return p, err
		}

		otherC, err := q.QueryContext(ctx, `
			SELECT cover_image_path FROM books WHERE collection_id != ? AND cover_image_path IS NOT NULL
		`, opts.CollectionID)
		if err != nil {
			return p, err
		}
		for otherC.Next() {
			var cov sql.NullString
			if err := otherC.Scan(&cov); err != nil {
				_ = otherC.Close()
				return p, err
			}
			if cov.Valid && cov.String != "" {
				outside[cov.String] = struct{}{}
			}
		}
		if err := otherC.Close(); err != nil {
			return p, err
		}
		if err := otherC.Err(); err != nil {
			return p, err
		}

		outsideDirs := make(map[string]struct{}, len(outside))
		for file := range outside {
			outsideDirs[path.Dir(file)] = struct{}{}
		}

		pathSet := make(map[string]struct{})
		for _, f := range p.Files {
			if _, ok := outside[f.Path]; !ok && f.Path != "" {
				pathSet[f.Path] = struct{}{}
			}
		}
		for _, e := range p.Entries {
			if e.Cover != "" {
				if _, ok := outside[e.Cover]; !ok {
					pathSet[e.Cover] = struct{}{}
				}
			}
		}
		p.Paths = make([]string, 0, len(pathSet))
		for fp := range pathSet {
			p.Paths = append(p.Paths, fp)
		}
		sort.Strings(p.Paths)

		dirSet := make(map[string]struct{})
		for _, fp := range p.Paths {
			d := path.Dir(fp)
			if d == "library" || d == "." {
				continue
			}
			if _, ok := outsideDirs[d]; ok {
				continue
			}
			dirSet[d] = struct{}{}
		}
		p.SidecarDirs = make([]string, 0, len(dirSet))
		for d := range dirSet {
			p.SidecarDirs = append(p.SidecarDirs, d)
		}
		sort.Strings(p.SidecarDirs)
		return p, nil
	}

	var result DeleteCollectionResult
	err = WithBookStorageLock(ctx, root, lockID, func() error {
		if err := authorize(opts.DB); err != nil {
			return err
		}

		rows, err := opts.DB.QueryContext(ctx, `SELECT id FROM books WHERE collection_id = ? ORDER BY id`, opts.CollectionID)
		if err != nil {
			return err
		}
		var ids []string
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				_ = rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if err := rows.Err(); err != nil {
			return err
		}

		var withLocks func(idx int) error
		withLocks = func(idx int) error {
			if idx < len(ids) {
				return WithBookStorageLock(ctx, root, ids[idx], func() error {
					return withLocks(idx + 1)
				})
			}

			if err := authorize(opts.DB); err != nil {
				return err
			}
			before, err := buildPlan(opts.DB)
			if err != nil {
				return err
			}
			beforeIDs := make([]string, len(before.Entries))
			for i, e := range before.Entries {
				beforeIDs[i] = e.ID
			}
			if !stringSlicesEqual(beforeIDs, ids) {
				return httpapi.NewError(http.StatusConflict, "The collection contents changed. Review deletion again.")
			}

			if err := os.MkdirAll(root, 0o755); err != nil {
				return err
			}
			realRoot, err := filepath.EvalSymlinks(root)
			if err != nil {
				return err
			}

			resolveStored := func(stored string) (string, error) {
				normalized := strings.ReplaceAll(stored, "\\", "/")
				trimmed := strings.TrimPrefix(normalized, "library/")
				file := filepath.Clean(filepath.Join(root, filepath.FromSlash(trimmed)))
				if !isStrictlyInside(root, file) {
					return "", httpapi.NewError(http.StatusConflict, "A book file is outside the managed library")
				}
				return file, nil
			}

			candidateSet := make(map[string]struct{})
			for _, stored := range before.Paths {
				resolved, err := resolveStored(stored)
				if err != nil {
					return err
				}
				candidateSet[resolved] = struct{}{}
			}
			for _, dirStored := range before.SidecarDirs {
				dirPath, err := resolveStored(dirStored)
				if err != nil {
					return err
				}
				entries, err := os.ReadDir(dirPath)
				if err != nil {
					if errors.Is(err, os.ErrNotExist) {
						continue
					}
					return err
				}
				for _, entry := range entries {
					if !entry.IsDir() && entry.Type().IsRegular() && sidecarFileRe.MatchString(entry.Name()) {
						candidateSet[filepath.Join(dirPath, entry.Name())] = struct{}{}
					}
				}
			}

			candidateList := make([]string, 0, len(candidateSet))
			for f := range candidateSet {
				candidateList = append(candidateList, f)
			}
			sort.Strings(candidateList)

			var sources []string
			for _, file := range candidateList {
				realFile, err := filepath.EvalSymlinks(file)
				if err != nil {
					if errors.Is(err, os.ErrNotExist) {
						continue
					}
					return err
				}
				if !isStrictlyInside(realRoot, realFile) {
					return httpapi.NewError(http.StatusConflict, "A book file is outside the managed library")
				}
				info, err := os.Stat(file)
				if err != nil {
					if errors.Is(err, os.ErrNotExist) {
						continue
					}
					return err
				}
				if !info.Mode().IsRegular() {
					return httpapi.NewError(http.StatusConflict, "A book file is not a regular file")
				}
				sources = append(sources, file)
			}

			decision := deleteDecision{
				IsCommitted: func(ctx context.Context, opID string) (bool, error) {
					var existing string
					err := opts.DB.QueryRowContext(ctx, `SELECT id FROM storage_operations WHERE id = ? LIMIT 1`, opID).Scan(&existing)
					if errors.Is(err, sql.ErrNoRows) {
						return false, nil
					}
					if err != nil {
						return false, err
					}
					return true, nil
				},
				Remove: func(ctx context.Context, opID string) error {
					_, err := opts.DB.ExecContext(ctx, `DELETE FROM storage_operations WHERE id = ?`, opID)
					return err
				},
			}

			if err := deleteStoredFiles(ctx, root, lockID, sources, decision, func(operationID string) error {
				tx, err := opts.DB.BeginTx(ctx, nil)
				if err != nil {
					return err
				}
				defer func() { _ = tx.Rollback() }()

				if err := lockCollectionChanges(ctx, tx); err != nil {
					return err
				}
				if err := authorize(tx); err != nil {
					return err
				}
				after, err := buildPlan(tx)
				if err != nil {
					return err
				}
				if !reflect.DeepEqual(after, before) {
					return httpapi.NewError(http.StatusConflict, "The collection contents changed. Review deletion again.")
				}
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO storage_operations (id, book_id, kind, created_at)
					VALUES (?, ?, 'delete', ?)
				`, operationID, lockID, time.Now().UTC().Unix()); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM books WHERE collection_id = ?`, opts.CollectionID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM bookshelf_layouts WHERE scope_kind = 'collection' AND scope_id = ?`, opts.CollectionID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM shelf_picture_assets WHERE scope_kind = 'collection' AND scope_id = ?`, opts.CollectionID); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `DELETE FROM collections WHERE id = ?`, opts.CollectionID); err != nil {
					return err
				}
				return tx.Commit()
			}); err != nil {
				return err
			}

			result = DeleteCollectionResult{DeletedBooks: len(ids)}
			return nil
		}

		return withLocks(0)
	})
	return result, err
}

func stringSlicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
