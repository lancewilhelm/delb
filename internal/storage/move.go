package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type MoveEntry struct {
	Source      string `json:"source"`
	Destination string `json:"destination"`
}

type MoveRecoveryWarning struct {
	JournalDir string
	Marker     string
	Entries    []MoveEntry
}

type moveJournal struct {
	Version int         `json:"version"`
	ID      string      `json:"id"`
	BookID  string      `json:"bookId"`
	Entries []MoveEntry `json:"entries"`
}

// DBMoveDecision returns an OperationDecision backed by storage_operations for move ops.
func DBMoveDecision(db *sql.DB) OperationDecision {
	return OperationDecision{
		IsCommitted: func(ctx context.Context, id string) (bool, error) {
			var existing string
			err := db.QueryRowContext(ctx, `
				SELECT id FROM storage_operations WHERE id = ? AND kind = 'move' LIMIT 1
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
				DELETE FROM storage_operations WHERE id = ? AND kind = 'move'
			`, id)
			return err
		},
	}
}

func validateMoveJournal(root string, j moveJournal) error {
	if j.Version != 1 || j.ID == "" || j.BookID == "" {
		return errors.New("Invalid move journal")
	}
	dests := make(map[string]struct{}, len(j.Entries))
	for _, entry := range j.Entries {
		if entry.Source == "" || entry.Destination == "" {
			return errors.New("Invalid move path")
		}
		if !IsStrictlyInside(root, entry.Source) || !IsStrictlyInside(root, entry.Destination) {
			return errors.New("Move path escapes library")
		}
		if _, dup := dests[entry.Destination]; dup {
			return errors.New("Multiple files have the same move destination")
		}
		dests[entry.Destination] = struct{}{}
	}
	return nil
}

func retainMoveConflict(dir, marker string, journal moveJournal) error {
	var destinations strings.Builder
	for index, entry := range journal.Entries {
		pairs := []struct {
			kind string
			src  string
		}{
			{"source", entry.Source},
			{"destination", entry.Destination},
		}
		for _, pair := range pairs {
			present, err := pathExists(pair.src)
			if err != nil {
				return err
			}
			if pair.kind == "destination" {
				if present {
					destinations.WriteByte('1')
				} else {
					destinations.WriteByte('0')
				}
			}
			if !present {
				if pair.kind == "source" {
					return fmt.Errorf("Uncommitted move source is missing: %s", pair.src)
				}
				continue
			}
			retained := filepath.Join(dir, fmt.Sprintf("retained-%s-%d", pair.kind, index))
			rExists, err := pathExists(retained)
			if err != nil {
				return err
			}
			if rExists {
				same, err := SameFileContents(pair.src, retained)
				if err != nil {
					return err
				}
				if !same {
					return fmt.Errorf("Retained move copy changed: %s", retained)
				}
				continue
			}
			temporary := filepath.Join(dir, "copy-"+uuid.NewString())
			copyErr := CopyVerifiedExclusive(pair.src, temporary)
			if copyErr == nil {
				copyErr = os.Rename(temporary, retained)
			}
			_ = os.Remove(temporary)
			if copyErr != nil {
				return copyErr
			}
		}
	}
	temporary := filepath.Join(dir, "marker-"+uuid.NewString())
	err := WriteFileSyncExclusive(temporary, []byte("retained-v1:"+destinations.String()))
	if err == nil {
		err = os.Rename(temporary, marker)
	}
	_ = os.Remove(temporary)
	return err
}

func finishMoveJournal(ctx context.Context, root, dir string, journal moveJournal, decision OperationDecision) (*MoveRecoveryWarning, error) {
	if err := validateMoveJournal(root, journal); err != nil {
		return nil, err
	}
	marker := filepath.Join(root, ".delb-failed-move-"+journal.ID)
	committed, err := decision.IsCommitted(ctx, journal.ID)
	if err != nil {
		return nil, err
	}
	markerExists, err := pathExists(marker)
	if err != nil {
		return nil, err
	}
	if markerExists {
		if committed {
			return nil, fmt.Errorf("Committed move has a failed recovery marker: %s", marker)
		}
		raw, err := os.ReadFile(marker)
		if err != nil {
			return nil, err
		}
		contents := string(raw)
		if strings.HasPrefix(contents, "retained-v1:") {
			dests := strings.TrimPrefix(contents, "retained-v1:")
			if len(dests) != len(journal.Entries) {
				return nil, fmt.Errorf("Invalid move recovery marker: %s", marker)
			}
			for i := range journal.Entries {
				if dests[i] != '0' && dests[i] != '1' {
					return nil, fmt.Errorf("Invalid move recovery marker: %s", marker)
				}
				if ok, err := pathExists(filepath.Join(dir, "retained-source-"+strconv.Itoa(i))); err != nil || !ok {
					if err != nil {
						return nil, err
					}
					return nil, fmt.Errorf("Retained move source is missing: %s", dir)
				}
				if dests[i] == '1' {
					if ok, err := pathExists(filepath.Join(dir, "retained-destination-"+strconv.Itoa(i))); err != nil || !ok {
						if err != nil {
							return nil, err
						}
						return nil, fmt.Errorf("Retained move destination is missing: %s", dir)
					}
				}
			}
			return &MoveRecoveryWarning{JournalDir: dir, Marker: marker, Entries: journal.Entries}, nil
		}
		if contents != "" {
			return nil, fmt.Errorf("Invalid move recovery marker: %s", marker)
		}
		if err := retainMoveConflict(dir, marker, journal); err != nil {
			return nil, err
		}
		return &MoveRecoveryWarning{JournalDir: dir, Marker: marker, Entries: journal.Entries}, nil
	}

	if !committed {
		for _, entry := range journal.Entries {
			ok, err := pathExists(entry.Source)
			if err != nil {
				return nil, err
			}
			if !ok {
				return nil, fmt.Errorf("Uncommitted move source is missing: %s", entry.Source)
			}
		}
	}

	if committed {
		for _, entry := range journal.Entries {
			dstOK, err := pathExists(entry.Destination)
			if err != nil {
				return nil, err
			}
			if !dstOK {
				return nil, fmt.Errorf("Committed move destination is missing: %s", entry.Destination)
			}
			srcOK, err := pathExists(entry.Source)
			if err != nil {
				return nil, err
			}
			if !srcOK {
				continue
			}
			same, err := SameFileContents(entry.Source, entry.Destination)
			if err != nil {
				return nil, err
			}
			if !same {
				return nil, fmt.Errorf("Moved file changed: %s", entry.Source)
			}
			if err := os.Remove(entry.Source); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
		}
	} else {
		for _, entry := range journal.Entries {
			dstOK, err := pathExists(entry.Destination)
			if err != nil {
				return nil, err
			}
			if !dstOK {
				continue
			}
			same, err := SameFileContents(entry.Source, entry.Destination)
			if err != nil {
				return nil, err
			}
			if !same {
				if err := retainMoveConflict(dir, marker, journal); err != nil {
					return nil, err
				}
				return &MoveRecoveryWarning{JournalDir: dir, Marker: marker, Entries: journal.Entries}, nil
			}
			if err := os.Remove(entry.Destination); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
		}
	}

	if err := os.RemoveAll(dir); err != nil {
		return nil, err
	}
	return nil, decision.Remove(ctx, journal.ID)
}

// MoveStoredFiles mirrors server/utils/books/storage/move-operation.ts moveStoredFiles.
func MoveStoredFiles(
	ctx context.Context,
	root string,
	bookID string,
	entries []MoveEntry,
	decision OperationDecision,
	commit func(operationID string) error,
) error {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	journal := moveJournal{
		Version: 1,
		ID:      uuid.NewString(),
		BookID:  bookID,
		Entries: entries,
	}
	if err := validateMoveJournal(absRoot, journal); err != nil {
		return err
	}
	for _, entry := range journal.Entries {
		ok, err := pathExists(entry.Destination)
		if err != nil {
			return err
		}
		if ok {
			return fmt.Errorf("Move destination already exists: %s", entry.Destination)
		}
	}

	dir := filepath.Join(absRoot, ".delb-move-"+journal.ID)
	preparing := filepath.Join(absRoot, ".delb-preparing-move-"+journal.ID)
	if err := os.Mkdir(preparing, 0o755); err != nil {
		return err
	}
	raw, err := json.Marshal(journal)
	if err != nil {
		return err
	}
	if err := WriteFileSyncExclusive(filepath.Join(preparing, "journal.json"), raw); err != nil {
		return err
	}
	if err := os.Rename(preparing, dir); err != nil {
		return err
	}

	for _, entry := range journal.Entries {
		if err := os.MkdirAll(filepath.Dir(entry.Destination), 0o755); err != nil {
			return err
		}
		if err := CopyVerifiedExclusive(entry.Source, entry.Destination); err != nil {
			return err
		}
	}

	if err := commit(journal.ID); err != nil {
		return err
	}
	_, err = finishMoveJournal(ctx, absRoot, dir, journal, decision)
	return err
}

// RecoverStoredMoves mirrors server/utils/books/storage/move-operation.ts recoverStoredMoves.
func RecoverStoredMoves(
	ctx context.Context,
	root string,
	decision OperationDecision,
	withLock func(bookID string, work func() error) error,
) ([]MoveRecoveryWarning, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	var warnings []MoveRecoveryWarning
	entries, err := os.ReadDir(absRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return warnings, nil
		}
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, ".delb-move-") {
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
			return nil, err
		}
		var journal moveJournal
		if err := json.Unmarshal(raw, &journal); err != nil {
			return nil, err
		}
		if err := validateMoveJournal(absRoot, journal); err != nil {
			return nil, err
		}
		if name != ".delb-move-"+journal.ID {
			return nil, errors.New("Invalid move journal identity")
		}
		if err := withLock(journal.BookID, func() error {
			ok, err := pathExists(dir)
			if err != nil || !ok {
				return err
			}
			w, err := finishMoveJournal(ctx, absRoot, dir, journal, decision)
			if err != nil {
				return err
			}
			if w != nil {
				warnings = append(warnings, *w)
			}
			return nil
		}); err != nil {
			return nil, err
		}
	}
	return warnings, nil
}

// MoveBookStorageResult reports the outcome of MoveBookStorageToCanonical.
type MoveBookStorageResult struct {
	Moved            bool
	Reason           string
	FromDir          string
	ToDir            string
	UpdatedFileCount int
	MovedCover       bool
}

// MoveBookStorageToCanonical mirrors server/utils/books/storage/move/move-book-storage.ts.
// Callers must hold the book storage lock before calling this function.
func MoveBookStorageToCanonical(
	ctx context.Context,
	db *sql.DB,
	libraryRoot string,
	bookID string,
	authorize func(tx *sql.Tx) error,
) (MoveBookStorageResult, error) {
	absRoot, err := filepath.Abs(libraryRoot)
	if err != nil {
		return MoveBookStorageResult{}, err
	}

	var title string
	var coverImagePath sql.NullString
	err = db.QueryRowContext(ctx, `SELECT title, cover_image_path FROM books WHERE id = ? LIMIT 1`, bookID).Scan(&title, &coverImagePath)
	if errors.Is(err, sql.ErrNoRows) {
		return MoveBookStorageResult{}, httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if err != nil {
		return MoveBookStorageResult{}, err
	}

	type authorLink struct {
		name     string
		position sql.NullInt64
	}
	aRows, err := db.QueryContext(ctx, `
		SELECT a.name, ba.position
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id = ?
	`, bookID)
	if err != nil {
		return MoveBookStorageResult{}, err
	}
	var links []authorLink
	for aRows.Next() {
		var l authorLink
		if err := aRows.Scan(&l.name, &l.position); err != nil {
			_ = aRows.Close()
			return MoveBookStorageResult{}, err
		}
		links = append(links, l)
	}
	if err := aRows.Close(); err != nil {
		return MoveBookStorageResult{}, err
	}
	sort.Slice(links, func(i, j int) bool {
		ap := int64(10000)
		if links[i].position.Valid {
			ap = links[i].position.Int64
		}
		bp := int64(10000)
		if links[j].position.Valid {
			bp = links[j].position.Int64
		}
		if ap != bp {
			return ap < bp
		}
		return links[i].name < links[j].name
	})
	orderedAuthors := make([]string, 0, len(links))
	for _, l := range links {
		if l.name != "" {
			orderedAuthors = append(orderedAuthors, l.name)
		}
	}

	canonical := GetCanonicalBookPaths(orderedAuthors, title, bookID)

	type fileRow struct {
		id           string
		format       string
		relativePath string
	}
	fRows, err := db.QueryContext(ctx, `SELECT id, format, relative_path FROM book_files WHERE book_id = ?`, bookID)
	if err != nil {
		return MoveBookStorageResult{}, err
	}
	var files []fileRow
	for fRows.Next() {
		var f fileRow
		if err := fRows.Scan(&f.id, &f.format, &f.relativePath); err != nil {
			_ = fRows.Close()
			return MoveBookStorageResult{}, err
		}
		files = append(files, f)
	}
	if err := fRows.Close(); err != nil {
		return MoveBookStorageResult{}, err
	}

	currentDirPosix := ""
	if len(files) > 0 {
		preferred := files[0]
		for _, f := range files {
			if strings.EqualFold(f.format, "epub") {
				preferred = f
				break
			}
		}
		if preferred.relativePath != "" {
			currentDirPosix = dirnamePosix(preferred.relativePath)
		}
	} else if coverImagePath.Valid && coverImagePath.String != "" {
		currentDirPosix = dirnamePosix(coverImagePath.String)
	}
	if currentDirPosix == "" {
		return MoveBookStorageResult{Moved: false, Reason: "no-files"}, nil
	}

	targetDirPosix := canonical.BookDir
	if NormalizePosix(currentDirPosix) == NormalizePosix(targetDirPosix) {
		cleanupEmptyLibraryDirs(absRoot)
		return MoveBookStorageResult{
			Moved:   false,
			Reason:  "already-canonical",
			FromDir: currentDirPosix,
			ToDir:   targetDirPosix,
		}, nil
	}

	targetDirAbs, err := ResolveUnderLibrary(absRoot, targetDirPosix)
	if err != nil {
		return MoveBookStorageResult{}, err
	}
	currentDirAbs, err := ResolveUnderLibrary(absRoot, currentDirPosix)
	if err != nil {
		return MoveBookStorageResult{}, err
	}

	type fileUpdate struct {
		id           string
		relativePath string
	}
	var entries []MoveEntry
	var updates []fileUpdate
	knownSources := make(map[string]struct{})

	for _, f := range files {
		if f.relativePath == "" {
			continue
		}
		source, err := ResolveUnderLibrary(absRoot, f.relativePath)
		if err != nil {
			return MoveBookStorageResult{}, err
		}
		knownSources[source] = struct{}{}
		format := strings.ToLower(strings.TrimSpace(f.format))
		relPath := f.relativePath
		if format != "" {
			t := title
			if t == "" {
				t = "Untitled"
			}
			relPath = BuildBookStorageRelativePath(orderedAuthors, title, bookID, t+"."+format)
		}
		dest, err := ResolveUnderLibrary(absRoot, relPath)
		if err != nil {
			return MoveBookStorageResult{}, err
		}
		if source == dest {
			continue
		}
		ok, err := pathExists(source)
		if err != nil {
			return MoveBookStorageResult{}, err
		}
		if !ok {
			return MoveBookStorageResult{}, fmt.Errorf("Canonical move source is missing: %s", f.relativePath)
		}
		entries = append(entries, MoveEntry{Source: source, Destination: dest})
		updates = append(updates, fileUpdate{id: f.id, relativePath: relPath})
	}

	var newCoverPath string
	if coverImagePath.Valid && coverImagePath.String != "" {
		source, err := ResolveUnderLibrary(absRoot, coverImagePath.String)
		if err != nil {
			return MoveBookStorageResult{}, err
		}
		knownSources[source] = struct{}{}
		dest := filepath.Join(targetDirAbs, filepath.Base(source))
		if source != dest {
			ok, err := pathExists(source)
			if err != nil {
				return MoveBookStorageResult{}, err
			}
			if !ok {
				return MoveBookStorageResult{}, fmt.Errorf("Canonical cover is missing: %s", coverImagePath.String)
			}
			entries = append(entries, MoveEntry{Source: source, Destination: dest})
			rel, err := filepath.Rel(absRoot, dest)
			if err != nil {
				return MoveBookStorageResult{}, err
			}
			newCoverPath = BaseDir + "/" + filepath.ToSlash(rel)
		}
	}

	sidecars, err := os.ReadDir(currentDirAbs)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return MoveBookStorageResult{}, err
	}
	for _, entry := range sidecars {
		source := filepath.Join(currentDirAbs, entry.Name())
		if _, ok := knownSources[source]; ok {
			continue
		}
		if entry.IsDir() || !entry.Type().IsRegular() {
			return MoveBookStorageResult{}, fmt.Errorf("Cannot safely move sidecar: %s", source)
		}
		entries = append(entries, MoveEntry{
			Source:      source,
			Destination: filepath.Join(targetDirAbs, entry.Name()),
		})
	}

	if len(entries) == 0 {
		return MoveBookStorageResult{Moved: false, Reason: "no-files"}, nil
	}

	if err := MoveStoredFiles(ctx, absRoot, bookID, entries, DBMoveDecision(db), func(opID string) error {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		if authorize != nil {
			if err := authorize(tx); err != nil {
				return err
			}
		}
		now := time.Now().UTC().Unix()
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO storage_operations (id, book_id, kind, created_at) VALUES (?, ?, 'move', ?)
		`, opID, bookID, now); err != nil {
			return err
		}
		for _, upd := range updates {
			if _, err := tx.ExecContext(ctx, `
				UPDATE book_files SET relative_path = ? WHERE id = ?
			`, upd.relativePath, upd.id); err != nil {
				return err
			}
		}
		if newCoverPath != "" {
			if _, err := tx.ExecContext(ctx, `
				UPDATE books SET cover_image_path = ?, updated_at = ? WHERE id = ?
			`, newCoverPath, now, bookID); err != nil {
				return err
			}
		}
		return tx.Commit()
	}); err != nil {
		return MoveBookStorageResult{}, err
	}

	_ = os.Remove(currentDirAbs)
	cleanupEmptyParents(filepath.Dir(currentDirAbs), absRoot)

	return MoveBookStorageResult{
		Moved:            true,
		Reason:           "moved",
		FromDir:          currentDirPosix,
		ToDir:            targetDirPosix,
		UpdatedFileCount: len(updates),
		MovedCover:       newCoverPath != "",
	}, nil
}

func dirnamePosix(posixPath string) string {
	cleaned := NormalizePosix(posixPath)
	d := path.Dir(cleaned)
	if d == "." {
		return ""
	}
	return d
}

func cleanupEmptyParents(startDirAbs, stopAtAbs string) {
	current := filepath.Clean(startDirAbs)
	stop := filepath.Clean(stopAtAbs)
	for current != "" && current != stop && current != filepath.Dir(current) {
		if err := os.Remove(current); err != nil && !errors.Is(err, os.ErrNotExist) {
			break
		}
		current = filepath.Dir(current)
	}
}

func cleanupEmptyLibraryDirs(absRoot string) {
	entries, err := os.ReadDir(absRoot)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		_ = os.Remove(filepath.Join(absRoot, e.Name()))
	}
}
