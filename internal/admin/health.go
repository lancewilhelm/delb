package admin

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

type healthStatus string

const (
	healthOK    healthStatus = "ok"
	healthWarn  healthStatus = "warn"
	healthError healthStatus = "error"
)

type healthCheckResult struct {
	ID       string           `json:"id"`
	Name     string           `json:"name"`
	Status   healthStatus     `json:"status"`
	Message  string           `json:"message"`
	HowToFix string           `json:"howToFix,omitempty"`
	Meta     map[string]any   `json:"meta,omitempty"`
	Sample   []map[string]any `json:"sample,omitempty"`
}

var healthCoverCandidates = []string{
	"cover.jpg",
	"cover.jpeg",
	"cover.png",
	"cover.webp",
	"cover.gif",
	"cover.svg",
	"cover.avif",
	"cover.tif",
	"cover.tiff",
	"cover.source.jpg",
	"cover.source.jpeg",
	"cover.source.png",
	"cover.source.webp",
	"source.jpg",
	"source.jpeg",
	"source.png",
	"source.webp",
}

func worstHealthStatus(a, b healthStatus) healthStatus {
	rank := map[healthStatus]int{healthOK: 0, healthWarn: 1, healthError: 2}
	if rank[a] >= rank[b] {
		return a
	}
	return b
}

func normalizeIntParam(raw json.RawMessage, fallback, minVal, maxVal int) int {
	if len(raw) == 0 {
		return clampInt(fallback, minVal, maxVal)
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return clampInt(fallback, minVal, maxVal)
	}
	var num float64
	if err := json.Unmarshal(raw, &num); err == nil {
		if !math.IsNaN(num) && !math.IsInf(num, 0) {
			return clampInt(int(math.Floor(num)), minVal, maxVal)
		}
		return clampInt(fallback, minVal, maxVal)
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		s = strings.TrimSpace(s)
		if s == "" {
			return clampInt(0, minVal, maxVal)
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return clampInt(int(math.Floor(f)), minVal, maxVal)
		}
	}
	return clampInt(fallback, minVal, maxVal)
}

func clampInt(v, minVal, maxVal int) int {
	if v < minVal {
		return minVal
	}
	if v > maxVal {
		return maxVal
	}
	return v
}

func dirnamePosix(posixPath string) string {
	rawParts := strings.Split(posixPath, "/")
	parts := make([]string, 0, len(rawParts))
	for _, p := range rawParts {
		if p != "" {
			parts = append(parts, p)
		}
	}
	if len(parts) <= 1 {
		return ""
	}
	return strings.Join(parts[:len(parts)-1], "/")
}

func existsFile(absPath string) bool {
	st, err := os.Stat(absPath)
	return err == nil && st.Mode().IsRegular()
}

func existsDir(absPath string) bool {
	st, err := os.Stat(absPath)
	return err == nil && st.IsDir()
}

func makePlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

// POST /api/settings/admin/health
func (s *Service) handleAdminHealth(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdminOrOwner(w, r); !ok {
		return
	}

	var body struct {
		Mode                json.RawMessage `json:"mode"`
		SampleLimit         json.RawMessage `json:"sampleLimit"`
		MaxFilesToStat      json.RawMessage `json:"maxFilesToStat"`
		MaxDirsToStat       json.RawMessage `json:"maxDirsToStat"`
		MaxBooksForFuzzy    json.RawMessage `json:"maxBooksForFuzzy"`
		MaxFuzzyComparisons json.RawMessage `json:"maxFuzzyComparisons"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	mode := "quick"
	var modeStr string
	if len(body.Mode) > 0 && json.Unmarshal(body.Mode, &modeStr) == nil {
		if strings.EqualFold(strings.TrimSpace(modeStr), "deep") {
			mode = "deep"
		}
	}

	sampleLimit := normalizeIntParam(body.SampleLimit, 20, 0, 100)
	maxFilesToStat := normalizeIntParam(body.MaxFilesToStat, 5000, 0, 50_000)
	maxDirsToStat := normalizeIntParam(body.MaxDirsToStat, 5000, 0, 50_000)
	maxBooksForFuzzy := normalizeIntParam(body.MaxBooksForFuzzy, 3000, 0, 20_000)
	maxFuzzyComparisons := normalizeIntParam(body.MaxFuzzyComparisons, 150_000, 0, 2_000_000)

	startTime := time.Now().UTC()
	startedAt := startTime.Format(iso8601Millis)
	s.logger.InfoContext(r.Context(), "starting library health check", "mode", mode)
	ctx := r.Context()
	results := make([]healthCheckResult, 0, 11)

	// 1) Orphaned books (no collection link)
	{
		var orphanCount int
		if err := s.db.QueryRowContext(ctx, `
			SELECT COUNT(*)
			FROM books b
			LEFT JOIN collection_books cb ON cb.book_id = b.id
			WHERE cb.book_id IS NULL
		`).Scan(&orphanCount); err != nil {
			s.writeErr(w, "POST /api/settings/admin/health orphaned count failed", err)
			return
		}
		sample := make([]map[string]any, 0)
		if sampleLimit > 0 && orphanCount > 0 {
			rows, err := s.db.QueryContext(ctx, `
				SELECT b.id, b.title
				FROM books b
				LEFT JOIN collection_books cb ON cb.book_id = b.id
				WHERE cb.book_id IS NULL
				LIMIT ?
			`, sampleLimit)
			if err != nil {
				s.writeErr(w, "POST /api/settings/admin/health orphaned sample failed", err)
				return
			}
			for rows.Next() {
				var id, title string
				if err := rows.Scan(&id, &title); err != nil {
					_ = rows.Close()
					s.writeErr(w, "POST /api/settings/admin/health orphaned scan failed", err)
					return
				}
				sample = append(sample, map[string]any{"id": id, "title": title})
			}
			_ = rows.Close()
		}
		check := healthCheckResult{
			ID:      "books.orphaned",
			Name:    "Orphaned books (no collection)",
			Status:  healthOK,
			Message: "All books are linked to exactly one collection",
			Meta:    map[string]any{"orphanCount": orphanCount},
			Sample:  sample,
		}
		if orphanCount > 0 {
			check.Status = healthWarn
			check.Message = fmt.Sprintf("%d book(s) are not in any collection", orphanCount)
			check.HowToFix = "Restore a valid collection assignment from a matching backup and inspect the collection migration report."
		}
		results = append(results, check)
	}

	// 2) Empty titles
	{
		var emptyCount int
		if err := s.db.QueryRowContext(ctx, `
			SELECT COUNT(*) FROM books WHERE TRIM(title) = ''
		`).Scan(&emptyCount); err != nil {
			s.writeErr(w, "POST /api/settings/admin/health empty-title count failed", err)
			return
		}
		sample := make([]map[string]any, 0)
		if sampleLimit > 0 && emptyCount > 0 {
			rows, err := s.db.QueryContext(ctx, `
				SELECT id FROM books WHERE TRIM(title) = '' LIMIT ?
			`, sampleLimit)
			if err != nil {
				s.writeErr(w, "POST /api/settings/admin/health empty-title sample failed", err)
				return
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					_ = rows.Close()
					s.writeErr(w, "POST /api/settings/admin/health empty-title scan failed", err)
					return
				}
				sample = append(sample, map[string]any{"id": id})
			}
			_ = rows.Close()
		}
		check := healthCheckResult{
			ID:      "books.empty-title",
			Name:    "Empty book titles",
			Status:  healthOK,
			Message: "No books with empty titles found",
			Meta:    map[string]any{"emptyCount": emptyCount},
			Sample:  sample,
		}
		if emptyCount > 0 {
			check.Status = healthError
			check.Message = fmt.Sprintf("%d book(s) have an empty title", emptyCount)
			check.HowToFix = "Edit the book title (or delete the record if it is junk)."
		}
		results = append(results, check)
	}

	// 3) Duplicate identifiers across books
	{
		rows, err := s.db.QueryContext(ctx, `
			SELECT type, value, COUNT(DISTINCT book_id) AS book_count
			FROM book_identifiers
			GROUP BY type, value
		`)
		if err != nil {
			s.writeErr(w, "POST /api/settings/admin/health identifiers.duplicates failed", err)
			return
		}
		type dupRow struct {
			typ       string
			val       string
			bookCount int
		}
		var dupRows []dupRow
		for rows.Next() {
			var r dupRow
			if err := rows.Scan(&r.typ, &r.val, &r.bookCount); err != nil {
				_ = rows.Close()
				s.writeErr(w, "POST /api/settings/admin/health identifiers scan failed", err)
				return
			}
			if r.bookCount > 1 {
				dupRows = append(dupRows, r)
			}
		}
		_ = rows.Close()

		duplicateGroupCount := len(dupRows)
		sample := make([]map[string]any, 0)
		limit := duplicateGroupCount
		if limit > sampleLimit {
			limit = sampleLimit
		}
		for i := 0; i < limit; i++ {
			sample = append(sample, map[string]any{
				"type":      dupRows[i].typ,
				"value":     dupRows[i].val,
				"bookCount": dupRows[i].bookCount,
			})
		}
		check := healthCheckResult{
			ID:      "identifiers.duplicates",
			Name:    "Duplicate identifiers (type/value)",
			Status:  healthOK,
			Message: "No duplicate identifiers found",
			Meta:    map[string]any{"duplicateGroupCount": duplicateGroupCount},
			Sample:  sample,
		}
		if duplicateGroupCount > 0 {
			check.Status = healthWarn
			check.Message = fmt.Sprintf("%d identifier value(s) are used by multiple books", duplicateGroupCount)
			check.HowToFix = "Review the referenced books. Independent entries are valid; correct identifiers only when they are wrong."
		}
		results = append(results, check)
	}

	// 4) Collection health checks (mirrors server/utils/collections/health.ts)
	colChecks, err := s.runCollectionHealth(ctx, sampleLimit)
	if err != nil {
		s.writeErr(w, "POST /api/settings/admin/health collectionHealth failed", err)
		return
	}
	results = append(results, colChecks...)

	if mode == "deep" {
		deepChecks, err := s.runDeepHealthChecks(ctx, sampleLimit, maxFilesToStat, maxDirsToStat, maxBooksForFuzzy, maxFuzzyComparisons)
		if err != nil {
			s.writeErr(w, "POST /api/settings/admin/health deep checks failed", err)
			return
		}
		results = append(results, deepChecks...)
	}

	finishedAt := time.Now().UTC().Format(iso8601Millis)
	overall := healthOK
	for _, r := range results {
		overall = worstHealthStatus(overall, r.Status)
	}

	s.logger.InfoContext(r.Context(), "completed library health check",
		"mode", mode,
		"overall", string(overall),
		"checks", len(results),
		"durationMs", time.Since(startTime).Milliseconds(),
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"mode":       mode,
			"startedAt":  startedAt,
			"finishedAt": finishedAt,
			"overall":    overall,
			"results":    results,
		},
	})
}

func (s *Service) runCollectionHealth(ctx context.Context, sampleLimit int) ([]healthCheckResult, error) {
	var defaultCount int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM collections WHERE is_default = 1`).Scan(&defaultCount); err != nil {
		return nil, err
	}

	ownerRows, err := s.db.QueryContext(ctx, `
		SELECT c.id, c.name
		FROM collections c
		WHERE (SELECT count(*) FROM collection_members cm WHERE cm.collection_id = c.id AND cm.role = 'owner') != 1
		   OR NOT EXISTS(SELECT 1 FROM collection_members cm WHERE cm.collection_id = c.id AND cm.user_id = c.owner_user_id AND cm.role = 'owner')
	`)
	if err != nil {
		return nil, err
	}
	owners := make([]map[string]any, 0)
	for ownerRows.Next() {
		var id, name string
		if err := ownerRows.Scan(&id, &name); err != nil {
			_ = ownerRows.Close()
			return nil, err
		}
		owners = append(owners, map[string]any{"id": id, "name": name})
	}
	_ = ownerRows.Close()

	invalidRows, err := s.db.QueryContext(ctx, `
		SELECT b.id, b.title, b.collection_id
		FROM books b
		LEFT JOIN collections c ON c.id = b.collection_id
		WHERE b.collection_id IS NULL OR c.id IS NULL
		ORDER BY b.id
	`)
	if err != nil {
		return nil, err
	}
	invalidBooks := make([]map[string]any, 0)
	for invalidRows.Next() {
		var (
			id    string
			title string
			cid   sql.NullString
		)
		if err := invalidRows.Scan(&id, &title, &cid); err != nil {
			_ = invalidRows.Close()
			return nil, err
		}
		var cidVal any
		if cid.Valid {
			cidVal = cid.String
		}
		invalidBooks = append(invalidBooks, map[string]any{
			"id":           id,
			"title":        title,
			"collectionId": cidVal,
		})
	}
	_ = invalidRows.Close()

	groupRows, err := s.db.QueryContext(ctx, `
		SELECT lower(trim(title)) AS title, count(*) AS n
		FROM books
		GROUP BY lower(trim(title))
		HAVING count(DISTINCT collection_id) > 1
		ORDER BY lower(trim(title))
	`)
	if err != nil {
		return nil, err
	}
	type titleGroup struct {
		title string
		n     int
	}
	var groups []titleGroup
	for groupRows.Next() {
		var g titleGroup
		if err := groupRows.Scan(&g.title, &g.n); err != nil {
			_ = groupRows.Close()
			return nil, err
		}
		groups = append(groups, g)
	}
	_ = groupRows.Close()

	samples := make([]map[string]any, 0)
	groupSampleCount := len(groups)
	if groupSampleCount > sampleLimit {
		groupSampleCount = sampleLimit
	}
	for i := 0; i < groupSampleCount; i++ {
		g := groups[i]
		mRows, err := s.db.QueryContext(ctx, `
			SELECT b.id, b.title, b.collection_id, c.name
			FROM books b
			JOIN collections c ON c.id = b.collection_id
			WHERE lower(trim(b.title)) = ?
			ORDER BY b.id
			LIMIT ?
		`, g.title, sampleLimit)
		if err != nil {
			return nil, err
		}
		matches := make([]map[string]any, 0)
		for mRows.Next() {
			var id, title, cid, cname string
			if err := mRows.Scan(&id, &title, &cid, &cname); err != nil {
				_ = mRows.Close()
				return nil, err
			}
			matches = append(matches, map[string]any{
				"id":             id,
				"title":          title,
				"collectionId":   cid,
				"collectionName": cname,
			})
		}
		_ = mRows.Close()
		samples = append(samples, map[string]any{
			"title":     g.title,
			"bookCount": g.n,
			"matches":   matches,
			"sampled":   len(matches) < g.n,
		})
	}

	defaultCheck := healthCheckResult{
		ID:      "collections.default",
		Name:    "Shared default collection",
		Status:  healthError,
		Message: "Exactly one default collection is required",
		Meta:    map[string]any{"defaultCount": defaultCount},
	}
	if defaultCount == 1 {
		defaultCheck.Status = healthOK
		defaultCheck.Message = "One default collection is configured"
	}

	ownerSample := owners
	if len(ownerSample) > sampleLimit {
		ownerSample = ownerSample[:sampleLimit]
	}
	ownersCheck := healthCheckResult{
		ID:      "collections.owners",
		Name:    "Required collection owners",
		Status:  healthOK,
		Message: "Every collection has one matching owner",
		Sample:  ownerSample,
	}
	if len(owners) > 0 {
		ownersCheck.Status = healthError
		ownersCheck.Message = fmt.Sprintf("%d collection(s) have inconsistent ownership", len(owners))
	}

	invalidSample := invalidBooks
	if len(invalidSample) > sampleLimit {
		invalidSample = invalidSample[:sampleLimit]
	}
	membershipCheck := healthCheckResult{
		ID:      "collections.membership",
		Name:    "Exclusive book collections",
		Status:  healthOK,
		Message: "Every book belongs to one existing collection",
		Meta:    map[string]any{"invalidBookCount": len(invalidBooks)},
		Sample:  invalidSample,
	}
	if len(invalidBooks) > 0 {
		membershipCheck.Status = healthError
		membershipCheck.Message = fmt.Sprintf("%d book(s) have no valid collection", len(invalidBooks))
		membershipCheck.HowToFix = "Review the affected entries and restore the matching migration backup or repair their destination before resuming imports."
	}

	crossCheck := healthCheckResult{
		ID:      "duplicates.cross-collection-titles",
		Name:    "Matching titles across collections",
		Status:  healthOK,
		Message: "No identical titles found across collections",
		Meta: map[string]any{
			"duplicateGroupCount": len(groups),
			"sampled":             len(groups) > sampleLimit,
			"complete":            true,
		},
		Sample: samples,
	}
	if len(groups) > 0 {
		crossCheck.Status = healthWarn
		crossCheck.Message = fmt.Sprintf("%d matching title group(s) across collections. Independent entries are allowed.", len(groups))
		crossCheck.HowToFix = "Review the matching entries. Different editions and independent copies are valid. No automatic merge or deletion is performed."
	}

	return []healthCheckResult{defaultCheck, ownersCheck, membershipCheck, crossCheck}, nil
}

func (s *Service) runDeepHealthChecks(
	ctx context.Context,
	sampleLimit, maxFilesToStat, maxDirsToStat, maxBooksForFuzzy, maxFuzzyComparisons int,
) ([]healthCheckResult, error) {
	out := make([]healthCheckResult, 0, 4)

	// 4.5) Possible duplicates (fuzzy title/author)
	{
		type bookRow struct {
			id              string
			title           string
			coverImagePath  *string
			createdAt       string
			createdByUserID *string
		}
		var bookRows []bookRow
		if maxBooksForFuzzy > 0 {
			rows, err := s.db.QueryContext(ctx, `
				SELECT id, title, cover_image_path, created_at, created_by_user_id
				FROM books
				ORDER BY id
				LIMIT ?
			`, maxBooksForFuzzy)
			if err != nil {
				return nil, err
			}
			for rows.Next() {
				var (
					id, title  string
					cover      sql.NullString
					createdSec int64
					createdBy  sql.NullString
				)
				if err := rows.Scan(&id, &title, &cover, &createdSec, &createdBy); err != nil {
					_ = rows.Close()
					return nil, err
				}
				var coverPtr, createdByPtr *string
				if cover.Valid {
					v := cover.String
					coverPtr = &v
				}
				if createdBy.Valid {
					v := createdBy.String
					createdByPtr = &v
				}
				bookRows = append(bookRows, bookRow{
					id:              id,
					title:           title,
					coverImagePath:  coverPtr,
					createdAt:       time.Unix(createdSec, 0).UTC().Format(iso8601Millis),
					createdByUserID: createdByPtr,
				})
			}
			_ = rows.Close()
		}

		authorNamesByBookID := make(map[string][]string, len(bookRows))
		if len(bookRows) > 0 {
			for i := 0; i < len(bookRows); i += 400 {
				end := i + 400
				if end > len(bookRows) {
					end = len(bookRows)
				}
				args := make([]any, 0, end-i)
				for _, b := range bookRows[i:end] {
					args = append(args, b.id)
				}
				aRows, err := s.db.QueryContext(ctx, `
					SELECT ba.book_id, a.name
					FROM book_authors ba
					INNER JOIN authors a ON a.id = ba.author_id
					WHERE ba.book_id IN (`+makePlaceholders(len(args))+`)
					ORDER BY COALESCE(ba.position, 999) ASC, a.name ASC
				`, args...)
				if err != nil {
					return nil, err
				}
				for aRows.Next() {
					var bid, name string
					if err := aRows.Scan(&bid, &name); err != nil {
						_ = aRows.Close()
						return nil, err
					}
					authorNamesByBookID[bid] = append(authorNamesByBookID[bid], name)
				}
				_ = aRows.Close()
			}
		}

		type sig struct {
			bookRow
			authorNames  []string
			titleTokens  []string
			authorTokens []string
			seed         string
		}
		seedOrder := make([]string, 0)
		bySeed := make(map[string][]sig)
		for _, b := range bookRows {
			aNames := authorNamesByBookID[b.id]
			if aNames == nil {
				aNames = []string{}
			}
			tt := books.FuzzyTokens(b.title)
			at := books.FuzzyTokens(strings.Join(aNames, " "))
			seed := books.FuzzySeedToken(tt)
			if seed == "" {
				continue
			}
			if _, exists := bySeed[seed]; !exists {
				seedOrder = append(seedOrder, seed)
			}
			bySeed[seed] = append(bySeed[seed], sig{
				bookRow:      b,
				authorNames:  aNames,
				titleTokens:  tt,
				authorTokens: at,
				seed:         seed,
			})
		}

		comparisons := 0
		foundPairs := 0
		samplePairs := make([]map[string]any, 0)
		seenPairKey := make(map[string]struct{})
		sampleIDSet := make(map[string]struct{})

		for _, seed := range seedOrder {
			if comparisons >= maxFuzzyComparisons {
				break
			}
			bucket := bySeed[seed]
			if len(bucket) < 2 {
				continue
			}
			for i := 0; i < len(bucket); i++ {
				if comparisons >= maxFuzzyComparisons {
					break
				}
				a := bucket[i]
				for j := i + 1; j < len(bucket); j++ {
					if comparisons >= maxFuzzyComparisons {
						break
					}
					b := bucket[j]
					comparisons++
					score := books.FuzzyTitleAuthorScore(a.titleTokens, a.authorTokens, b.titleTokens, b.authorTokens)
					if score < books.FuzzyDuplicateThreshold {
						continue
					}
					first, second := a, b
					if b.id < a.id {
						first, second = b, a
					}
					key := first.id + "|" + second.id
					if _, seen := seenPairKey[key]; seen {
						continue
					}
					seenPairKey[key] = struct{}{}
					foundPairs++
					if len(samplePairs) < sampleLimit {
						sampleIDSet[first.id] = struct{}{}
						sampleIDSet[second.id] = struct{}{}
						samplePairs = append(samplePairs, map[string]any{
							"score": score,
							"a": map[string]any{
								"id":             first.id,
								"title":          first.title,
								"authorNames":    first.authorNames,
								"coverImagePath": first.coverImagePath,
								"createdAt":      first.createdAt,
								"ownerUserId":    first.createdByUserID,
							},
							"b": map[string]any{
								"id":             second.id,
								"title":          second.title,
								"authorNames":    second.authorNames,
								"coverImagePath": second.coverImagePath,
								"createdAt":      second.createdAt,
								"ownerUserId":    second.createdByUserID,
							},
						})
					}
				}
			}
		}

		if len(sampleIDSet) > 0 {
			args := make([]any, 0, len(sampleIDSet))
			for id := range sampleIDSet {
				args = append(args, id)
			}
			ph := makePlaceholders(len(args))

			ownerByBookID := make(map[string]map[string]any)
			oRows, err := s.db.QueryContext(ctx, `
				SELECT b.id, b.created_by_user_id, u.name, u.email
				FROM books b
				LEFT JOIN users u ON u.id = b.created_by_user_id
				WHERE b.id IN (`+ph+`)
			`, args...)
			if err != nil {
				return nil, err
			}
			for oRows.Next() {
				var bid string
				var uid, uname, uemail sql.NullString
				if err := oRows.Scan(&bid, &uid, &uname, &uemail); err != nil {
					_ = oRows.Close()
					return nil, err
				}
				ownerByBookID[bid] = map[string]any{
					"userId": nullStrVal(uid),
					"name":   nullStrVal(uname),
					"email":  nullStrVal(uemail),
				}
			}
			_ = oRows.Close()

			colsByBookID := make(map[string][]map[string]any)
			cRows, err := s.db.QueryContext(ctx, `
				SELECT cb.book_id, c.id, c.name, c.is_personal
				FROM collection_books cb
				INNER JOIN collections c ON c.id = cb.collection_id
				WHERE cb.book_id IN (`+ph+`)
			`, args...)
			if err != nil {
				return nil, err
			}
			for cRows.Next() {
				var bid, cid, cname string
				var isPersonal int
				if err := cRows.Scan(&bid, &cid, &cname, &isPersonal); err != nil {
					_ = cRows.Close()
					return nil, err
				}
				colsByBookID[bid] = append(colsByBookID[bid], map[string]any{
					"id":         cid,
					"name":       cname,
					"isPersonal": isPersonal != 0,
				})
			}
			_ = cRows.Close()

			for _, p := range samplePairs {
				for _, side := range []string{"a", "b"} {
					m := p[side].(map[string]any)
					id := m["id"].(string)
					if owner, ok := ownerByBookID[id]; ok {
						m["owner"] = owner
					} else {
						m["owner"] = nil
					}
					if cols, ok := colsByBookID[id]; ok {
						m["collections"] = cols
					} else {
						m["collections"] = []map[string]any{}
					}
				}
			}
		}

		var totalBooks int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM books`).Scan(&totalBooks); err != nil {
			return nil, err
		}
		incomplete := len(bookRows) < totalBooks || comparisons >= maxFuzzyComparisons
		check := healthCheckResult{
			ID:      "duplicates.fuzzy-title-author",
			Name:    "Possible duplicates (fuzzy title/author)",
			Status:  healthOK,
			Message: "No fuzzy title/author duplicates found",
			Meta: map[string]any{
				"scannedBooks":        len(bookRows),
				"totalBooks":          totalBooks,
				"incomplete":          incomplete,
				"comparisons":         comparisons,
				"threshold":           books.FuzzyDuplicateThreshold,
				"maxBooksForFuzzy":    maxBooksForFuzzy,
				"maxFuzzyComparisons": maxFuzzyComparisons,
			},
			Sample: samplePairs,
		}
		if foundPairs > 0 || incomplete {
			check.Status = healthWarn
		}
		if foundPairs > 0 {
			suffix := ""
			if incomplete {
				suffix = " (incomplete scan)"
			}
			check.Message = fmt.Sprintf("%d possible duplicate pair(s) found by fuzzy match%s", foundPairs, suffix)
			check.HowToFix = "Review each pair. Independent copies and different editions are valid; no automatic repair is performed."
		} else if incomplete {
			check.Message = "No matches in the inspected subset. The fuzzy scan is incomplete."
		}
		out = append(out, check)
	}

	// 5) Book file pointers exist on disk
	{
		rows, err := s.db.QueryContext(ctx, `
			SELECT id, book_id, format, relative_path FROM book_files LIMIT ?
		`, maxFilesToStat)
		if err != nil {
			return nil, err
		}
		checked := 0
		missing := 0
		sampleMissing := make([]map[string]any, 0)
		for rows.Next() {
			var id, bookID, format, rel string
			if err := rows.Scan(&id, &bookID, &format, &rel); err != nil {
				_ = rows.Close()
				return nil, err
			}
			checked++
			trimmed := strings.TrimSpace(rel)
			if trimmed == "" {
				continue
			}
			abs, err := storage.ResolveUnderLibrary(s.libraryDir, trimmed)
			if err != nil {
				missing++
				if len(sampleMissing) < sampleLimit {
					sampleMissing = append(sampleMissing, map[string]any{
						"id":           id,
						"bookId":       bookID,
						"relativePath": rel,
						"reason":       "invalid-path",
					})
				}
				continue
			}
			if !existsFile(abs) {
				missing++
				if len(sampleMissing) < sampleLimit {
					sampleMissing = append(sampleMissing, map[string]any{
						"id":           id,
						"bookId":       bookID,
						"relativePath": rel,
					})
				}
			}
		}
		_ = rows.Close()

		check := healthCheckResult{
			ID:      "book-files.missing-on-disk",
			Name:    "Book files missing on disk",
			Status:  healthOK,
			Message: "All checked book file pointers exist on disk",
			Meta:    map[string]any{"checked": checked, "missing": missing, "maxFilesToStat": maxFilesToStat},
			Sample:  sampleMissing,
		}
		if missing > 0 {
			check.Status = healthError
			check.Message = fmt.Sprintf("%d book file pointer(s) do not exist on disk", missing)
			check.HowToFix = "Restore missing files under library/, update the stored relative path, or remove the broken book_files row."
		}
		out = append(out, check)
	}

	// 6) cover_image_path exists on disk (when set)
	{
		rows, err := s.db.QueryContext(ctx, `
			SELECT id, cover_image_path
			FROM books
			WHERE cover_image_path IS NOT NULL AND TRIM(cover_image_path) <> ''
			LIMIT ?
		`, maxFilesToStat)
		if err != nil {
			return nil, err
		}
		checked := 0
		missing := 0
		sampleMissing := make([]map[string]any, 0)
		for rows.Next() {
			var id, cover string
			if err := rows.Scan(&id, &cover); err != nil {
				_ = rows.Close()
				return nil, err
			}
			checked++
			trimmed := strings.TrimSpace(cover)
			if trimmed == "" {
				continue
			}
			abs, err := storage.ResolveUnderLibrary(s.libraryDir, trimmed)
			if err != nil {
				missing++
				if len(sampleMissing) < sampleLimit {
					sampleMissing = append(sampleMissing, map[string]any{
						"bookId":         id,
						"coverImagePath": cover,
						"reason":         "invalid-path",
					})
				}
				continue
			}
			if !existsFile(abs) {
				missing++
				if len(sampleMissing) < sampleLimit {
					sampleMissing = append(sampleMissing, map[string]any{
						"bookId":         id,
						"coverImagePath": cover,
					})
				}
			}
		}
		_ = rows.Close()

		check := healthCheckResult{
			ID:      "covers.cover-image-path-missing-on-disk",
			Name:    "Cover image path missing on disk",
			Status:  healthOK,
			Message: "All checked cover_image_path files exist on disk",
			Meta:    map[string]any{"checked": checked, "missing": missing, "maxFilesToStat": maxFilesToStat},
			Sample:  sampleMissing,
		}
		if missing > 0 {
			check.Status = healthWarn
			check.Message = fmt.Sprintf("%d book(s) have cover_image_path set but the file is missing", missing)
			check.HowToFix = "Regenerate the thumbnail/cover file for the book, or clear cover_image_path if no cover should be shown."
		}
		out = append(out, check)
	}

	// 7) If cover exists, thumb.webp should exist
	{
		dirSet := make(map[string]struct{})
		dirOrder := make([]string, 0)
		addDir := func(rel string) {
			trimmed := strings.TrimSpace(rel)
			if trimmed == "" {
				return
			}
			d := dirnamePosix(trimmed)
			if d == "" {
				return
			}
			if _, ok := dirSet[d]; !ok {
				dirSet[d] = struct{}{}
				dirOrder = append(dirOrder, d)
			}
		}

		fRows, err := s.db.QueryContext(ctx, `SELECT relative_path FROM book_files LIMIT ?`, maxDirsToStat)
		if err != nil {
			return nil, err
		}
		for fRows.Next() {
			var rel sql.NullString
			if err := fRows.Scan(&rel); err != nil {
				_ = fRows.Close()
				return nil, err
			}
			if rel.Valid {
				addDir(rel.String)
			}
		}
		_ = fRows.Close()

		cRows, err := s.db.QueryContext(ctx, `
			SELECT cover_image_path
			FROM books
			WHERE cover_image_path IS NOT NULL AND TRIM(cover_image_path) <> ''
			LIMIT ?
		`, maxDirsToStat)
		if err != nil {
			return nil, err
		}
		for cRows.Next() {
			var rel sql.NullString
			if err := cRows.Scan(&rel); err != nil {
				_ = cRows.Close()
				return nil, err
			}
			if rel.Valid {
				addDir(rel.String)
			}
		}
		_ = cRows.Close()

		if len(dirOrder) > maxDirsToStat {
			dirOrder = dirOrder[:maxDirsToStat]
		}

		coverDirs := 0
		missingThumb := 0
		sampleMissing := make([]map[string]any, 0)

		for _, dirRelPosix := range dirOrder {
			probeAbs, err := storage.ResolveUnderLibrary(s.libraryDir, dirRelPosix+"/x")
			if err != nil {
				continue
			}
			dirAbs := filepath.Dir(probeAbs)
			if !existsDir(dirAbs) {
				continue
			}
			if existsFile(filepath.Join(dirAbs, "thumb.webp")) {
				continue
			}
			foundCover := false
			for _, name := range healthCoverCandidates {
				if existsFile(filepath.Join(dirAbs, name)) {
					foundCover = true
					break
				}
			}
			if !foundCover {
				continue
			}
			coverDirs++
			missingThumb++
			if len(sampleMissing) < sampleLimit {
				trimmed := strings.TrimPrefix(strings.TrimPrefix(dirRelPosix, "library/"), "library\\")
				sampleMissing = append(sampleMissing, map[string]any{
					"dir": "library/" + trimmed,
				})
			}
		}

		check := healthCheckResult{
			ID:      "covers.missing-thumb-when-cover-exists",
			Name:    "Missing thumb.webp when a cover exists",
			Status:  healthOK,
			Message: "No missing thumbnails found in referenced book folders",
			Meta: map[string]any{
				"checkedDirs":   len(dirOrder),
				"coverDirs":     coverDirs,
				"missingThumb":  missingThumb,
				"maxDirsToStat": maxDirsToStat,
			},
			Sample: sampleMissing,
		}
		if missingThumb > 0 {
			check.Status = healthWarn
			check.Message = fmt.Sprintf("%d book folder(s) have a cover but no thumb.webp", missingThumb)
			check.HowToFix = "Regenerate the thumbnail (thumb.webp) for each affected folder."
		}
		out = append(out, check)
	}

	return out, nil
}

func nullStrVal(v sql.NullString) any {
	if !v.Valid {
		return nil
	}
	return v.String
}
