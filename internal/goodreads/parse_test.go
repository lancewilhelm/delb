package goodreads

import (
	"strings"
	"testing"
)

const header = "Book Id,Title,Author,Author l-f,Additional Authors,ISBN,ISBN13,My Rating,Average Rating,Publisher,Binding,Number of Pages,Year Published,Original Publication Year,Date Read,Date Added,Bookshelves,Bookshelves with positions,Exclusive Shelf,My Review,Spoiler,Private Notes,Read Count,Owned Copies\n"

func TestParseGoodreadsExport(t *testing.T) {
	csv := "\ufeff" + header +
		`7235533,"The Way of Kings (The Stormlight Archive, #1)",Brandon Sanderson,"Sanderson, Brandon",,"=""0765326353""","=""9780765326355""",5,4.65,Tor Books,Hardcover,1007,2010,2010,2023/05/14,2021/01/02,"fantasy, favorites","fantasy (#4), favorites (#1)",read,"Loved it.<br/><br/>Really <b>great</b> &amp; long.",true,Lent to Sam,2,1` + "\n" +
		`44767458,Dune (Dune #1),Frank Herbert,"Herbert, Frank","Scott Brick, Frank Herbert","=""""","=""""",0,4.25,Ace,Paperback,,1990,1965,,2020/03/04,"to-read, sci-fi","to-read (#2), sci-fi (#1)",to-read,,,,0,0` + "\n" +
		`1,"Boxed Set (Harry Potter, #1-7)",J.K. Rowling,,,,,3,,,,,,,,,,,,,,,,` + "\n" +
		`2,"Crossover (Alpha, #2; Beta, #5)",Someone,,,,,0,,,,,,,,,"did-not-finish","did-not-finish (#3)",did-not-finish,,,,,` + "\n"

	rows, err := Parse(strings.NewReader(csv))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(rows) != 4 {
		t.Fatalf("rows = %d", len(rows))
	}

	wok := rows[0]
	if wok.Title != "The Way of Kings" || wok.SeriesName != "The Stormlight Archive" || wok.SeriesIndex == nil || *wok.SeriesIndex != 1 {
		t.Fatalf("series parse: %+v", wok)
	}
	if wok.ISBN10 != "0765326353" || wok.ISBN13 != "9780765326355" {
		t.Fatalf("isbn: %q %q", wok.ISBN10, wok.ISBN13)
	}
	if wok.Rating != 5 || wok.DateRead != "2023-05-14" || wok.DateAdded != "2021-01-02" || wok.ExclusiveShelf != "read" {
		t.Fatalf("fields: %+v", wok)
	}
	if strings.Join(wok.Shelves, "|") != "fantasy|favorites" {
		t.Fatalf("shelves: %v", wok.Shelves)
	}
	if wok.Review != "Loved it.\n\nReally great & long." || !wok.Spoiler || wok.PrivateNotes != "Lent to Sam" {
		t.Fatalf("review: %q spoiler=%v notes=%q", wok.Review, wok.Spoiler, wok.PrivateNotes)
	}
	if wok.Pages == nil || *wok.Pages != 1007 || wok.ReadCount != 2 || wok.OwnedCopies != 1 || wok.Published != "2010" {
		t.Fatalf("details: %+v", wok)
	}

	dune := rows[1]
	if dune.Title != "Dune" || dune.SeriesName != "Dune" || dune.ISBN10 != "" || dune.Rating != 0 {
		t.Fatalf("dune: %+v", dune)
	}
	if strings.Join(dune.Authors, "|") != "Frank Herbert|Scott Brick" {
		t.Fatalf("authors: %v", dune.Authors)
	}
	if dune.TbrPosition == nil || *dune.TbrPosition != 2 || strings.Join(dune.Shelves, "|") != "sci-fi" {
		t.Fatalf("tbr: %v %v", dune.TbrPosition, dune.Shelves)
	}
	if dune.Published != "1965" {
		t.Fatalf("published = %q", dune.Published)
	}

	box := rows[2]
	if box.Title != "Boxed Set" || box.SeriesName != "Harry Potter" || box.SeriesIndex != nil {
		t.Fatalf("box set: %+v", box)
	}

	cross := rows[3]
	if cross.SeriesName != "Alpha" || cross.SeriesIndex == nil || *cross.SeriesIndex != 2 {
		t.Fatalf("multi-series: %+v", cross)
	}
	if cross.ExclusiveShelf != "did-not-finish" || len(cross.Shelves) != 0 || cross.TbrPosition == nil || *cross.TbrPosition != 3 {
		t.Fatalf("custom exclusive: %+v", cross)
	}
}

func TestParseAcceptsDecimalNumbers(t *testing.T) {
	csv := "Book Id,Title,Author,My Rating,Number of Pages,Exclusive Shelf\n" +
		"1,Rated,Someone,4.0,320.0,read\n" +
		"2,Unrated,Someone,0.0,,read\n" +
		"3,Odd,Someone,3.5,,read\n"
	rows, err := Parse(strings.NewReader(csv))
	if err != nil {
		t.Fatal(err)
	}
	if rows[0].Rating != 4 || rows[0].Pages == nil || *rows[0].Pages != 320 {
		t.Fatalf("decimal rating/pages: %+v", rows[0])
	}
	if rows[1].Rating != 0 || rows[2].Rating != 0 {
		t.Fatalf("unrated or fractional rating should be 0: %d %d", rows[1].Rating, rows[2].Rating)
	}
}

func TestParseRejectsOtherCSV(t *testing.T) {
	if _, err := Parse(strings.NewReader("a,b,c\n1,2,3\n")); err != ErrNotGoodreadsExport {
		t.Fatalf("err = %v", err)
	}
	if _, err := Parse(strings.NewReader("")); err != ErrNotGoodreadsExport {
		t.Fatalf("empty err = %v", err)
	}
}

func TestISBNKeyConvertsISBN10(t *testing.T) {
	if got := isbnKey("0765326353"); got != "9780765326355" {
		t.Fatalf("isbnKey = %q", got)
	}
	if got := isbnKey("=\"978-0-7653-2635-5\""); got != "9780765326355" {
		t.Fatalf("isbnKey 13 = %q", got)
	}
	if got := isbnKey("123"); got != "" {
		t.Fatalf("isbnKey short = %q", got)
	}
}
