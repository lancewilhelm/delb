package spines

import (
	"context"
	"database/sql"
	"encoding/base64"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/lancewilhelm/delb/internal/storage"
)

// MigrateDBSpinesToFiles moves any legacy base64-encoded spine rows in
// book_spines onto disk inside each book's folder (right next to cover.webp),
// clears the database base64 columns, and runs VACUUM on file-backed databases
// when at least one row was migrated so SQLite reclaims disk space immediately.
func MigrateDBSpinesToFiles(
	ctx context.Context,
	db *sql.DB,
	libraryDir string,
	isMemory bool,
	logger *slog.Logger,
) (int, error) {
	if db == nil || libraryDir == "" {
		return 0, nil
	}
	if logger == nil {
		logger = slog.Default()
	}

	// Ensure the image_path column exists (defensive for external synthetic schemas).
	var colCount int
	if err := db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM pragma_table_info('book_spines') WHERE name = 'image_path'
	`).Scan(&colCount); err != nil || colCount == 0 {
		return 0, nil
	}

	rows, err := db.QueryContext(ctx, `
		SELECT book_id, original_base64, original_type, image_base64
		FROM book_spines
		WHERE (original_base64 != '' OR image_base64 != '')
		  AND (image_path = '' OR original_path = '')
	`)
	if err != nil {
		return 0, fmt.Errorf("query legacy book_spines: %w", err)
	}

	type legacyRow struct {
		bookID   string
		origB64  string
		origType string
		imageB64 string
	}
	var pending []legacyRow
	for rows.Next() {
		var r legacyRow
		if err := rows.Scan(&r.bookID, &r.origB64, &r.origType, &r.imageB64); err != nil {
			_ = rows.Close()
			return 0, fmt.Errorf("scan legacy book_spines: %w", err)
		}
		pending = append(pending, r)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	if len(pending) == 0 {
		return 0, nil
	}

	start := time.Now()
	migrated := 0
	for _, row := range pending {
		err := storage.WithBookStorageLock(ctx, libraryDir, row.bookID, func() error {
			relDir, absDir, err := storage.ResolveBookStorageDir(ctx, db, libraryDir, row.bookID)
			if err != nil {
				return err
			}

			var imgBytes, origBytes []byte
			if row.imageB64 != "" {
				imgBytes, err = base64.StdEncoding.DecodeString(row.imageB64)
				if err != nil {
					return fmt.Errorf("decode image_base64 for book %s: %w", row.bookID, err)
				}
			}
			if row.origB64 != "" {
				origBytes, err = base64.StdEncoding.DecodeString(row.origB64)
				if err != nil {
					return fmt.Errorf("decode original_base64 for book %s: %w", row.bookID, err)
				}
			}
			if len(origBytes) == 0 {
				origBytes = imgBytes
			}
			if len(imgBytes) == 0 {
				imgBytes = origBytes
			}
			if len(imgBytes) == 0 {
				return nil
			}

			ext := storage.SpineFileExt(row.origType)
			renderedName := "spine.webp"
			sourceName := "spine.source." + ext
			renderedRel := relDir + "/" + renderedName
			sourceRel := relDir + "/" + sourceName

			files := []storage.CoverUpdateFile{
				{TargetPath: filepath.Join(absDir, renderedName), Data: imgBytes},
				{TargetPath: filepath.Join(absDir, sourceName), Data: origBytes},
			}

			return storage.WriteBookSpineFiles(ctx, db, libraryDir, row.bookID, absDir, files, nil, func(opID string) error {
				tx, err := db.BeginTx(ctx, nil)
				if err != nil {
					return err
				}
				defer func() { _ = tx.Rollback() }()
				if _, err := tx.ExecContext(ctx, `
					INSERT INTO storage_operations (id, book_id, kind, created_at)
					VALUES (?, ?, 'cover', ?)
				`, opID, row.bookID, time.Now().UTC().Unix()); err != nil {
					return err
				}
				if _, err := tx.ExecContext(ctx, `
					UPDATE book_spines
					SET image_path = ?, original_path = ?, image_base64 = '', original_base64 = ''
					WHERE book_id = ?
				`, renderedRel, sourceRel, row.bookID); err != nil {
					return err
				}
				return tx.Commit()
			})
		})
		if err != nil {
			return migrated, fmt.Errorf("migrate spine to file for book %s: %w", row.bookID, err)
		}
		migrated++
	}

	if migrated > 0 && !isMemory {
		if _, err := db.ExecContext(ctx, `VACUUM`); err != nil {
			logger.Warn("sqlite VACUUM after spine file migration failed", "error", err)
		}
	}

	logger.Info("migrated database spine blobs to files",
		"migrated", migrated,
		"durationMs", time.Since(start).Milliseconds(),
	)
	return migrated, nil
}
