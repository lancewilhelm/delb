// Package goodreads imports a reader's Goodreads library export (CSV) into Delb.
package goodreads

import (
	"encoding/csv"
	"errors"
	"html"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Row is one book from a Goodreads library export, normalized for Delb.
type Row struct {
	Index          int      `json:"index"`
	GoodreadsID    string   `json:"goodreadsId"`
	Title          string   `json:"title"`
	FullTitle      string   `json:"fullTitle"`
	SeriesName     string   `json:"seriesName,omitempty"`
	SeriesIndex    *float64 `json:"seriesIndex,omitempty"`
	Authors        []string `json:"authors"`
	ISBN10         string   `json:"isbn10,omitempty"`
	ISBN13         string   `json:"isbn13,omitempty"`
	Rating         int      `json:"rating"`
	Publisher      string   `json:"publisher,omitempty"`
	Pages          *int64   `json:"pages,omitempty"`
	Published      string   `json:"published,omitempty"`
	DateRead       string   `json:"dateRead,omitempty"`
	DateAdded      string   `json:"dateAdded,omitempty"`
	ExclusiveShelf string   `json:"exclusiveShelf"`
	Shelves        []string `json:"shelves"`
	TbrPosition    *int     `json:"tbrPosition,omitempty"`
	Review         string   `json:"review,omitempty"`
	Spoiler        bool     `json:"spoiler,omitempty"`
	PrivateNotes   string   `json:"privateNotes,omitempty"`
	ReadCount      int      `json:"readCount,omitempty"`
	OwnedCopies    int      `json:"ownedCopies,omitempty"`
}

// Standard Goodreads exclusive shelves.
const (
	ShelfRead             = "read"
	ShelfCurrentlyReading = "currently-reading"
	ShelfToRead           = "to-read"
)

// ErrNotGoodreadsExport means the file lacks the columns of a Goodreads export.
var ErrNotGoodreadsExport = errors.New("this file does not look like a Goodreads library export")

var (
	// "The Way of Kings (The Stormlight Archive, #1)" or "Dune (Dune #1)".
	seriesSuffixRe = regexp.MustCompile(`^(.*\S)\s*\(([^()]+?),?\s+#([0-9]+(?:\.[0-9]+)?)(-[0-9.]+)?\)\s*$`)
	seriesPartRe   = regexp.MustCompile(`^(.+?),?\s+#([0-9]+(?:\.[0-9]+)?)(-[0-9.]+)?$`)
	shelfPosRe     = regexp.MustCompile(`([^,]+?)\s*\(#([0-9]+)\)`)
	brRe           = regexp.MustCompile(`(?i)<br\s*/?>`)
	paraEndRe      = regexp.MustCompile(`(?i)</p\s*>`)
	tagRe          = regexp.MustCompile(`<[^>]*>`)
	manyNewlinesRe = regexp.MustCompile(`\n{3,}`)
	isbnCharsRe    = regexp.MustCompile(`[^0-9Xx]`)
)

// Parse reads a Goodreads library export. Columns are found by header name, so
// their order does not matter.
func Parse(r io.Reader) ([]Row, error) {
	cr := csv.NewReader(r)
	cr.LazyQuotes = true
	cr.FieldsPerRecord = -1
	cr.ReuseRecord = false

	header, err := cr.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, ErrNotGoodreadsExport
		}
		return nil, err
	}
	col := make(map[string]int, len(header))
	for i, h := range header {
		h = strings.TrimPrefix(h, "\ufeff")
		col[strings.ToLower(strings.TrimSpace(h))] = i
	}
	for _, required := range []string{"title", "author", "exclusive shelf"} {
		if _, ok := col[required]; !ok {
			return nil, ErrNotGoodreadsExport
		}
	}
	get := func(rec []string, name string) string {
		i, ok := col[name]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}

	rows := make([]Row, 0, 256)
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		fullTitle := get(rec, "title")
		if fullTitle == "" {
			continue
		}
		row := Row{
			Index:          len(rows),
			GoodreadsID:    get(rec, "book id"),
			FullTitle:      fullTitle,
			Publisher:      get(rec, "publisher"),
			ExclusiveShelf: strings.ToLower(get(rec, "exclusive shelf")),
			DateRead:       normalizeDate(get(rec, "date read")),
			DateAdded:      normalizeDate(get(rec, "date added")),
			Review:         reviewToText(get(rec, "my review")),
			Spoiler:        strings.EqualFold(get(rec, "spoiler"), "true"),
			PrivateNotes:   reviewToText(get(rec, "private notes")),
			ReadCount:      atoiOrZero(get(rec, "read count")),
			OwnedCopies:    atoiOrZero(get(rec, "owned copies")),
		}
		if row.ExclusiveShelf == "" {
			row.ExclusiveShelf = ShelfRead
		}
		row.Title, row.SeriesName, row.SeriesIndex = splitSeries(fullTitle)
		row.Authors = splitAuthors(get(rec, "author"), get(rec, "additional authors"))
		row.ISBN10 = cleanISBN(get(rec, "isbn"))
		row.ISBN13 = cleanISBN(get(rec, "isbn13"))
		if rating := atoiOrZero(get(rec, "my rating")); rating >= 1 && rating <= 5 {
			row.Rating = rating
		}
		if pages := atoiOrZero(get(rec, "number of pages")); pages > 0 {
			p := int64(pages)
			row.Pages = &p
		}
		row.Published = get(rec, "original publication year")
		if row.Published == "" {
			row.Published = get(rec, "year published")
		}
		row.Shelves = otherShelves(get(rec, "bookshelves"), row.ExclusiveShelf)
		row.TbrPosition = shelfPosition(get(rec, "bookshelves with positions"), row.ExclusiveShelf)
		rows = append(rows, row)
	}
	return rows, nil
}

// atoiOrZero reads a whole number. Some exports write numbers such as
// ratings and page counts as decimals ("4.0"), so a decimal with no
// fractional part is accepted too.
func atoiOrZero(s string) int {
	v := strings.TrimSpace(s)
	if n, err := strconv.Atoi(v); err == nil {
		return n
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
		return 0
	}
	return int(f)
}

// cleanISBN removes the spreadsheet formula wrapper (="...") and separators.
func cleanISBN(raw string) string {
	v := strings.TrimSpace(raw)
	v = strings.TrimPrefix(v, "=")
	v = strings.Trim(v, `"`)
	v = strings.ToUpper(isbnCharsRe.ReplaceAllString(v, ""))
	if len(v) != 10 && len(v) != 13 {
		return ""
	}
	return v
}

// normalizeDate turns Goodreads "2023/05/14" dates into "2023-05-14".
func normalizeDate(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	v = strings.ReplaceAll(v, "/", "-")
	for _, layout := range []string{"2006-01-02", "2006-1-2"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.Format("2006-01-02")
		}
	}
	return ""
}

func splitSeries(full string) (title, series string, index *float64) {
	m := seriesSuffixRe.FindStringSubmatch(full)
	if m == nil {
		return full, "", nil
	}
	title = strings.TrimSpace(m[1])
	series = strings.TrimSpace(m[2])
	number, rangeEnd := m[3], m[4]
	// "Series, #1; Other Series, #3" keeps only the first series.
	if i := strings.Index(series, ";"); i >= 0 {
		part := seriesPartRe.FindStringSubmatch(strings.TrimSpace(series[:i]))
		if part == nil {
			return title, strings.TrimSpace(series[:i]), nil
		}
		series, number, rangeEnd = strings.TrimSpace(part[1]), part[2], part[3]
	}
	if rangeEnd == "" {
		if f, err := strconv.ParseFloat(number, 64); err == nil {
			index = &f
		}
	}
	return title, series, index
}

func splitAuthors(primary, additional string) []string {
	out := make([]string, 0, 2)
	seen := make(map[string]struct{})
	add := func(name string) {
		name = strings.Join(strings.Fields(name), " ")
		if name == "" {
			return
		}
		key := strings.ToLower(name)
		if _, ok := seen[key]; ok {
			return
		}
		seen[key] = struct{}{}
		out = append(out, name)
	}
	add(primary)
	for _, name := range strings.Split(additional, ",") {
		add(name)
	}
	return out
}

func isExclusiveName(name string) bool {
	return name == ShelfRead || name == ShelfCurrentlyReading || name == ShelfToRead
}

func otherShelves(raw, exclusive string) []string {
	out := make([]string, 0)
	seen := make(map[string]struct{})
	for _, part := range strings.Split(raw, ",") {
		name := strings.TrimSpace(part)
		key := strings.ToLower(name)
		if name == "" || key == exclusive || isExclusiveName(key) {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, name)
	}
	return out
}

func shelfPosition(raw, shelf string) *int {
	for _, m := range shelfPosRe.FindAllStringSubmatch(raw, -1) {
		if strings.EqualFold(strings.TrimSpace(m[1]), shelf) {
			if n, err := strconv.Atoi(m[2]); err == nil && n > 0 {
				return &n
			}
		}
	}
	return nil
}

// reviewToText converts the light HTML in Goodreads reviews to plain text.
func reviewToText(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	s := strings.ReplaceAll(raw, "\r\n", "\n")
	s = brRe.ReplaceAllString(s, "\n")
	s = paraEndRe.ReplaceAllString(s, "\n\n")
	s = tagRe.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = manyNewlinesRe.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}
