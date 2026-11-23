package logging

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	activeLogFilename = "delb.jsonl"
	rotatedPrefix     = "delb."
	rotatedSuffix     = ".jsonl"
)

// RotatorOptions configures bounded JSONL file rotation.
type RotatorOptions struct {
	Dir           string
	MaxFileBytes  int64
	MaxFiles      int
	MaxTotalBytes int64
	Now           func() time.Time
}

// FileRotator writes JSONL log lines into size-rotated files while enforcing
// strict file-count and total-byte caps.
type FileRotator struct {
	mu            sync.RWMutex
	dir           string
	maxFileBytes  int64
	maxFiles      int
	maxTotalBytes int64
	now           func() time.Time

	file       *os.File
	activeSize int64
	closed     bool
}

// NewFileRotator initializes a bounded JSONL rotator in opts.Dir.
func NewFileRotator(opts RotatorOptions) (*FileRotator, error) {
	dir := strings.TrimSpace(opts.Dir)
	if dir == "" {
		return nil, errors.New("log directory is required")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create log directory %q: %w", dir, err)
	}

	maxFileBytes := opts.MaxFileBytes
	if maxFileBytes <= 0 {
		maxFileBytes = DefaultMaxFileBytes
	}
	maxFiles := opts.MaxFiles
	if maxFiles <= 0 {
		maxFiles = DefaultMaxFiles
	}
	maxTotalBytes := opts.MaxTotalBytes
	if maxTotalBytes <= 0 {
		maxTotalBytes = DefaultMaxTotalBytes
	}
	if maxTotalBytes < maxFileBytes {
		maxTotalBytes = maxFileBytes
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = func() time.Time { return time.Now().UTC() }
	}

	r := &FileRotator{
		dir:           dir,
		maxFileBytes:  maxFileBytes,
		maxFiles:      maxFiles,
		maxTotalBytes: maxTotalBytes,
		now:           nowFn,
	}

	if err := r.openActiveLocked(); err != nil {
		return nil, err
	}
	r.pruneLocked()
	return r, nil
}

func (r *FileRotator) activePath() string {
	return filepath.Join(r.dir, activeLogFilename)
}

func (r *FileRotator) openActiveLocked() error {
	f, err := os.OpenFile(r.activePath(), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o640)
	if err != nil {
		return fmt.Errorf("open active log file: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return fmt.Errorf("stat active log file: %w", err)
	}
	r.file = f
	r.activeSize = info.Size()
	return nil
}

// WriteLine appends one JSONL line (adding trailing newline if missing),
// rotating and pruning older files when size/count bounds are exceeded.
func (r *FileRotator) WriteLine(line []byte) error {
	if len(line) == 0 {
		return nil
	}
	if line[len(line)-1] != '\n' {
		buf := make([]byte, len(line)+1)
		copy(buf, line)
		buf[len(line)] = '\n'
		line = buf
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.closed {
		return errors.New("log rotator is closed")
	}
	if r.file == nil {
		if err := r.openActiveLocked(); err != nil {
			return err
		}
	}

	if r.activeSize > 0 && r.activeSize+int64(len(line)) > r.maxFileBytes {
		if err := r.rotateLocked(); err != nil {
			return err
		}
	}

	n, err := r.file.Write(line)
	r.activeSize += int64(n)
	if err != nil {
		return err
	}

	if r.activeSize > r.maxTotalBytes {
		r.pruneLocked()
	}
	return nil
}

func (r *FileRotator) rotateLocked() error {
	if r.file != nil {
		_ = r.file.Close()
		r.file = nil
	}

	ts := r.now().UTC().Format("20060102T150405.000Z")
	rotatedPath := filepath.Join(r.dir, fmt.Sprintf("%s%s%s", rotatedPrefix, ts, rotatedSuffix))
	for seq := 1; fileExists(rotatedPath); seq++ {
		rotatedPath = filepath.Join(r.dir, fmt.Sprintf("%s%s.%d%s", rotatedPrefix, ts, seq, rotatedSuffix))
	}

	if err := os.Rename(r.activePath(), rotatedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		// Reopen active file so logging can continue even if rename failed.
		_ = r.openActiveLocked()
		return fmt.Errorf("rotate log file: %w", err)
	}

	r.activeSize = 0
	if err := r.openActiveLocked(); err != nil {
		return err
	}
	r.pruneLocked()
	return nil
}

type logFileInfo struct {
	name    string
	path    string
	size    int64
	active  bool
	modTime time.Time
}

func (r *FileRotator) listFilesLocked() []logFileInfo {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return nil
	}
	var rotated []logFileInfo
	var active *logFileInfo

	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if name == activeLogFilename {
			info, err := e.Info()
			if err != nil {
				continue
			}
			active = &logFileInfo{
				name:    name,
				path:    filepath.Join(r.dir, name),
				size:    info.Size(),
				active:  true,
				modTime: info.ModTime(),
			}
			continue
		}
		if strings.HasPrefix(name, rotatedPrefix) && strings.HasSuffix(name, rotatedSuffix) && len(name) > len(rotatedPrefix)+len(rotatedSuffix) {
			info, err := e.Info()
			if err != nil {
				continue
			}
			rotated = append(rotated, logFileInfo{
				name:    name,
				path:    filepath.Join(r.dir, name),
				size:    info.Size(),
				active:  false,
				modTime: info.ModTime(),
			})
		}
	}

	// Sort rotated files chronologically oldest -> newest by filename timestamp.
	sort.Slice(rotated, func(i, j int) bool {
		if rotated[i].name != rotated[j].name {
			return rotated[i].name < rotated[j].name
		}
		return rotated[i].modTime.Before(rotated[j].modTime)
	})

	if active != nil {
		rotated = append(rotated, *active)
	}
	return rotated
}

func (r *FileRotator) pruneLocked() {
	files := r.listFilesLocked()
	if len(files) == 0 {
		return
	}

	var totalBytes int64
	for _, f := range files {
		totalBytes += f.size
	}
	fileCount := len(files)

	// Delete oldest rotated files first; never delete the active file.
	for _, f := range files {
		if f.active {
			continue
		}
		if fileCount <= r.maxFiles && totalBytes <= r.maxTotalBytes {
			break
		}
		if err := os.Remove(f.path); err == nil {
			fileCount--
			totalBytes -= f.size
		}
	}
}

// ReadAll reads all persisted log entries chronologically across rotated files
// and the active file. Malformed or truncated lines are skipped gracefully.
func (r *FileRotator) ReadAll() ([]Entry, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	files := r.listFilesLocked()
	out := make([]Entry, 0, 256)
	for _, f := range files {
		entries, err := readJSONLEntries(f.path)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return out, err
		}
		out = append(out, entries...)
	}
	return out, nil
}

func readJSONLEntries(path string) ([]Entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	var out []Entry
	reader := bufio.NewReaderSize(f, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		trimmed := strings.TrimSpace(string(line))
		if trimmed != "" {
			var entry Entry
			if jerr := json.Unmarshal([]byte(trimmed), &entry); jerr == nil {
				out = append(out, entry)
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return out, err
		}
	}
	return out, nil
}

// Stats returns storage statistics for this rotator.
func (r *FileRotator) Stats() StorageInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	files := r.listFilesLocked()
	var totalBytes int64
	for _, f := range files {
		totalBytes += f.size
	}
	return StorageInfo{
		Enabled:       true,
		Dir:           r.dir,
		FileCount:     len(files),
		TotalBytes:    totalBytes,
		MaxFileBytes:  r.maxFileBytes,
		MaxFiles:      r.maxFiles,
		MaxTotalBytes: r.maxTotalBytes,
	}
}

// Close flushes and closes the active log file.
func (r *FileRotator) Close() error {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.closed = true
	if r.file != nil {
		err := r.file.Close()
		r.file = nil
		return err
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
