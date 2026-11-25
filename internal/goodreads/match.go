package goodreads

import (
	"context"
	"database/sql"
	"sort"
	"strings"

	"github.com/lancewilhelm/delb/internal/books"
)

// Match kinds. "goodreads", "isbn", and "title" are confident matches; "review"
// asks the reader to confirm a likely match; "none" finds no likely match.
const (
	MatchGoodreads = "goodreads"
	MatchISBN      = "isbn"
	MatchTitle     = "title"
	MatchReview    = "review"
	MatchNone      = "none"
)

const (
	confidentTitleScore = 0.95
	candidateScore      = 0.6
	maxCandidates       = 4
)

// Candidate is a Delb book that may be the same as a Goodreads row.
type Candidate struct {
	BookID         string   `json:"bookId"`
	Title          string   `json:"title"`
	Authors        []string `json:"authors"`
	CollectionName string   `json:"collectionName"`
	HasFiles       bool     `json:"hasFiles"`
	Score          float64  `json:"score"`
}

// Match is the importer's best guess for one row.
type Match struct {
	Kind       string      `json:"kind"`
	BookID     string      `json:"bookId,omitempty"`
	Candidates []Candidate `json:"candidates"`
}

type libraryBook struct {
	id             string
	title          string
	collectionName string
	canEdit        bool
	hasFiles       bool
	authors        []string
	titleTokens    []string
	authorTokens   []string
	goodreadsID    string
}

type libraryIndex struct {
	books       []*libraryBook
	byID        map[string]*libraryBook
	byGoodreads map[string][]*libraryBook
	byISBN      map[string][]*libraryBook
	byToken     map[string][]*libraryBook
}

func loadLibrary(ctx context.Context, db *sql.DB, userID string) (*libraryIndex, error) {
	idx := &libraryIndex{
		byID:        make(map[string]*libraryBook),
		byGoodreads: make(map[string][]*libraryBook),
		byISBN:      make(map[string][]*libraryBook),
		byToken:     make(map[string][]*libraryBook),
	}
	rows, err := db.QueryContext(ctx, `
		SELECT b.id, b.title, c.name, cm.role,
		       EXISTS (SELECT 1 FROM book_files bf WHERE bf.book_id = b.id)
		FROM books b
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		INNER JOIN collections c ON c.id = b.collection_id
		ORDER BY b.created_at ASC, b.id ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var b libraryBook
		var role string
		var hasFiles int
		if err := rows.Scan(&b.id, &b.title, &b.collectionName, &role, &hasFiles); err != nil {
			_ = rows.Close()
			return nil, err
		}
		b.canEdit = role == "owner" || role == "editor"
		b.hasFiles = hasFiles != 0
		idx.books = append(idx.books, &b)
		idx.byID[b.id] = &b
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	rows, err = db.QueryContext(ctx, `
		SELECT ba.book_id, a.name
		FROM book_authors ba
		INNER JOIN authors a ON a.id = ba.author_id
		INNER JOIN books b ON b.id = ba.book_id
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
		ORDER BY ba.book_id, ba.position
	`, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, name string
		if err := rows.Scan(&id, &name); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if b := idx.byID[id]; b != nil {
			b.authors = append(b.authors, name)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	rows, err = db.QueryContext(ctx, `
		SELECT bi.book_id, bi.type, bi.value
		FROM book_identifiers bi
		INNER JOIN books b ON b.id = bi.book_id
		INNER JOIN collection_members cm ON cm.collection_id = b.collection_id AND cm.user_id = ?
	`, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, typ, value string
		if err := rows.Scan(&id, &typ, &value); err != nil {
			_ = rows.Close()
			return nil, err
		}
		b := idx.byID[id]
		if b == nil {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(typ)) {
		case "goodreads":
			v := strings.TrimSpace(value)
			if v != "" {
				b.goodreadsID = v
				idx.byGoodreads[v] = append(idx.byGoodreads[v], b)
			}
		case "isbn", "isbn10", "isbn13", "isbn_10", "isbn_13":
			if key := isbnKey(value); key != "" {
				idx.byISBN[key] = append(idx.byISBN[key], b)
			}
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}

	for _, b := range idx.books {
		b.titleTokens = books.FuzzyTokens(b.title)
		b.authorTokens = books.FuzzyTokens(strings.Join(b.authors, " "))
		seen := make(map[string]struct{}, len(b.titleTokens))
		for _, t := range b.titleTokens {
			if _, ok := seen[t]; ok {
				continue
			}
			seen[t] = struct{}{}
			idx.byToken[t] = append(idx.byToken[t], b)
		}
	}
	return idx, nil
}

// isbnKey normalizes an ISBN-10 or ISBN-13 to its ISBN-13 form so that the
// two can be compared.
func isbnKey(raw string) string {
	v := cleanISBN(raw)
	switch len(v) {
	case 13:
		return v
	case 10:
		body := "978" + v[:9]
		sum := 0
		for i, ch := range body {
			d := int(ch - '0')
			if d < 0 || d > 9 {
				return ""
			}
			if i%2 == 1 {
				d *= 3
			}
			sum += d
		}
		check := (10 - sum%10) % 10
		return body + string(rune('0'+check))
	default:
		return ""
	}
}

func uniqueBooks(list []*libraryBook) []*libraryBook {
	seen := make(map[string]struct{}, len(list))
	out := make([]*libraryBook, 0, len(list))
	for _, b := range list {
		if _, ok := seen[b.id]; ok {
			continue
		}
		seen[b.id] = struct{}{}
		out = append(out, b)
	}
	return out
}

func (b *libraryBook) candidate(score float64) Candidate {
	authors := b.authors
	if authors == nil {
		authors = []string{}
	}
	return Candidate{
		BookID:         b.id,
		Title:          b.title,
		Authors:        authors,
		CollectionName: b.collectionName,
		HasFiles:       b.hasFiles,
		Score:          score,
	}
}

// preferBook orders identical matches so that entries with ebook files come first.
func preferBook(list []*libraryBook) {
	sort.SliceStable(list, func(i, j int) bool { return list[i].hasFiles && !list[j].hasFiles })
}

func titleVariants(row Row) [][]string {
	variants := [][]string{books.FuzzyTokens(row.Title)}
	if i := strings.Index(row.Title, ":"); i > 0 {
		variants = append(variants, books.FuzzyTokens(row.Title[:i]))
	}
	if row.FullTitle != row.Title {
		variants = append(variants, books.FuzzyTokens(row.FullTitle))
	}
	return variants
}

func (idx *libraryIndex) match(row Row) Match {
	if row.GoodreadsID != "" {
		if list := uniqueBooks(idx.byGoodreads[row.GoodreadsID]); len(list) > 0 {
			preferBook(list)
			return identifierMatch(MatchGoodreads, list)
		}
	}
	var isbnMatches []*libraryBook
	for _, raw := range []string{row.ISBN13, row.ISBN10} {
		if key := isbnKey(raw); key != "" {
			isbnMatches = append(isbnMatches, idx.byISBN[key]...)
		}
	}
	if list := uniqueBooks(isbnMatches); len(list) > 0 {
		preferBook(list)
		return identifierMatch(MatchISBN, list)
	}

	variants := titleVariants(row)
	authorTokens := books.FuzzyTokens(strings.Join(row.Authors, " "))
	pool := make(map[string]*libraryBook)
	for _, tokens := range variants {
		for _, t := range tokens {
			for _, b := range idx.byToken[t] {
				pool[b.id] = b
			}
		}
	}
	scored := make([]Candidate, 0, len(pool))
	for _, b := range pool {
		best := 0.0
		for _, tokens := range variants {
			if s := books.FuzzyTitleAuthorScore(tokens, authorTokens, b.titleTokens, b.authorTokens); s > best {
				best = s
			}
		}
		if best >= candidateScore {
			scored = append(scored, b.candidate(best))
		}
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].Score != scored[j].Score {
			return scored[i].Score > scored[j].Score
		}
		if scored[i].HasFiles != scored[j].HasFiles {
			return scored[i].HasFiles
		}
		return scored[i].BookID < scored[j].BookID
	})
	if len(scored) > maxCandidates {
		scored = scored[:maxCandidates]
	}
	m := Match{Kind: MatchNone, Candidates: scored}
	if len(scored) == 0 {
		return m
	}
	top := scored[0]
	switch {
	case top.Score >= confidentTitleScore:
		m.Kind = MatchTitle
		m.BookID = top.BookID
	case top.Score >= books.FuzzyDuplicateThreshold:
		m.Kind = MatchReview
		m.BookID = top.BookID
	}
	return m
}

func identifierMatch(kind string, list []*libraryBook) Match {
	m := Match{Kind: kind, BookID: list[0].id, Candidates: make([]Candidate, 0, len(list))}
	for i, b := range list {
		if i >= maxCandidates {
			break
		}
		m.Candidates = append(m.Candidates, b.candidate(1))
	}
	return m
}
