package collections

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

// ErrBookStorageLockBusy is returned when a storage lock cannot be acquired
// within the 30s deadline.
var ErrBookStorageLockBusy = errors.New("Book storage lock is busy")

// WithBookStorageLock mirrors server/utils/books/storage/book-lock.ts using the
// exact same SQLite lock file path (<root>/.delb-locks/<sha256(key)>.db) and
// BEGIN IMMEDIATE / ROLLBACK protocol so Go and Nitro coordinate cleanly across
// processes during the strangler migration.
func WithBookStorageLock(ctx context.Context, root, lockKey string, work func() error) error {
	dir := filepath.Join(root, ".delb-locks")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create lock directory: %w", err)
	}
	sum := sha256.Sum256([]byte(lockKey))
	lockPath := filepath.Join(dir, hex.EncodeToString(sum[:])+".db")

	q := url.Values{}
	q.Add("_pragma", "busy_timeout(0)")
	dsn := "file:" + filepath.ToSlash(lockPath) + "?" + q.Encode()

	lockDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open lock db: %w", err)
	}
	defer func() { _ = lockDB.Close() }()
	lockDB.SetMaxOpenConns(1)
	lockDB.SetMaxIdleConns(1)

	conn, err := lockDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire lock connection: %w", err)
	}
	defer func() { _ = conn.Close() }()

	if _, err := conn.ExecContext(ctx, "PRAGMA busy_timeout=0"); err != nil {
		return fmt.Errorf("configure lock busy_timeout: %w", err)
	}

	deadline := time.Now().Add(30 * time.Second)
	for {
		_, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE")
		if err == nil {
			break
		}
		if !isSQLiteBusyError(err) {
			return fmt.Errorf("begin lock transaction: %w", err)
		}
		if time.Now().After(deadline) {
			return ErrBookStorageLockBusy
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}

	workErr := work()
	if _, rbErr := conn.ExecContext(context.Background(), "ROLLBACK"); rbErr != nil && workErr == nil {
		return fmt.Errorf("release lock transaction: %w", rbErr)
	}
	return workErr
}

func isSQLiteBusyError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "sqlite_busy") ||
		strings.Contains(msg, "database is locked") ||
		strings.Contains(msg, "database table is locked")
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// SameFileContents verifies that two files have identical byte length and SHA-256 digest.
func SameFileContents(src, dst string) (bool, error) {
	srcInfo, err := os.Stat(src)
	if err != nil {
		return false, err
	}
	dstInfo, err := os.Stat(dst)
	if err != nil {
		return false, err
	}
	if srcInfo.Size() != dstInfo.Size() {
		return false, nil
	}
	srcHash, err := fileSHA256(src)
	if err != nil {
		return false, err
	}
	dstHash, err := fileSHA256(dst)
	if err != nil {
		return false, err
	}
	return srcHash == dstHash, nil
}

// CopyVerifiedExclusive copies src to a brand-new dst file (O_EXCL), fsyncs dst,
// and verifies byte-for-byte SHA-256 identity.
func CopyVerifiedExclusive(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = in.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	syncErr := out.Sync()
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	same, err := SameFileContents(src, dst)
	if err != nil {
		return err
	}
	if !same {
		return fmt.Errorf("Copy verification failed for %s", src)
	}
	return nil
}

type deleteJournal struct {
	Version int      `json:"version"`
	ID      string   `json:"id"`
	BookID  string   `json:"bookId"`
	Sources []string `json:"sources"`
}

type deleteDecision struct {
	IsCommitted func(ctx context.Context, id string) (bool, error)
	Remove      func(ctx context.Context, id string) error
}

func validateDeleteJournal(root string, j deleteJournal) error {
	if j.Version != 1 || j.ID == "" || j.BookID == "" {
		return errors.New("Invalid delete journal")
	}
	for _, src := range j.Sources {
		if !isStrictlyInside(root, src) {
			return errors.New("Delete source escapes library")
		}
	}
	return nil
}

func isStrictlyInside(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	if rel == "" || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	return true
}

func finishDeleteJournal(ctx context.Context, root, dir string, journal deleteJournal, decision deleteDecision) error {
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
			srcHash, err := fileSHA256(source)
			if err != nil {
				return err
			}
			bkpHash, err := fileSHA256(backup)
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

func deleteStoredFiles(
	ctx context.Context,
	root string,
	bookID string,
	sources []string,
	decision deleteDecision,
	commit func(operationID string) error,
) error {
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
	if err := validateDeleteJournal(root, journal); err != nil {
		return err
	}

	dir := filepath.Join(root, ".delb-delete-"+journal.ID)
	preparing := filepath.Join(root, ".delb-preparing-delete-"+journal.ID)
	if err := os.Mkdir(preparing, 0o755); err != nil {
		return err
	}

	journalBytes, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	journalPath := filepath.Join(preparing, "journal.json")
	jf, err := os.OpenFile(journalPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, wErr := jf.Write(journalBytes)
	sErr := jf.Sync()
	cErr := jf.Close()
	if wErr != nil {
		return wErr
	}
	if sErr != nil {
		return sErr
	}
	if cErr != nil {
		return cErr
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

	return finishDeleteJournal(ctx, root, dir, journal, decision)
}

// RecoverStoredDeletes mirrors server/utils/books/storage/delete-operation.ts
// recoverStoredDeletes for recovery and unit tests.
func RecoverStoredDeletes(
	ctx context.Context,
	root string,
	decision deleteDecision,
	withLock func(bookID string, work func() error) error,
) error {
	entries, err := os.ReadDir(root)
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
		dir := filepath.Join(root, name)
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
		if err := validateDeleteJournal(root, journal); err != nil {
			return err
		}
		if name != ".delb-delete-"+journal.ID {
			return errors.New("Invalid delete journal identity")
		}
		if err := withLock(journal.BookID, func() error {
			if _, err := os.Stat(dir); err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return nil
				}
				return err
			}
			return finishDeleteJournal(ctx, root, dir, journal, decision)
		}); err != nil {
			return err
		}
	}
	return nil
}
