package collections

import (
	"context"

	"github.com/lancewilhelm/delb/internal/storage"
)

// ErrBookStorageLockBusy is re-exported from internal/storage for backwards compatibility.
var ErrBookStorageLockBusy = storage.ErrBookStorageLockBusy

type deleteDecision = storage.OperationDecision

// WithBookStorageLock delegates to storage.WithBookStorageLock.
func WithBookStorageLock(ctx context.Context, root, lockKey string, work func() error) error {
	return storage.WithBookStorageLock(ctx, root, lockKey, work)
}

// SameFileContents delegates to storage.SameFileContents.
func SameFileContents(src, dst string) (bool, error) {
	return storage.SameFileContents(src, dst)
}

// CopyVerifiedExclusive delegates to storage.CopyVerifiedExclusive.
func CopyVerifiedExclusive(src, dst string) error {
	return storage.CopyVerifiedExclusive(src, dst)
}

func isStrictlyInside(root, candidate string) bool {
	return storage.IsStrictlyInside(root, candidate)
}

func deleteStoredFiles(
	ctx context.Context,
	root string,
	bookID string,
	sources []string,
	decision deleteDecision,
	commit func(operationID string) error,
) error {
	return storage.DeleteStoredFiles(ctx, root, bookID, sources, decision, commit)
}

// RecoverStoredDeletes delegates to storage.RecoverStoredDeletes.
func RecoverStoredDeletes(
	ctx context.Context,
	root string,
	decision deleteDecision,
	withLock func(bookID string, work func() error) error,
) error {
	return storage.RecoverStoredDeletes(ctx, root, decision, withLock)
}
