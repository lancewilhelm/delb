package storage

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// RecoveryGate mirrors server/middleware/storage-recovery.ts and
// server/utils/books/storage/recovery-ready.ts.
// On startup, it runs create -> cover -> move -> delete recovery (retrying if a
// storage lock is busy) and blocks incoming HTTP requests until recovery completes.
type RecoveryGate struct {
	ready chan struct{}
	once  sync.Once
	mu    sync.Mutex
	err   error
}

// StartRecovery launches startup storage recovery in the background and returns
// a gate whose Middleware waits for completion.
func StartRecovery(ctx context.Context, db *sql.DB, libraryRoot string, logger *slog.Logger) *RecoveryGate {
	if logger == nil {
		logger = slog.Default()
	}
	g := &RecoveryGate{
		ready: make(chan struct{}),
	}
	if db == nil || libraryRoot == "" {
		g.finish(nil)
		return g
	}
	go func() {
		start := time.Now()
		logger.Debug("starting storage recovery", "libraryRoot", libraryRoot)
		for {
			err := RecoverAll(ctx, db, libraryRoot, logger)
			if err == nil {
				logger.Info("storage startup recovery completed", "durationMs", time.Since(start).Milliseconds())
				g.finish(nil)
				return
			}
			if errors.Is(err, ErrBookStorageLockBusy) {
				logger.Debug("storage recovery waiting for busy book lock")
				select {
				case <-ctx.Done():
					g.finish(ctx.Err())
					return
				case <-time.After(1 * time.Second):
					continue
				}
			}
			logger.Error("storage startup recovery failed", "error", err)
			g.finish(err)
			return
		}
	}()
	return g
}

func (g *RecoveryGate) finish(err error) {
	g.once.Do(func() {
		g.mu.Lock()
		g.err = err
		g.mu.Unlock()
		close(g.ready)
	})
}

// Wait blocks until startup storage recovery finishes or ctx is cancelled.
func (g *RecoveryGate) Wait(ctx context.Context) error {
	if g == nil {
		return nil
	}
	select {
	case <-g.ready:
		g.mu.Lock()
		defer g.mu.Unlock()
		return g.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Middleware wraps next so requests wait for startup storage recovery.
func (g *RecoveryGate) Middleware(next http.Handler) http.Handler {
	if g == nil {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := g.Wait(r.Context()); err != nil {
			httpapi.WriteError(w, http.StatusServiceUnavailable, "Storage recovery unavailable")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RecoverAll executes create, cover, move, and delete recovery in the exact
// order used by Nitro's storageRecoveryReady.
func RecoverAll(ctx context.Context, db *sql.DB, libraryRoot string, logger *slog.Logger) error {
	withLock := func(bookID string, work func() error) error {
		return WithBookStorageLock(ctx, libraryRoot, bookID, work)
	}
	if err := RecoverStoredCreates(ctx, libraryRoot, DBCreateDecision(db), withLock); err != nil {
		return err
	}
	if err := RecoverBookCovers(ctx, db, libraryRoot); err != nil {
		return err
	}
	warnings, err := RecoverStoredMoves(ctx, libraryRoot, DBMoveDecision(db), withLock)
	if err != nil {
		return err
	}
	if logger != nil {
		for _, w := range warnings {
			logger.Warn("Uncommitted move needs inspection; conflicting files and journal retained",
				"journalDir", w.JournalDir, "marker", w.Marker)
		}
	}
	if err := RecoverStoredDeletes(ctx, libraryRoot, DBDeleteDecision(db), withLock); err != nil {
		return err
	}
	return nil
}
