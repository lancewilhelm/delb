package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type deleteJournal struct {
	Version int      `json:"version"`
	ID      string   `json:"id"`
	BookID  string   `json:"bookId"`
	Sources []string `json:"sources"`
}

// DBDeleteDecision returns an OperationDecision backed by storage_operations for delete/replace ops.
func DBDeleteDecision(db *sql.DB) OperationDecision {
	return OperationDecision{
		IsCommitted: func(ctx context.Context, id string) (bool, error) {
			var existing string
			err := db.QueryRowContext(ctx, `
				SELECT id FROM storage_operations WHERE id = ? AND kind IN ('delete', 'replace') LIMIT 1
			`, id).Scan(&existing)
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
				DELETE FROM storage_operations WHERE id = ? AND kind IN ('delete', 'replace')
			`, id)
			return err
		},
	}
}

func validateDeleteJournal(root string, j deleteJournal) error {
	if j.Version != 1 || j.ID == "" || j.BookID == "" {
		return errors.New("Invalid delete journal")
	}
	for _, src := range j.Sources {
		if !IsStrictlyInside(root, src) {
			return errors.New("Delete source escapes library")
		}
	}
	return nil
}

func finishDeleteJournal(ctx context.Context, root, dir string, journal deleteJournal, decision OperationDecision) error {
	if err := validateDeleteJournal(root, journal); err != nil {
		return err
	}
	committed, err := decision.IsCommitted(ctx, journal.ID)
	if err != nil {
		return err
	}
	if committed {
		for idx, source := range journal.Sources {
			backup := filepath.Join(dir, strconv.Itoa(idx))
			srcInfo, err := os.Stat(source)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					continue
				}
				return err
			}
			backupInfo, err := os.Stat(backup)
			if err != nil {
				return err
			}
			if srcInfo.Size() != backupInfo.Size() {
				return fmt.Errorf("Delete source changed: %s", source)
			}
			srcHash, err := FileSHA256(source)
			if err != nil {
				return err
			}
			bkpHash, err := FileSHA256(backup)
			if err != nil {
				return err
			}
			if srcHash != bkpHash {
				return fmt.Errorf("Delete source changed: %s", source)
			}
			if err := os.Remove(source); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return decision.Remove(ctx, journal.ID)
}

// DeleteStoredFiles mirrors server/utils/books/storage/delete-operation.ts deleteStoredFiles.
func DeleteStoredFiles(
	ctx context.Context,
	root string,
	bookID string,
	sources []string,
	decision OperationDecision,
	commit func(operationID string) error,
) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	seen := make(map[string]struct{}, len(sources))
	uniqueSources := make([]string, 0, len(sources))
	for _, s := range sources {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		uniqueSources = append(uniqueSources, s)
	}

	journal := deleteJournal{
		Version: 1,
		ID:      uuid.NewString(),
		BookID:  bookID,
		Sources: uniqueSources,
	}
	if err := validateDeleteJournal(absRoot, journal); err != nil {
		return err
	}

	dir := filepath.Join(absRoot, ".delb-delete-"+journal.ID)
	preparing := filepath.Join(absRoot, ".delb-preparing-delete-"+journal.ID)
	if err := os.Mkdir(preparing, 0o755); err != nil {
		return err
	}

	journalBytes, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	if err := WriteFileSyncExclusive(filepath.Join(preparing, "journal.json"), journalBytes); err != nil {
		return err
	}
	if err := os.Rename(preparing, dir); err != nil {
		return err
	}

	for idx, src := range journal.Sources {
		if err := CopyVerifiedExclusive(src, filepath.Join(dir, strconv.Itoa(idx))); err != nil {
			return err
		}
	}

	if err := commit(journal.ID); err != nil {
		return err
	}

	return finishDeleteJournal(ctx, absRoot, dir, journal, decision)
}

// RecoverStoredDeletes mirrors server/utils/books/storage/delete-operation.ts recoverStoredDeletes.
func RecoverStoredDeletes(
	ctx context.Context,
	root string,
	decision OperationDecision,
	withLock func(bookID string, work func() error) error,
) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	entries, err := os.ReadDir(absRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, ".delb-delete-") {
			continue
		}
		dir := filepath.Join(absRoot, name)
		raw, err := os.ReadFile(filepath.Join(dir, "journal.json"))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				if _, statErr := os.Stat(dir); errors.Is(statErr, os.ErrNotExist) {
					continue
				}
			}
			return err
		}
		var journal deleteJournal
		if err := json.Unmarshal(raw, &journal); err != nil {
			return err
		}
		if err := validateDeleteJournal(absRoot, journal); err != nil {
			return err
		}
		if name != ".delb-delete-"+journal.ID {
			return errors.New("Invalid delete journal identity")
		}
		if err := withLock(journal.BookID, func() error {
			ok, err := pathExists(dir)
			if err != nil || !ok {
				return err
			}
			return finishDeleteJournal(ctx, absRoot, dir, journal, decision)
		}); err != nil {
			return err
		}
	}
	return nil
}
