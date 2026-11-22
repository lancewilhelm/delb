package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
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
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("resolve lock root: %w", err)
	}
	dir := filepath.Join(absRoot, ".delb-locks")
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

// FileSHA256 returns the lowercase hex SHA-256 digest of the file at path.
func FileSHA256(path string) (string, error) {
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
	srcHash, err := FileSHA256(src)
	if err != nil {
		return false, err
	}
	dstHash, err := FileSHA256(dst)
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

// WriteFileSyncExclusive creates dst exclusively, writes data, fsyncs, and closes.
func WriteFileSyncExclusive(dst string, data []byte) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, wErr := f.Write(data)
	sErr := f.Sync()
	cErr := f.Close()
	if wErr != nil {
		return wErr
	}
	if sErr != nil {
		return sErr
	}
	return cErr
}

// WriteFileSync creates or truncates dst, writes data, fsyncs, and closes.
func WriteFileSync(dst string, data []byte) error {
	f, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, wErr := f.Write(data)
	sErr := f.Sync()
	cErr := f.Close()
	if wErr != nil {
		return wErr
	}
	if sErr != nil {
		return sErr
	}
	return cErr
}

// IsStrictlyInside reports whether candidate resolves strictly inside root (not equal to root and not escaping).
func IsStrictlyInside(root, candidate string) bool {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absCand, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absRoot, absCand)
	if err != nil {
		return false
	}
	if rel == "" || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	return true
}

// IsInsideOrEqual reports whether candidate resolves inside or equal to root.
func IsInsideOrEqual(root, candidate string) bool {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	absCand, err := filepath.Abs(candidate)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(absRoot, absCand)
	if err != nil {
		return false
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return false
	}
	return true
}

// ResolveUnderLibrary resolves a stored POSIX path (e.g. "library/Author/Book/file.epub"
// or relative path under library) safely under libraryRoot, rejecting path traversal.
func ResolveUnderLibrary(libraryRoot, storedPath string) (string, error) {
	absRoot, err := filepath.Abs(libraryRoot)
	if err != nil {
		return "", err
	}
	normalized := NormalizePosix(storedPath)
	rel := strings.TrimPrefix(normalized, "library/")
	abs := filepath.Clean(filepath.Join(absRoot, filepath.FromSlash(rel)))
	if !IsInsideOrEqual(absRoot, abs) {
		return "", httpapi.NewError(http.StatusBadRequest, "Invalid path")
	}
	return abs, nil
}

func pathExists(p string) (bool, error) {
	_, err := os.Stat(p)
	if err == nil {
		return true, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, err
}

// OperationDecision checks and cleans up rows in storage_operations.
type OperationDecision struct {
	IsCommitted func(ctx context.Context, id string) (bool, error)
	Remove      func(ctx context.Context, id string) error
}
