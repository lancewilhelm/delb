package dropbox

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/storage"
)

var processingClaimRe = regexp.MustCompile(`(?i)^(.*)\.delb-processing-([0-9a-f-]{36})$`)

type seenFile struct {
	size         int64
	mtimeUnixNs  int64
	stablePasses int
	lastSeenAt   time.Time
}

// WatcherOptions configures the Dropbox ingest directory watcher.
type WatcherOptions struct {
	DB         *sql.DB
	LibraryDir string
	BaseDir    string
	Logger     *slog.Logger
}

// Watcher polls the configured Dropbox directory for ebook files and recovers
// interrupted claim files on startup.
type Watcher struct {
	db         *sql.DB
	libraryDir string
	baseDir    string
	logger     *slog.Logger

	mu       sync.Mutex
	scanning bool
	seen     map[string]seenFile
	done     chan struct{}
}

// NewWatcher creates a Dropbox ingest watcher.
func NewWatcher(opts WatcherOptions) *Watcher {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	libraryDir := opts.LibraryDir
	if libraryDir == "" {
		libraryDir = "library"
	}
	if abs, err := filepath.Abs(libraryDir); err == nil {
		libraryDir = abs
	}
	baseDir := opts.BaseDir
	if baseDir == "" {
		if cwd, err := os.Getwd(); err == nil {
			baseDir = cwd
		}
	}
	return &Watcher{
		db:         opts.DB,
		libraryDir: libraryDir,
		baseDir:    baseDir,
		logger:     logger,
		seen:       make(map[string]seenFile),
		done:       make(chan struct{}),
	}
}

// Start waits for recoveryGate (if non-nil) and runs the polling loop until ctx is cancelled.
func (w *Watcher) Start(ctx context.Context, recoveryGate *storage.RecoveryGate) {
	go func() {
		defer close(w.done)
		if recoveryGate != nil {
			if err := recoveryGate.Wait(ctx); err != nil {
				if ctx.Err() == nil {
					w.logger.Error("Storage recovery failed; Dropbox watcher did not start", "error", err)
				}
				return
			}
		}
		w.logger.Info("dropbox watcher started", "libraryDir", w.libraryDir, "baseDir", w.baseDir)
		defer w.logger.Info("dropbox watcher stopped")
		for {
			if ctx.Err() != nil {
				return
			}
			if err := w.ScanOnce(ctx); err != nil && ctx.Err() == nil {
				w.logger.Error("dropbox watcher scan failed", "error", err)
			}
			cfg := w.loadConfig(ctx)
			pollInterval := cfg.PollInterval
			if pollInterval < 25*time.Millisecond {
				pollInterval = 25 * time.Millisecond
			}
			timer := time.NewTimer(pollInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
}

// Wait blocks until the watcher goroutine has exited after ctx cancellation.
func (w *Watcher) Wait() {
	<-w.done
}

func (w *Watcher) loadConfig(ctx context.Context) Config {
	root := readGlobalSettingsMap(ctx, w.db)
	return resolveConfigFromSettings(w.baseDir, root)
}

func (w *Watcher) noteSeen(cfg Config, fileAbs string, size, mtimeUnixNs int64) bool {
	now := time.Now()
	prev, ok := w.seen[fileAbs]
	if !ok {
		w.seen[fileAbs] = seenFile{size: size, mtimeUnixNs: mtimeUnixNs, stablePasses: 1, lastSeenAt: now}
		return cfg.StablePassesRequired <= 1
	}
	stablePasses := 1
	if prev.size == size && prev.mtimeUnixNs == mtimeUnixNs {
		stablePasses = prev.stablePasses + 1
	}
	w.seen[fileAbs] = seenFile{size: size, mtimeUnixNs: mtimeUnixNs, stablePasses: stablePasses, lastSeenAt: now}
	return stablePasses >= cfg.StablePassesRequired
}

func (w *Watcher) pruneSeen(cfg Config) {
	now := time.Now()
	for k, v := range w.seen {
		if now.Sub(v.lastSeenAt) > cfg.StableMaxAge {
			delete(w.seen, k)
		}
	}
}

// ScanOnce executes one locked Dropbox directory scan and claim-recovery pass.
func (w *Watcher) ScanOnce(ctx context.Context) error {
	w.mu.Lock()
	if w.scanning {
		w.mu.Unlock()
		return nil
	}
	w.scanning = true
	w.mu.Unlock()
	defer func() {
		w.mu.Lock()
		w.scanning = false
		w.mu.Unlock()
	}()

	return storage.WithBookStorageLock(ctx, w.libraryDir, "__dropbox_watcher__", func() error {
		cfg := w.loadConfig(ctx)
		if !cfg.Enabled {
			return nil
		}
		if err := os.MkdirAll(cfg.DropboxDirAbs, 0o755); err != nil {
			return err
		}
		if err := os.MkdirAll(cfg.FailedDirAbs, 0o755); err != nil {
			return err
		}

		entries, err := os.ReadDir(cfg.DropboxDirAbs)
		if err != nil {
			return err
		}
		w.pruneSeen(cfg)

		type readyFile struct {
			fileAbs  string
			filename string
		}
		var ready []readyFile

		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := e.Name()
			if strings.HasPrefix(name, ".") || name == ".gitkeep" {
				continue
			}
			extLower := strings.ToLower(filepath.Ext(name))
			_, extAllowed := cfg.AllowedExtensions[extLower]
			isClaim := processingClaimRe.MatchString(name)
			if !extAllowed && !isClaim {
				continue
			}

			fileAbs := filepath.Join(cfg.DropboxDirAbs, name)
			st, err := os.Stat(fileAbs)
			if err != nil || !st.Mode().IsRegular() {
				continue
			}
			if !isClaim && !w.noteSeen(cfg, fileAbs, st.Size(), st.ModTime().UnixNano()) {
				continue
			}
			ready = append(ready, readyFile{fileAbs: fileAbs, filename: name})
		}

		if len(ready) == 0 {
			return nil
		}
		w.logger.Debug("dropbox scan found ready files", "count", len(ready), "dir", cfg.DropboxDirAbs)

		var batchTarget *Target

		for _, r := range ready {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			m := processingClaimRe.FindStringSubmatch(r.filename)
			claimed := m != nil
			originalFilename := r.filename
			operationID := ""
			processingAbs := r.fileAbs

			if claimed {
				originalFilename = m[1]
				operationID = m[2]
			} else {
				operationID = uuid.NewString()
				processingAbs = filepath.Join(cfg.DropboxDirAbs, fmt.Sprintf("%s.delb-processing-%s", originalFilename, operationID))
				if batchTarget == nil {
					t, err := resolveDropboxTarget(ctx, w.db)
					if err != nil {
						return err
					}
					batchTarget = &t
				}
				if _, err := retainDropboxClaimTarget(ctx, w.db, operationID, *batchTarget); err != nil {
					return err
				}
				if err := os.Rename(r.fileAbs, processingAbs); err != nil {
					_ = removeDropboxClaimTarget(ctx, w.db, operationID)
					continue
				}
			}

			// Check if this dropbox operation already committed in DB.
			var committedBookID string
			markerErr := w.db.QueryRowContext(ctx, `
				SELECT book_id FROM storage_operations WHERE id = ? AND kind = 'dropbox' LIMIT 1
			`, operationID).Scan(&committedBookID)
			if markerErr == nil && committedBookID != "" {
				var relPath string
				fErr := w.db.QueryRowContext(ctx, `
					SELECT relative_path FROM book_files WHERE book_id = ? LIMIT 1
				`, committedBookID).Scan(&relPath)
				if fErr != nil || relPath == "" {
					return fmt.Errorf("Dropbox committed file is missing: %s", processingAbs)
				}
				destAbs, err := storage.ResolveUnderLibrary(w.libraryDir, relPath)
				if err != nil {
					return err
				}
				if err := finishCommittedDropboxClaim(processingAbs, destAbs, func() error {
					_, derr := w.db.ExecContext(ctx, `DELETE FROM storage_operations WHERE id = ?`, operationID)
					return derr
				}); err != nil {
					return err
				}
				_ = removeDropboxClaimTarget(ctx, w.db, operationID)
				delete(w.seen, r.fileAbs)
				delete(w.seen, processingAbs)
				continue
			}
			if markerErr != nil && !errors.Is(markerErr, sql.ErrNoRows) {
				return markerErr
			}

			ingestStart := time.Now()
			err := func() error {
				target, err := readDropboxClaimTarget(ctx, w.db, operationID)
				if err != nil {
					return err
				}
				res, err := ingestDropboxFile(ctx, w.db, w.libraryDir, w.logger, processingAbs, originalFilename, operationID, target)
				if err != nil {
					return err
				}
				destAbs, err := storage.ResolveUnderLibrary(w.libraryDir, res.RelativePath)
				if err != nil {
					return err
				}
				if err := finishCommittedDropboxClaim(processingAbs, destAbs, func() error {
					_, derr := w.db.ExecContext(ctx, `DELETE FROM storage_operations WHERE id = ?`, operationID)
					return derr
				}); err != nil {
					return err
				}
				_ = removeDropboxClaimTarget(ctx, w.db, operationID)
				w.logger.Info("dropbox ingested book",
					"bookId", res.BookID,
					"filename", originalFilename,
					"relativePath", res.RelativePath,
					"durationMs", time.Since(ingestStart).Milliseconds(),
				)
				return nil
			}()

			delete(w.seen, r.fileAbs)
			delete(w.seen, processingAbs)

			if err != nil {
				w.logger.Error("dropbox ingest failed",
					"filename", originalFilename,
					"durationMs", time.Since(ingestStart).Milliseconds(),
					"error", err,
				)
				var existingOpID string
				if qerr := w.db.QueryRowContext(ctx, `SELECT id FROM storage_operations WHERE id = ? LIMIT 1`, operationID).Scan(&existingOpID); qerr == nil && existingOpID != "" {
					continue
				}
				if moveToFailed(cfg.FailedDirAbs, processingAbs, originalFilename, err.Error(), time.Now()) {
					_ = removeDropboxClaimTarget(ctx, w.db, operationID)
					w.logger.Warn("dropbox moved failed file", "filename", originalFilename, "failedDir", cfg.FailedDirAbs)
				}
			}
		}
		return nil
	})
}
