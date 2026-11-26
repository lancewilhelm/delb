package spines

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	MaxImageReferences       = 16
	MaxSeriesSpineReferences = MaxImageReferences - 1
)

type SeriesSpineReference struct {
	BookID      string   `json:"bookId"`
	Title       string   `json:"title"`
	SeriesIndex *float64 `json:"seriesIndex"`
	Revision    string   `json:"revision"`
	ImageBase64 string   `json:"-"`
}

type SelectedSeriesSpine struct {
	BookID   string `json:"bookId"`
	Revision string `json:"revision"`
}

// ParseSelectedSeriesSpines mirrors shared/spine-series-references.ts parseSelectedSeriesSpines.
func ParseSelectedSeriesSpines(raw any) ([]SelectedSeriesSpine, bool) {
	arr, ok := raw.([]any)
	if !ok || len(arr) > MaxSeriesSpineReferences {
		return nil, false
	}
	seen := make(map[string]struct{}, len(arr))
	result := make([]SelectedSeriesSpine, 0, len(arr))
	for _, elem := range arr {
		m, ok := elem.(map[string]any)
		if !ok || m == nil {
			return nil, false
		}
		bookID, ok := m["bookId"].(string)
		if !ok || bookID == "" || len(bookID) > 128 {
			return nil, false
		}
		revision, ok := m["revision"].(string)
		if !ok || revision == "" || len(revision) > 128 {
			return nil, false
		}
		if _, dup := seen[bookID]; dup {
			return nil, false
		}
		seen[bookID] = struct{}{}
		result = append(result, SelectedSeriesSpine{
			BookID:   bookID,
			Revision: revision,
		})
	}
	return result, true
}

// FindSeriesSpines mirrors server/utils/books/series-spine-references.ts findSeriesSpines.
// When selected is nil, returns all visible spines in the same series (without imageBase64).
// When selected is non-nil, verifies every selected spine is still visible in the same series
// with the exact matching revision and loads imageBase64.
func FindSeriesSpines(ctx context.Context, db *sql.DB, userID, bookID string, selected []SelectedSeriesSpine) ([]SeriesSpineReference, error) {
	var (
		seriesID    sql.NullString
		seriesIndex sql.NullFloat64
	)
	err := db.QueryRowContext(ctx, `
		SELECT series_id, series_index FROM books WHERE id = ? LIMIT 1
	`, bookID).Scan(&seriesID, &seriesIndex)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if errors.Is(err, sql.ErrNoRows) || !seriesID.Valid || seriesID.String == "" {
		if len(selected) > 0 {
			return nil, httpapi.NewError(http.StatusConflict, "Series references changed. Reload them before generating.")
		}
		return []SeriesSpineReference{}, nil
	}
	if selected != nil && len(selected) == 0 {
		return []SeriesSpineReference{}, nil
	}

	includeImages := selected != nil
	selectImg := `''`
	if includeImages {
		selectImg = `bs.image_base64`
	}

	args := []any{userID, seriesID.String, bookID}
	whereExtra := ""
	if includeImages {
		ph := strings.TrimRight(strings.Repeat("?,", len(selected)), ",")
		whereExtra = " AND b.id IN (" + ph + ")"
		for _, sel := range selected {
			args = append(args, sel.BookID)
		}
	}

	orderExpr := "b.series_index ASC"
	if seriesIndex.Valid {
		orderExpr = "ABS(b.series_index - ?) ASC"
		args = append(args, seriesIndex.Float64)
	}

	query := `
		SELECT b.id, b.title, b.series_index, bs.revision, ` + selectImg + `
		FROM books b
		INNER JOIN book_spines bs ON bs.book_id = b.id
		INNER JOIN visible_books vb ON vb.book_id = b.id AND vb.user_id = ?
		WHERE b.series_id = ? AND b.id != ?` + whereExtra + `
		ORDER BY
			CASE WHEN b.series_index IS NULL THEN 1 ELSE 0 END ASC,
			` + orderExpr + `,
			b.series_index ASC,
			b.id ASC
	`

	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make([]SeriesSpineReference, 0)
	for rows.Next() {
		var (
			r   SeriesSpineReference
			idx sql.NullFloat64
		)
		if err := rows.Scan(&r.BookID, &r.Title, &idx, &r.Revision, &r.ImageBase64); err != nil {
			return nil, err
		}
		if idx.Valid {
			v := idx.Float64
			r.SeriesIndex = &v
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if includeImages {
		if len(out) != len(selected) {
			return nil, httpapi.NewError(http.StatusConflict, "Series references changed or are no longer accessible. Reload them before generating.")
		}
		revByID := make(map[string]string, len(out))
		for _, r := range out {
			revByID[r.BookID] = r.Revision
		}
		for _, sel := range selected {
			if rev, ok := revByID[sel.BookID]; !ok || rev != sel.Revision {
				return nil, httpapi.NewError(http.StatusConflict, "Series references changed or are no longer accessible. Reload them before generating.")
			}
		}
	}

	return out, nil
}
