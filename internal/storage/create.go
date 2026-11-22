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

	"github.com/google/uuid"
)

type createJournal struct {
	Version   int    `json:"version"`
	ID        string `json:"id"`
	BookID    string `json:"bookId"`
	Directory string `json:"directory"`
	File      string `json:"file"`
}

// DBCreateDecision returns an OperationDecision backed by storage_operations for create ops.
func DBCreateDecision(db *sql.DB) OperationDecision {
	return OperationDecision{
		IsCommitted: func(ctx context.Context, id string) (bool, error) {
			var existing string
			err := db.QueryRowContext(ctx, `
				SELECT id FROM storage_operations WHERE id = ? AND kind = 'create' LIMIT 1
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
				DELETE FROM storage_operations WHERE id = ? AND kind = 'create'
			`, id)
			return err
		},
	}
}

func validateCreateJournal(root string, j createJournal) error {
	if j.Version != 1 || j.ID == "" || j.BookID == "" || j.Directory == "" || j.File == "" {
		return errors.New("Invalid creation journal")
	}
	for _, candidate := range []string{j.Directory, j.File} {
		if !IsStrictlyInside(root, candidate) {
			return errors.New("Creation path escapes library")
		}
	}
	if filepath.Dir(j.File) != j.Directory {
		return errors.New("Invalid creation file path")
	}
	return nil
}

func finishCreateJournal(ctx context.Context, root, journalDir string, journal createJournal, decision OperationDecision) error {
	if err := validateCreateJournal(root, journal); err != nil {
		return err
	}
	committed, err := decision.IsCommitted(ctx, journal.ID)
	if err != nil {
		return err
	}
	if committed {
		ok, err := pathExists(journal.File)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("Committed upload is missing: %s", journal.File)
		}
		if err := os.RemoveAll(journalDir); err != nil {
			return err
		}
		return decision.Remove(ctx, journal.ID)
	}

	failedDir := filepath.Join(root, ".delb-failed-create-"+journal.ID)
	if err := os.Mkdir(failedDir, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	entries, err := os.ReadDir(failedDir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.Name() != "files" {
			return fmt.Errorf("Unexpected creation recovery directory: %s", failedDir)
		}
	}
	recovered := filepath.Join(failedDir, "files")
	sourceExists, err := pathExists(journal.Directory)
	if err != nil {
		return err
	}
	recoveredExists, err := pathExists(recovered)
	if err != nil {
		return err
	}
	if sourceExists && recoveredExists {
		return fmt.Errorf("Conflicting creation recovery: %s", failedDir)
	}
	if sourceExists {
		if err := os.Rename(journal.Directory, recovered); err != nil {
			return err
		}
	} else if !recoveredExists {
		return fmt.Errorf("Creation input is missing: %s", journal.Directory)
	}
	return os.Rename(journalDir, filepath.Join(failedDir, "journal"))
}

// StoredCreateHandle tracks an active journaled book creation on disk.
type StoredCreateHandle struct {
	ID         string
	root       string
	journalDir string
	journal    createJournal
	decision   OperationDecision
}

// Finish completes or rolls back the journaled creation based on DB commit state.
func (h *StoredCreateHandle) Finish(ctx context.Context) error {
	ok, err := pathExists(h.journalDir)
	if err != nil || !ok {
		return err
	}
	return finishCreateJournal(ctx, h.root, h.journalDir, h.journal, h.decision)
}

// BeginStoredCreate mirrors server/utils/books/storage/create-operation.ts beginStoredCreate.
func BeginStoredCreate(root, bookID, directory, file string, decision OperationDecision) (*StoredCreateHandle, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	journal := createJournal{
		Version:   1,
		ID:        uuid.NewString(),
		BookID:    bookID,
		Directory: directory,
		File:      file,
	}
	if err := validateCreateJournal(absRoot, journal); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(journal.Directory), 0o755); err != nil {
		return nil, err
	}
	if err := os.Mkdir(journal.Directory, 0o755); err != nil {
		return nil, err
	}
	dir := filepath.Join(absRoot, ".delb-create-"+journal.ID)
	preparing := filepath.Join(absRoot, ".delb-preparing-create-"+journal.ID)
	if err := os.Mkdir(preparing, 0o755); err != nil {
		return nil, err
	}
	raw, err := json.Marshal(journal)
	if err != nil {
		return nil, err
	}
	if err := WriteFileSyncExclusive(filepath.Join(preparing, "journal.json"), raw); err != nil {
		return nil, err
	}
	if err := os.Rename(preparing, dir); err != nil {
		return nil, err
	}
	return &StoredCreateHandle{
		ID:         journal.ID,
		root:       absRoot,
		journalDir: dir,
		journal:    journal,
		decision:   decision,
	}, nil
}

// RecoverStoredCreates mirrors server/utils/books/storage/create-operation.ts recoverStoredCreates.
func RecoverStoredCreates(
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
		if !strings.HasPrefix(name, ".delb-create-") {
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
		var journal createJournal
		if err := json.Unmarshal(raw, &journal); err != nil {
			return err
		}
		if err := validateCreateJournal(absRoot, journal); err != nil {
			return err
		}
		if name != ".delb-create-"+journal.ID {
			return errors.New("Invalid creation journal identity")
		}
		if err := withLock(journal.BookID, func() error {
			ok, err := pathExists(dir)
			if err != nil || !ok {
				return err
			}
			return finishCreateJournal(ctx, absRoot, dir, journal, decision)
		}); err != nil {
			return err
		}
	}
	return nil
}
