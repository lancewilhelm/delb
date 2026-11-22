package books

import (
	"context"
	"database/sql"
	"regexp"
	"sort"
	"strings"
)

const FuzzyDuplicateThreshold = 0.82
const fuzzyDuplicateThreshold = FuzzyDuplicateThreshold

var (
	nonISBNRe     = regexp.MustCompile(`[^0-9xX]`)
	apostropheRe  = regexp.MustCompile(`['’]`)
	nonAlnumSpRe  = regexp.MustCompile(`[^a-z0-9\s]`)
	dupStopWords  = map[string]struct{}{"the": {}, "a": {}, "an": {}, "and": {}, "of": {}, "to": {}}
)

type IdentifierInput struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}

type DuplicateCandidateBook struct {
	ID             string            `json:"id"`
	CollectionID   string            `json:"collectionId"`
	Title          string            `json:"title"`
	CoverImagePath *string           `json:"coverImagePath"`
	UpdatedAt      *string           `json:"updatedAt"`
	AuthorNames    []string          `json:"authorNames"`
	Identifiers    []IdentifierInput `json:"identifiers"`
}

type DuplicateCandidate struct {
	MatchType string                 `json:"matchType"`
	Score     float64                `json:"score"`
	Book      DuplicateCandidateBook `json:"book"`
}

func normalizeDuplicateIdentifierValue(identType, value string) string {
	t := strings.ToLower(strings.TrimSpace(identType))
	v := strings.TrimSpace(value)
	if v == "" {
		return ""
	}
	switch t {
	case "isbn", "isbn10", "isbn13", "isbn_10", "isbn_13":
		return strings.ToUpper(nonISBNRe.ReplaceAllString(v, ""))
	default:
		return strings.ToLower(v)
	}
}

func FuzzyTokens(input string) []string {
	s := strings.ToLower(normalizeSpaces(input))
	s = apostropheRe.ReplaceAllString(s, "")
	s = nonAlnumSpRe.ReplaceAllString(s, " ")
	parts := strings.Fields(s)
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if len(p) < 2 {
			continue
		}
		if _, stop := dupStopWords[p]; stop {
			continue
		}
		out = append(out, p)
	}
	return out
}

func FuzzySeedToken(titleTokens []string) string {
	for _, t := range titleTokens {
		if len(t) >= 3 {
			return t
		}
	}
	if len(titleTokens) > 0 {
		return titleTokens[0]
	}
	return ""
}

func jaccardScore(a, b []string) float64 {
	sa := make(map[string]struct{}, len(a))
	for _, x := range a {
		sa[x] = struct{}{}
	}
	sb := make(map[string]struct{}, len(b))
	for _, x := range b {
		sb[x] = struct{}{}
	}
	if len(sa) == 0 && len(sb) == 0 {
		return 1
	}
	if len(sa) == 0 || len(sb) == 0 {
		return 0
	}
	inter := 0
	for k := range sa {
		if _, ok := sb[k]; ok {
			inter++
		}
	}
	union := len(sa) + len(sb) - inter
	if union <= 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

func FuzzyTitleAuthorScore(titleA, authorA, titleB, authorB []string) float64 {
	ts := jaccardScore(titleA, titleB)
	as := jaccardScore(authorA, authorB)
	score := 0.75*ts + 0.25*as
	if score < 0 {
		return 0
	}
	if score > 1 {
		return 1
	}
	return score
}

func loadBooksForCandidates(ctx context.Context, db *sql.DB, bookIDs []string) (map[string]DuplicateCandidateBook, error) {
	ids := dedupeStrings(bookIDs)
	out := make(map[string]DuplicateCandidateBook, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	ph := makePlaceholders(len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}

	bRows, err := db.QueryContext(ctx, `
		SELECT id, collection_id, title, cover_image_path, updated_at
		FROM books
		WHERE id IN (`+ph+`)
	`, args...)
	if err != nil {
		return nil, err
	}
	for bRows.Next() {
		var (
			id, cid, title string
			cover          sql.NullString
			updatedAt      sql.NullInt64
		)
		if err := bRows.Scan(&id, &cid, &title, &cover, &updatedAt); err != nil {
			_ = bRows.Close()
			return nil, err
		}
		out[id] = DuplicateCandidateBook{
			ID:             id,
			CollectionID:   cid,
			Title:          title,
			CoverImagePath: nullStringPtr(cover),
			UpdatedAt:      formatNullUnixSecISO(updatedAt),
			AuthorNames:    make([]string, 0),
			Identifiers:    make([]IdentifierInput, 0),
		}
	}
	if err := bRows.Close(); err != nil {
		return nil, err
	}

	aRows, err := db.QueryContext(ctx, `
		SELECT ba.book_id, a.name
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		WHERE ba.book_id IN (`+ph+`)
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
		if b, ok := out[bid]; ok {
			b.AuthorNames = append(b.AuthorNames, name)
			out[bid] = b
		}
	}
	if err := aRows.Close(); err != nil {
		return nil, err
	}

	iRows, err := db.QueryContext(ctx, `
		SELECT book_id, type, value
		FROM book_identifiers
		WHERE book_id IN (`+ph+`)
		ORDER BY type ASC, value ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	for iRows.Next() {
		var bid, typ, val string
		if err := iRows.Scan(&bid, &typ, &val); err != nil {
			_ = iRows.Close()
			return nil, err
		}
		if b, ok := out[bid]; ok {
			b.Identifiers = append(b.Identifiers, IdentifierInput{Type: typ, Value: val})
			out[bid] = b
		}
	}
	if err := iRows.Close(); err != nil {
		return nil, err
	}

	return out, nil
}

// FindPossibleDuplicates mirrors server/utils/books/duplicates.ts findPossibleDuplicates.
func FindPossibleDuplicates(ctx context.Context, db *sql.DB, userID, title, author string, identifiers []IdentifierInput, maxCandidates int) ([]DuplicateCandidate, error) {
	if userID == "" {
		return nil, nil
	}
	if maxCandidates < 1 {
		maxCandidates = 8
	}
	if maxCandidates > 25 {
		maxCandidates = 25
	}

	titleNorm := normalizeSpaces(title)
	authorNorm := normalizeSpaces(author)
	candidates := make([]DuplicateCandidate, 0)
	seen := make(map[string]struct{})

	// 1. Identifier matches
	for _, ident := range identifiers {
		if len(candidates) >= maxCandidates {
			break
		}
		t := strings.ToLower(normalizeSpaces(ident.Type))
		valNorm := normalizeDuplicateIdentifierValue(ident.Type, ident.Value)
		if t == "" || valNorm == "" {
			continue
		}
		rows, err := db.QueryContext(ctx, `
			SELECT bi.book_id, bi.value
			FROM book_identifiers bi
			INNER JOIN books b ON b.id = bi.book_id
			INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
			WHERE bi.type = ?
			LIMIT 2000
		`, userID, t)
		if err != nil {
			return nil, err
		}
		var matchedIDs []string
		for rows.Next() {
			var bid, val string
			if err := rows.Scan(&bid, &val); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if normalizeDuplicateIdentifierValue(t, val) == normalizeDuplicateIdentifierValue(t, valNorm) {
				matchedIDs = append(matchedIDs, bid)
			}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		bookMap, err := loadBooksForCandidates(ctx, db, matchedIDs)
		if err != nil {
			return nil, err
		}
		for _, id := range matchedIDs {
			if len(candidates) >= maxCandidates {
				break
			}
			if _, ok := seen[id]; ok {
				continue
			}
			b, ok := bookMap[id]
			if !ok {
				continue
			}
			seen[id] = struct{}{}
			candidates = append(candidates, DuplicateCandidate{
				MatchType: "identifier",
				Score:     1,
				Book:      b,
			})
		}
	}

	if len(candidates) >= maxCandidates {
		return candidates, nil
	}

	// 2. Fuzzy title + author
	titleTokens := FuzzyTokens(titleNorm)
	authorTokens := FuzzyTokens(authorNorm)
	seed := FuzzySeedToken(titleTokens)
	if seed == "" {
		return candidates, nil
	}
	likeArg := "%" + strings.ToLower(seed) + "%"
	tRows, err := db.QueryContext(ctx, `
		SELECT b.id
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE LOWER(b.title) LIKE ?
		LIMIT 50
	`, userID, likeArg)
	if err != nil {
		return nil, err
	}
	var candIDs []string
	for tRows.Next() {
		var id string
		if err := tRows.Scan(&id); err != nil {
			_ = tRows.Close()
			return nil, err
		}
		candIDs = append(candIDs, id)
	}
	if err := tRows.Close(); err != nil {
		return nil, err
	}

	bookMap, err := loadBooksForCandidates(ctx, db, candIDs)
	if err != nil {
		return nil, err
	}
	var scored []DuplicateCandidate
	for _, id := range candIDs {
		if _, ok := seen[id]; ok {
			continue
		}
		b, ok := bookMap[id]
		if !ok {
			continue
		}
		ct := FuzzyTokens(b.Title)
		ca := FuzzyTokens(strings.Join(b.AuthorNames, " "))
		sc := FuzzyTitleAuthorScore(titleTokens, authorTokens, ct, ca)
		if sc >= fuzzyDuplicateThreshold {
			scored = append(scored, DuplicateCandidate{
				MatchType: "fuzzy",
				Score:     sc,
				Book:      b,
			})
		}
	}
	sort.Slice(scored, func(i, j int) bool {
		return scored[i].Score > scored[j].Score
	})
	for _, c := range scored {
		if len(candidates) >= maxCandidates {
			break
		}
		seen[c.Book.ID] = struct{}{}
		candidates = append(candidates, c)
	}
	return candidates, nil
}
