package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/google/uuid"
)

type coverJournalEntry struct {
	TargetPath  string `json:"targetPath"`
	StagedName  string `json:"stagedName"`
	BackupName  string `json:"backupName"`
	HadOriginal bool   `json:"hadOriginal"`
}

type coverUpdateJournal struct {
	Version                int                 `json:"version"`
	OperationID            string              `json:"operationId,omitempty"`
	BookID                 string              `json:"bookId,omitempty"`
	Phase                  string              `json:"phase"`
	PreviousCoverImagePath *string             `json:"previousCoverImagePath"`
	ExpectedCoverImagePath string              `json:"expectedCoverImagePath"`
	Entries                []coverJournalEntry `json:"entries"`
}

// CoverUpdateFile describes a file to write atomically during cover update.
type CoverUpdateFile struct {
	TargetPath string
	Data       []byte
}

// CoverUpdateResult records any paths where rename fell back to verified copy.
type CoverUpdateResult struct {
	BackupFallbackPaths []string
}

// CoverUpdateStorageError mirrors server/utils/books/cover-update-transaction.ts CoverUpdateStorageError.
type CoverUpdateStorageError struct {
	Code       string
	TargetPath string
	Cause      error
}

func (e *CoverUpdateStorageError) Error() string {
	return fmt.Sprintf("Could not safely back up the existing file: %s", e.TargetPath)
}

func (e *CoverUpdateStorageError) Unwrap() error {
	return e.Cause
}

// DBCoverDecision returns an OperationDecision backed by storage_operations for cover ops.
func DBCoverDecision(db *sql.DB, bookID string) OperationDecision {
	return OperationDecision{
		IsCommitted: func(ctx context.Context, id string) (bool, error) {
			var existing string
			err := db.QueryRowContext(ctx, `
				SELECT id FROM storage_operations WHERE id = ? AND book_id = ? AND kind = 'cover' LIMIT 1
			`, id, bookID).Scan(&existing)
			if errors.Is(err, sql.ErrNoRows) {
				return false, nil
			}
			if err != nil {
				return false, err
			}
			return true, nil
		},
		Remove: func(ctx context.Context, id string) error {
			_, err := db.ExecContext(ctx, `
				DELETE FROM storage_operations WHERE id = ? AND book_id = ? AND kind = 'cover'
			`, id, bookID)
			return err
		},
	}
}

func validateCoverJournal(j coverUpdateJournal, allowedRoot, operationDir string) error {
	if (j.Version != 1 && j.Version != 2) ||
		(j.Version == 2 && (j.OperationID == "" || j.BookID == "")) {
		return errors.New("Invalid cover update journal")
	}
	for _, entry := range j.Entries {
		if !IsInsideOrEqual(allowedRoot, entry.TargetPath) {
			return fmt.Errorf("Path escapes the allowed root: %s", entry.TargetPath)
		}
		if !IsInsideOrEqual(operationDir, filepath.Join(operationDir, entry.StagedName)) {
			return fmt.Errorf("Path escapes the allowed root: %s", entry.StagedName)
		}
		if !IsInsideOrEqual(operationDir, filepath.Join(operationDir, entry.BackupName)) {
			return fmt.Errorf("Path escapes the allowed root: %s", entry.BackupName)
		}
	}
	return nil
}

func writeCoverJournal(operationDir string, journal coverUpdateJournal) error {
	raw, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	tmp := filepath.Join(operationDir, "journal.tmp")
	if err := WriteFileSync(tmp, raw); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(operationDir, "journal.json"))
}

func isUnionFSRenameError(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if errno == syscall.EXDEV {
			return true
		}
		// Linux EUCLEAN = 117
		if int(errno) == 117 {
			return true
		}
	}
	return false
}

func moveExistingToBackup(source, backup string, renameFn func(string, string) error) (bool, error) {
	err := renameFn(source, backup)
	if err == nil {
		return false, nil
	}
	if !isUnionFSRenameError(err) {
		return false, err
	}
	if err := CopyVerifiedExclusive(source, backup); err != nil {
		return false, &CoverUpdateStorageError{
			Code:       "COVER_STORAGE_ERROR",
			TargetPath: source,
			Cause:      err,
		}
	}
	if err := os.Remove(source); err != nil {
		return false, &CoverUpdateStorageError{
			Code:       "COVER_STORAGE_ERROR",
			TargetPath: source,
			Cause:      err,
		}
	}
	return true, nil
}

func rollForwardCover(operationDir string, journal coverUpdateJournal, renameFn func(string, string) error) ([]string, error) {
	var fallbacks []string
	for _, entry := range journal.Entries {
		staged := filepath.Join(operationDir, entry.StagedName)
		backup := filepath.Join(operationDir, entry.BackupName)
		stagedExists, err := pathExists(staged)
		if err != nil {
			return nil, err
		}
		if !stagedExists {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(entry.TargetPath), 0o755); err != nil {
			return nil, err
		}
		backupExists, err := pathExists(backup)
		if err != nil {
			return nil, err
		}
		targetExists, err := pathExists(entry.TargetPath)
		if err != nil {
			return nil, err
		}

		if entry.HadOriginal && !backupExists && targetExists {
			usedFallback, err := moveExistingToBackup(entry.TargetPath, backup, renameFn)
			if err != nil {
				return nil, err
			}
			if usedFallback {
				fallbacks = append(fallbacks, entry.TargetPath)
			}
		} else if entry.HadOriginal && backupExists && targetExists {
			same, err := SameFileContents(backup, entry.TargetPath)
			if err != nil {
				return nil, err
			}
			if !same {
				return nil, fmt.Errorf("Cover target unexpectedly exists: %s", entry.TargetPath)
			}
			if err := os.Remove(entry.TargetPath); err != nil {
				return nil, err
			}
		} else if targetExists {
			return nil, fmt.Errorf("Cover target unexpectedly exists: %s", entry.TargetPath)
		}

		if err := os.Rename(staged, entry.TargetPath); err != nil {
			return nil, err
		}
	}
	return fallbacks, nil
}

func rollbackCoverFiles(operationDir string, journal coverUpdateJournal) error {
	for i := len(journal.Entries) - 1; i >= 0; i-- {
		entry := journal.Entries[i]
		staged := filepath.Join(operationDir, entry.StagedName)
		backup := filepath.Join(operationDir, entry.BackupName)
		backupExists, err := pathExists(backup)
		if err != nil {
			return err
		}
		targetExists, err := pathExists(entry.TargetPath)
		if err != nil {
			return err
		}
		stagedExists, err := pathExists(staged)
		if err != nil {
			return err
		}
		if backupExists {
			if targetExists && !stagedExists {
				if err := os.Rename(entry.TargetPath, staged); err != nil {
					return err
				}
			} else if targetExists {
				_ = os.Remove(entry.TargetPath)
			}
			if err := os.Rename(backup, entry.TargetPath); err != nil {
				return err
			}
		} else if !entry.HadOriginal && targetExists {
			if !stagedExists {
				if err := os.Rename(entry.TargetPath, staged); err != nil {
					return err
				}
			} else {
				_ = os.Remove(entry.TargetPath)
			}
		}
	}
	return nil
}

// RecoverPendingCoverUpdates mirrors server/utils/books/cover-update-transaction.ts recoverPendingCoverUpdates.
func RecoverPendingCoverUpdates(
	ctx context.Context,
	operationParent string,
	allowedRoot string,
	currentCoverImagePath *string,
	bookID string,
	decision *OperationDecision,
) (CoverUpdateResult, error) {
	var res CoverUpdateResult
	entries, err := os.ReadDir(operationParent)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return res, nil
		}
		return res, err
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".cover-update-") {
			continue
		}
		opDir := filepath.Join(operationParent, e.Name())
		raw, err := os.ReadFile(filepath.Join(opDir, "journal.json"))
		if err != nil {
			return res, fmt.Errorf("Cannot recover cover journal %s: %w", opDir, err)
		}
		var journal coverUpdateJournal
		if err := json.Unmarshal(raw, &journal); err != nil {
			return res, fmt.Errorf("Cannot recover cover journal %s: %w", opDir, err)
		}
		if err := validateCoverJournal(journal, allowedRoot, opDir); err != nil {
			return res, fmt.Errorf("Cannot recover cover journal %s: %w", opDir, err)
		}
		if journal.Version == 2 && journal.BookID != bookID {
			continue
		}

		var committed bool
		if journal.Version == 2 {
			if decision == nil || journal.OperationID == "" {
				return res, fmt.Errorf("Missing cover decision for %s", opDir)
			}
			committed, err = decision.IsCommitted(ctx, journal.OperationID)
			if err != nil {
				return res, err
			}
		} else if journal.Phase == "database-committed" {
			committed = true
		} else if !sameStringPtr(journal.PreviousCoverImagePath, &journal.ExpectedCoverImagePath) &&
			sameStringPtr(currentCoverImagePath, journal.PreviousCoverImagePath) {
			committed = false
		} else {
			return res, fmt.Errorf("Ambiguous cover journal %s", opDir)
		}

		if committed {
			fallbacks, err := rollForwardCover(opDir, journal, os.Rename)
			if err != nil {
				return res, err
			}
			res.BackupFallbackPaths = append(res.BackupFallbackPaths, fallbacks...)
		} else {
			if err := rollbackCoverFiles(opDir, journal); err != nil {
				return res, err
			}
		}
		if err := os.RemoveAll(opDir); err != nil {
			return res, err
		}
		if journal.Version == 2 && journal.OperationID != "" && decision != nil {
			if err := decision.Remove(ctx, journal.OperationID); err != nil {
				return res, err
			}
		}
	}
	return res, nil
}

// CommitCoverUpdateOptions configures CommitCoverUpdate.
type CommitCoverUpdateOptions struct {
	OperationParent        string
	AllowedRoot            string
	PreviousCoverImagePath *string
	ExpectedCoverImagePath string
	BookID                 string
	Files                  []CoverUpdateFile
	CommitDatabase         func(operationID string) error
	Decision               *OperationDecision
	RollbackDatabase       func() error
	RenameExistingToBackup func(src, dst string) error
}

// CommitCoverUpdate mirrors server/utils/books/cover-update-transaction.ts commitCoverUpdate.
func CommitCoverUpdate(ctx context.Context, opts CommitCoverUpdateOptions) (CoverUpdateResult, error) {
	operationID := uuid.NewString()
	opDir := filepath.Join(opts.OperationParent, ".cover-update-"+operationID)
	prepDir := filepath.Join(opts.OperationParent, ".delb-preparing-cover-"+operationID)
	if err := os.Mkdir(prepDir, 0o755); err != nil {
		return CoverUpdateResult{}, err
	}

	renameFn := opts.RenameExistingToBackup
	if renameFn == nil {
		renameFn = os.Rename
	}

	entries := make([]coverJournalEntry, 0, len(opts.Files))
	published := false

	fail := func(cause error) (CoverUpdateResult, error) {
		if !published {
			_ = os.RemoveAll(prepDir)
			if opts.RollbackDatabase != nil {
				_ = opts.RollbackDatabase()
			}
			return CoverUpdateResult{}, cause
		}
		if opts.Decision != nil {
			if committed, err := opts.Decision.IsCommitted(ctx, operationID); err == nil && committed {
				return CoverUpdateResult{}, cause
			}
		}
		version := 1
		opIDField := ""
		bookIDField := ""
		if opts.Decision != nil {
			version = 2
			opIDField = operationID
			bookIDField = opts.BookID
		}
		journal := coverUpdateJournal{
			Version:                version,
			OperationID:            opIDField,
			BookID:                 bookIDField,
			Phase:                  "prepared",
			PreviousCoverImagePath: opts.PreviousCoverImagePath,
			ExpectedCoverImagePath: opts.ExpectedCoverImagePath,
			Entries:                entries,
		}
		filesRolledBack := rollbackCoverFiles(opDir, journal) == nil
		dbRolledBack := true
		if opts.RollbackDatabase != nil {
			dbRolledBack = opts.RollbackDatabase() == nil
		}
		if filesRolledBack && (dbRolledBack || sameStringPtr(opts.PreviousCoverImagePath, &opts.ExpectedCoverImagePath)) {
			_ = os.RemoveAll(opDir)
		}
		return CoverUpdateResult{}, cause
	}

	for index, file := range opts.Files {
		if !IsInsideOrEqual(opts.AllowedRoot, file.TargetPath) {
			return fail(fmt.Errorf("Path escapes the allowed root: %s", file.TargetPath))
		}
		stagedName := fmt.Sprintf("new-%d", index)
		backupName := fmt.Sprintf("old-%d", index)
		hadOriginal, err := pathExists(file.TargetPath)
		if err != nil {
			return fail(err)
		}
		if err := WriteFileSyncExclusive(filepath.Join(prepDir, stagedName), file.Data); err != nil {
			return fail(err)
		}
		entries = append(entries, coverJournalEntry{
			TargetPath:  file.TargetPath,
			StagedName:  stagedName,
			BackupName:  backupName,
			HadOriginal: hadOriginal,
		})
	}

	version := 1
	opIDField := ""
	bookIDField := ""
	if opts.Decision != nil {
		version = 2
		opIDField = operationID
		bookIDField = opts.BookID
	}
	journal := coverUpdateJournal{
		Version:                version,
		OperationID:            opIDField,
		BookID:                 bookIDField,
		Phase:                  "prepared",
		PreviousCoverImagePath: opts.PreviousCoverImagePath,
		ExpectedCoverImagePath: opts.ExpectedCoverImagePath,
		Entries:                entries,
	}
	if err := writeCoverJournal(prepDir, journal); err != nil {
		return fail(err)
	}
	if err := os.Rename(prepDir, opDir); err != nil {
		return fail(err)
	}
	published = true

	if err := opts.CommitDatabase(operationID); err != nil {
		return fail(err)
	}
	journal.Phase = "database-committed"
	if err := writeCoverJournal(opDir, journal); err != nil {
		return fail(err)
	}
	fallbacks, err := rollForwardCover(opDir, journal, renameFn)
	if err != nil {
		return fail(err)
	}
	if err := os.RemoveAll(opDir); err != nil {
		return fail(err)
	}
	if opts.Decision != nil {
		if err := opts.Decision.Remove(ctx, operationID); err != nil {
			return CoverUpdateResult{}, err
		}
	}
	return CoverUpdateResult{BackupFallbackPaths: fallbacks}, nil
}

// RecoverBookCovers mirrors server/utils/books/storage/cover-recovery.ts recoverBookCovers.
func RecoverBookCovers(ctx context.Context, db *sql.DB, libraryRoot string) error {
	absRoot, err := filepath.Abs(libraryRoot)
	if err != nil {
		return err
	}

	owners := make(map[string]map[string]struct{})
	addOwner := func(bookID, stored string) {
		if stored == "" {
			return
		}
		resolved, err := ResolveUnderLibrary(absRoot, stored)
		if err != nil {
			return
		}
		dir := filepath.Dir(resolved)
		if owners[dir] == nil {
			owners[dir] = make(map[string]struct{})
		}
		owners[dir][bookID] = struct{}{}
	}

	bRows, err := db.QueryContext(ctx, `SELECT id, cover_image_path FROM books WHERE cover_image_path IS NOT NULL`)
	if err != nil {
		return err
	}
	for bRows.Next() {
		var id, cover string
		if err := bRows.Scan(&id, &cover); err != nil {
			_ = bRows.Close()
			return err
		}
		addOwner(id, cover)
	}
	if err := bRows.Close(); err != nil {
		return err
	}

	fRows, err := db.QueryContext(ctx, `SELECT book_id, relative_path FROM book_files`)
	if err != nil {
		return err
	}
	for fRows.Next() {
		var id, rel string
		if err := fRows.Scan(&id, &rel); err != nil {
			_ = fRows.Close()
			return err
		}
		addOwner(id, rel)
	}
	if err := fRows.Close(); err != nil {
		return err
	}

	pending := make(map[string]map[string]struct{})
	var scan func(dir string) error
	scan = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			child := filepath.Join(dir, e.Name())
			if strings.HasPrefix(e.Name(), ".cover-update-") {
				raw, err := os.ReadFile(filepath.Join(child, "journal.json"))
				if err != nil {
					if errors.Is(err, os.ErrNotExist) {
						if _, statErr := os.Stat(child); errors.Is(statErr, os.ErrNotExist) {
							continue
						}
					}
					return err
				}
				var j struct {
					Version int    `json:"version"`
					BookID  string `json:"bookId"`
				}
				if err := json.Unmarshal(raw, &j); err != nil || j.Version == 0 {
					return fmt.Errorf("Invalid cover journal: %s", child)
				}
				var bookID string
				if j.Version == 2 && j.BookID != "" {
					bookID = j.BookID
				} else if j.Version == 1 && len(owners[dir]) == 1 {
					for only := range owners[dir] {
						bookID = only
					}
				} else {
					return fmt.Errorf("Ambiguous cover journal owner: %s", child)
				}
				if pending[dir] == nil {
					pending[dir] = make(map[string]struct{})
				}
				pending[dir][bookID] = struct{}{}
			} else if !strings.HasPrefix(e.Name(), ".delb-") {
				if err := scan(child); err != nil {
					return err
				}
			}
		}
		return nil
	}

	if err := scan(absRoot); err != nil {
		return err
	}

	for dir, ids := range pending {
		if len(ids) > 1 && len(owners[dir]) != 1 {
			return fmt.Errorf("Ambiguous shared cover journal directory: %s", dir)
		}
		for bookID := range ids {
			if err := WithBookStorageLock(ctx, absRoot, bookID, func() error {
				var currentCover sql.NullString
				err := db.QueryRowContext(ctx, `SELECT cover_image_path FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&currentCover)
				if err != nil && !errors.Is(err, sql.ErrNoRows) {
					return err
				}
				var currentPtr *string
				if currentCover.Valid {
					s := currentCover.String
					currentPtr = &s
				}
				dec := DBCoverDecision(db, bookID)
				_, err = RecoverPendingCoverUpdates(ctx, dir, absRoot, currentPtr, bookID, &dec)
				return err
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func sameStringPtr(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}
