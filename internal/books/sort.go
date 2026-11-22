package books

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

var (
	spacesRe        = regexp.MustCompile(`\s+`)
	leadingTheRe    = regexp.MustCompile(`(?i)^the\s+`)
	yearOnlyRe      = regexp.MustCompile(`^(\d{4})$`)
	yearMonthDashRe = regexp.MustCompile(`^(\d{4})-(\d{1,2})$`)
	ymdDashRe       = regexp.MustCompile(`^(\d{4})-(\d{1,2})-(\d{1,2})$`)
	slashDateRe     = regexp.MustCompile(`^(\d{4})/(\d{1,2})(?:/(\d{1,2}))?$`)
	dotDateRe       = regexp.MustCompile(`^(\d{4})\.(\d{1,2})(?:\.(\d{1,2}))?$`)
	isoInstantRe    = regexp.MustCompile(`\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})`)
	hasDigitRe      = regexp.MustCompile(`\d`)
)

func normalizeSpaces(input string) string {
	return strings.TrimSpace(spacesRe.ReplaceAllString(input, " "))
}

// MakeTitleSortKey mirrors server/utils/sort/keys.ts makeTitleSortKey.
func MakeTitleSortKey(title string) string {
	t := normalizeSpaces(title)
	if t == "" {
		return ""
	}
	return leadingTheRe.ReplaceAllString(t, "")
}

// MakeAuthorSortKey mirrors server/utils/sort/keys.ts makeAuthorSortKey.
func MakeAuthorSortKey(name string) string {
	n := normalizeSpaces(name)
	if n == "" {
		return ""
	}
	if strings.Contains(n, ",") {
		return n
	}
	parts := strings.Fields(n)
	if len(parts) <= 1 {
		return n
	}
	last := parts[len(parts)-1]
	rest := strings.TrimSpace(strings.Join(parts[:len(parts)-1], " "))
	if rest == "" {
		return last
	}
	return last + ", " + rest
}

// ParsePublishedDate mirrors server/utils/books/published.ts parsePublishedDate.
func ParsePublishedDate(raw string) *time.Time {
	s := strings.TrimSpace(raw)
	if s == "" {
		return nil
	}
	if m := yearOnlyRe.FindStringSubmatch(s); m != nil {
		y, ok := parseYear(m[1])
		if !ok {
			return nil
		}
		t := time.Date(y, 1, 1, 0, 0, 0, 0, time.UTC)
		return &t
	}
	if m := yearMonthDashRe.FindStringSubmatch(s); m != nil {
		y, ok1 := parseYear(m[1])
		mo, ok2 := parseMonth(m[2])
		if !ok1 || !ok2 {
			return nil
		}
		t := time.Date(y, time.Month(mo), 1, 0, 0, 0, 0, time.UTC)
		return &t
	}
	if m := ymdDashRe.FindStringSubmatch(s); m != nil {
		y, ok1 := parseYear(m[1])
		mo, ok2 := parseMonth(m[2])
		d, ok3 := parseDay(m[3])
		if !ok1 || !ok2 || !ok3 || !isValidDateParts(y, mo, d) {
			return nil
		}
		t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		return &t
	}
	if m := slashDateRe.FindStringSubmatch(s); m != nil {
		y, ok1 := parseYear(m[1])
		mo, ok2 := parseMonth(m[2])
		if !ok1 || !ok2 {
			return nil
		}
		if m[3] == "" {
			t := time.Date(y, time.Month(mo), 1, 0, 0, 0, 0, time.UTC)
			return &t
		}
		d, ok3 := parseDay(m[3])
		if !ok3 || !isValidDateParts(y, mo, d) {
			return nil
		}
		t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		return &t
	}
	if m := dotDateRe.FindStringSubmatch(s); m != nil {
		y, ok1 := parseYear(m[1])
		mo, ok2 := parseMonth(m[2])
		if !ok1 || !ok2 {
			return nil
		}
		if m[3] == "" {
			t := time.Date(y, time.Month(mo), 1, 0, 0, 0, 0, time.UTC)
			return &t
		}
		d, ok3 := parseDay(m[3])
		if !ok3 || !isValidDateParts(y, mo, d) {
			return nil
		}
		t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
		return &t
	}
	if isoInstantRe.MatchString(s) {
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
			if t, err := time.Parse(layout, s); err == nil {
				u := t.UTC()
				return &u
			}
		}
	}
	if hasDigitRe.MatchString(s) && (strings.ContainsAny(s, "-/.T")) {
		for _, layout := range []string{
			time.RFC3339Nano,
			time.RFC3339,
			"2006-01-02T15:04:05",
			"2006-01-02 15:04:05",
			"01/02/2006",
			"Jan 2, 2006",
			"January 2, 2006",
		} {
			if t, err := time.Parse(layout, s); err == nil {
				u := t.UTC()
				return &u
			}
		}
	}
	return nil
}

// NormalizePublishedAtUnix returns Unix seconds for a raw published date, or nil.
func NormalizePublishedAtUnix(raw string) *int64 {
	t := ParsePublishedDate(raw)
	if t == nil {
		return nil
	}
	sec := t.UTC().Unix()
	return &sec
}

func parseYear(s string) (int, bool) {
	y, err := strconv.Atoi(s)
	if err != nil || y < 0 || y > 9999 {
		return 0, false
	}
	return y, true
}

func parseMonth(s string) (int, bool) {
	m, err := strconv.Atoi(s)
	if err != nil || m < 1 || m > 12 {
		return 0, false
	}
	return m, true
}

func parseDay(s string) (int, bool) {
	d, err := strconv.Atoi(s)
	if err != nil || d < 1 || d > 31 {
		return 0, false
	}
	return d, true
}

func isValidDateParts(year, month, day int) bool {
	t := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
	return t.Year() == year && int(t.Month()) == month && t.Day() == day
}

// SortKey and SortDir mirror server/utils/books/book-sort.ts.
type SortKey string
type SortDir string

const (
	SortDateAdded     SortKey = "dateAdded"
	SortAlphabetical  SortKey = "alphabetical"
	SortPublishedDate SortKey = "publishedDate"
	SortPages         SortKey = "pages"

	SortAsc  SortDir = "asc"
	SortDesc SortDir = "desc"
)

type BookCursor struct {
	V  string `json:"v"`
	ID string `json:"id"`
}

func NormalizeSortKey(raw string) SortKey {
	switch strings.TrimSpace(raw) {
	case "alphabetical":
		return SortAlphabetical
	case "publishedDate":
		return SortPublishedDate
	case "pages":
		return SortPages
	default:
		return SortDateAdded
	}
}

func NormalizeSortDir(raw string, sort SortKey) SortDir {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "asc":
		return SortAsc
	case "desc":
		return SortDesc
	default:
		if sort == SortAlphabetical || sort == SortPages {
			return SortAsc
		}
		return SortDesc
	}
}

func EncodeCursor(c BookCursor) string {
	b, _ := json.Marshal(c)
	return base64.RawURLEncoding.EncodeToString(b)
}

func DecodeCursor(raw string) *BookCursor {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		// Also try standard base64url with padding just in case
		b, err = base64.URLEncoding.DecodeString(strings.TrimSpace(raw))
		if err != nil {
			return nil
		}
	}
	var obj map[string]any
	if err := json.Unmarshal(b, &obj); err != nil {
		return nil
	}
	vVal, hasV := obj["v"].(string)
	idVal, hasID := obj["id"].(string)
	if !hasV || !hasID || strings.TrimSpace(idVal) == "" {
		return nil
	}
	return &BookCursor{V: vVal, ID: strings.TrimSpace(idVal)}
}

type BookSortClause struct {
	WhereSQL  string
	WhereArgs []any
	OrderSQL  string
}

// BuildBookSort mirrors server/utils/books/book-sort.ts + page-sort.ts.
// Table alias for books must be `b`.
func BuildBookSort(sort SortKey, sortDir SortDir, cursor *BookCursor) BookSortClause {
	// Validate cursor against sort mode.
	if cursor != nil {
		switch sort {
		case SortDateAdded:
			if _, ok := parseISOToUnixSec(cursor.V); !ok {
				cursor = nil
			}
		case SortPublishedDate:
			if cursor.V == "" {
				cursor = nil
			} else if _, err := strconv.ParseFloat(cursor.V, 64); err != nil {
				cursor = nil
			}
		case SortPages:
			if cursor.V != "" {
				n, err := strconv.Atoi(cursor.V)
				if err != nil || n < 0 {
					cursor = nil
				}
			}
		}
	}

	dirSQL := "ASC"
	cmpOp := ">"
	if sortDir == SortDesc {
		dirSQL = "DESC"
		cmpOp = "<"
	}

	if sort == SortPages {
		valExpr := "CASE WHEN typeof(b.pages) = 'integer' AND b.pages >= 0 THEN b.pages ELSE NULL END"
		unkExpr := "(" + valExpr + " IS NULL)"
		clause := BookSortClause{
			OrderSQL: unkExpr + " ASC, " + valExpr + " " + dirSQL + ", b.id " + dirSQL,
		}
		if cursor != nil {
			if cursor.V != "" {
				n, err := strconv.Atoi(cursor.V)
				if err == nil && n >= 0 {
					clause.WhereSQL = "(" + unkExpr + " = 1 OR " + valExpr + " " + cmpOp + " ? OR (" + valExpr + " = ? AND b.id " + cmpOp + " ?))"
					clause.WhereArgs = []any{n, n, cursor.ID}
				} else {
					clause.WhereSQL = "(" + unkExpr + " = 1 AND b.id " + cmpOp + " ?)"
					clause.WhereArgs = []any{cursor.ID}
				}
			} else {
				clause.WhereSQL = "(" + unkExpr + " = 1 AND b.id " + cmpOp + " ?)"
				clause.WhereArgs = []any{cursor.ID}
			}
		}
		return clause
	}

	var primaryExpr string
	switch sort {
	case SortDateAdded:
		primaryExpr = "b.created_at"
	case SortAlphabetical:
		primaryExpr = "b.sort_title"
	case SortPublishedDate:
		primaryExpr = "COALESCE(b.published_at, 0)"
	default:
		primaryExpr = "b.created_at"
	}

	clause := BookSortClause{
		OrderSQL: primaryExpr + " " + dirSQL + ", b.id " + dirSQL,
	}

	if cursor != nil {
		switch sort {
		case SortDateAdded:
			sec, _ := parseISOToUnixSec(cursor.V)
			clause.WhereSQL = "(" + primaryExpr + " " + cmpOp + " ? OR (" + primaryExpr + " = ? AND b.id " + cmpOp + " ?))"
			clause.WhereArgs = []any{sec, sec, cursor.ID}
		case SortAlphabetical:
			clause.WhereSQL = "(" + primaryExpr + " " + cmpOp + " ? OR (" + primaryExpr + " = ? AND b.id " + cmpOp + " ?))"
			clause.WhereArgs = []any{cursor.V, cursor.V, cursor.ID}
		case SortPublishedDate:
			ms, err := strconv.ParseInt(cursor.V, 10, 64)
			var sec int64
			if err == nil {
				sec = int64(math.Floor(float64(ms) / 1000.0))
			}
			clause.WhereSQL = "(" + primaryExpr + " " + cmpOp + " ? OR (" + primaryExpr + " = ? AND b.id " + cmpOp + " ?))"
			clause.WhereArgs = []any{sec, sec, cursor.ID}
		}
	}

	return clause
}

func parseISOToUnixSec(raw string) (int64, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC().Unix(), true
		}
	}
	return 0, false
}

// NextBookCursor computes the opaque pagination cursor matching server/utils/books/book-sort.ts.
func NextBookCursor(sort SortKey, hasMore bool, id string, createdAtSec int64, sortTitle string, publishedAtSec *int64, pages *int64) *string {
	if !hasMore || id == "" {
		return nil
	}
	var v string
	switch sort {
	case SortPages:
		if pages != nil && *pages >= 0 {
			v = strconv.FormatInt(*pages, 10)
		} else {
			v = ""
		}
	case SortDateAdded:
		v = formatUnixSecISO(createdAtSec)
	case SortAlphabetical:
		v = sortTitle
	case SortPublishedDate:
		if publishedAtSec != nil {
			v = strconv.FormatInt(*publishedAtSec*1000, 10)
		} else {
			v = "0"
		}
	}
	encoded := EncodeCursor(BookCursor{V: v, ID: id})
	return &encoded
}

// TitleFilterGlob mirrors server/utils/books/title-filter.ts and entity-list-query.ts searchPattern.
// Produces a SQLite GLOB pattern matching `input` case-insensitively with metacharacters escaped.
func TitleFilterGlob(input string) string {
	var b strings.Builder
	b.WriteByte('*')
	for _, r := range input {
		lo := unicode.ToLower(r)
		hi := unicode.ToUpper(r)
		forms := []rune{r}
		if lo != r {
			forms = append(forms, lo)
		}
		if hi != r && hi != lo {
			forms = append(forms, hi)
		}
		if len(forms) > 1 && allSingleRune(forms) {
			b.WriteByte('[')
			for _, f := range forms {
				b.WriteRune(f)
			}
			b.WriteByte(']')
		} else {
			switch r {
			case '[', ']', '*', '?':
				b.WriteByte('[')
				b.WriteRune(r)
				b.WriteByte(']')
			default:
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('*')
	return b.String()
}

func allSingleRune(forms []rune) bool {
	for _, r := range forms {
		if !utf8.ValidRune(r) {
			return false
		}
	}
	return true
}

// EscapeLike escapes \, %, and _ for SQLite LIKE ... ESCAPE '\'.
func EscapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}
