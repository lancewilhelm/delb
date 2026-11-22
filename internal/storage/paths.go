package storage

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	BaseDir       = "library"
	CoverFilename = "cover.webp"
	IDSliceLength = 8
)

var (
	multiSpaceRe    = regexp.MustCompile(`\s+`)
	windowsBadRe    = regexp.MustCompile(`[<>:"|?*]`)
	multiDotRe      = regexp.MustCompile(`\.\.+`)
	leadingDotRe    = regexp.MustCompile(`^\.+`)
	trailingDotRe   = regexp.MustCompile(`\.+$`)
	trailingDotSpRe = regexp.MustCompile(`[. ]+$`)
	nonAlnumExtRe   = regexp.MustCompile(`[^a-z0-9]+`)
	dlBadCharsRe    = regexp.MustCompile(`[\\/:*?"<>|]+`)
)

// NormalizeSpaces collapses internal whitespace and trims ends.
func NormalizeSpaces(input string) string {
	return strings.TrimSpace(multiSpaceRe.ReplaceAllString(input, " "))
}

// NormalizePosix converts backslashes to forward slashes, collapses duplicate
// slashes, and trims a trailing slash.
func NormalizePosix(p string) string {
	s := strings.ReplaceAll(p, "\\", "/")
	for strings.Contains(s, "//") {
		s = strings.ReplaceAll(s, "//", "/")
	}
	return strings.TrimSuffix(s, "/")
}

// ToSafePathSegment mirrors server/utils/books/fs.ts toSafePathSegment.
func ToSafePathSegment(input, fallback string, maxLength int) string {
	if fallback == "" {
		fallback = "unknown"
	}
	if maxLength <= 0 {
		maxLength = 80
	}
	raw := strings.TrimSpace(input)
	if raw == "" {
		return fallback
	}

	s := norm.NFKC.String(raw)
	s = strings.ReplaceAll(s, "/", " ")
	s = strings.ReplaceAll(s, "\\", " ")

	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r <= 0x1f || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	s = b.String()

	s = windowsBadRe.ReplaceAllString(s, " ")
	s = multiDotRe.ReplaceAllString(s, ".")
	s = leadingDotRe.ReplaceAllString(s, "")
	s = trailingDotRe.ReplaceAllString(s, "")
	s = strings.TrimSpace(multiSpaceRe.ReplaceAllString(s, " "))
	s = trailingDotSpRe.ReplaceAllString(s, "")
	if s == "" {
		return fallback
	}

	// Match JS string.slice(0, maxLength) behavior on UTF-16 code units / runes.
	runes := []rune(s)
	if len(runes) > maxLength {
		s = strings.TrimSpace(string(runes[:maxLength]))
	}
	if s == "" {
		return fallback
	}
	return s
}

func getBookIDSlice(bookID string, length int) string {
	raw := strings.TrimSpace(bookID)
	if raw == "" {
		return "unknown"
	}
	if length < 1 {
		length = 1
	}
	if length > 32 {
		length = 32
	}
	runes := []rune(raw)
	if len(runes) > length {
		return string(runes[:length])
	}
	return raw
}

// MakeAuthorFolderName mirrors server/utils/books/storage/paths.ts makeAuthorFolderName.
func MakeAuthorFolderName(authors []string) string {
	names := make([]string, 0, len(authors))
	for _, a := range authors {
		if n := NormalizeSpaces(a); n != "" {
			names = append(names, n)
		}
	}
	if len(names) == 0 {
		return "Unknown Author"
	}
	if len(names) == 1 {
		return names[0]
	}
	base := names[0] + " & " + names[1]
	if len(names) > 2 {
		return base + " et al"
	}
	return base
}

// MakeBookFolderName mirrors server/utils/books/storage/paths.ts makeBookFolderName.
func MakeBookFolderName(title, bookID string) string {
	safeTitle := ToSafePathSegment(NormalizeSpaces(title), "Untitled", 80)
	return safeTitle + " (" + getBookIDSlice(bookID, IDSliceLength) + ")"
}

func toSafeFilename(input, fallback string) string {
	if fallback == "" {
		fallback = "file"
	}
	raw := strings.TrimSpace(input)
	if raw == "" {
		return fallback
	}
	extRaw := path.Ext(raw)
	baseRaw := raw
	if extRaw != "" {
		baseRaw = raw[:len(raw)-len(extRaw)]
	}
	extClean := strings.TrimLeft(strings.ToLower(extRaw), ".")
	extClean = nonAlnumExtRe.ReplaceAllString(extClean, "")
	extPart := ""
	if extClean != "" {
		extPart = "." + extClean
	}
	maxBase := 80 - len(extPart)
	if maxBase < 1 {
		maxBase = 1
	}
	safeBase := ToSafePathSegment(baseRaw, fallback, maxBase)
	if safeBase == "" {
		safeBase = fallback
	}
	return safeBase + extPart
}

// BuildBookStorageRelativePath computes library/<authorDir>/<title (id8)>/<filename> (POSIX).
func BuildBookStorageRelativePath(authorNames []string, title, bookID, filename string) string {
	authorDisplay := MakeAuthorFolderName(authorNames)
	authorDir := ToSafePathSegment(authorDisplay, "Unknown Author", 80)
	bookDir := ToSafePathSegment(MakeBookFolderName(title, bookID), "Untitled", 80)
	fileName := toSafeFilename(NormalizeSpaces(filename), "file")
	return BaseDir + "/" + authorDir + "/" + bookDir + "/" + fileName
}

// CanonicalBookPaths holds the canonical POSIX relative paths for a book.
type CanonicalBookPaths struct {
	BookDir   string
	CoverPath string
	EpubPath  string
}

// GetCanonicalBookPaths mirrors server/utils/books/storage/paths.ts getCanonicalBookPaths.
func GetCanonicalBookPaths(authorNames []string, title, bookID string) CanonicalBookPaths {
	authorDisplay := MakeAuthorFolderName(authorNames)
	authorDir := ToSafePathSegment(authorDisplay, "Unknown Author", 80)
	bookFolder := ToSafePathSegment(MakeBookFolderName(title, bookID), "Untitled", 80)
	bookDir := BaseDir + "/" + authorDir + "/" + bookFolder
	titleSafe := ToSafePathSegment(NormalizeSpaces(title), "Untitled", 80)
	epubFilename := ToSafePathSegment(titleSafe+".epub", "book.epub", 80)
	return CanonicalBookPaths{
		BookDir:   bookDir,
		CoverPath: bookDir + "/" + CoverFilename,
		EpubPath:  bookDir + "/" + epubFilename,
	}
}

// BuildBookCoverURL mirrors server/utils/books/cover-url.ts buildBookCoverUrl.
func BuildBookCoverURL(bookID string, updatedAtMs *int64, variant string) string {
	if variant == "" {
		variant = "thumb"
	}
	base := "/api/books/" + encodeURIComponent(bookID) + "/cover?variant=" + variant
	if updatedAtMs == nil {
		return base
	}
	return base + "&v=" + encodeURIComponent(strconv.FormatInt(*updatedAtMs, 10))
}

// BookDownloadDisposition mirrors server/utils/books/download-disposition.ts.
func BookDownloadDisposition(title, format string) string {
	wellFormed := strings.ToValidUTF8(title, "\uFFFD")
	safe := dlBadCharsRe.ReplaceAllString(wellFormed, "_")
	safe = multiSpaceRe.ReplaceAllString(safe, " ")
	var cleaned strings.Builder
	for _, r := range safe {
		if unicode.Is(unicode.Cc, r) {
			cleaned.WriteByte('_')
		} else {
			cleaned.WriteRune(r)
		}
	}
	safeTitle := strings.TrimSpace(cleaned.String())
	if safeTitle == "" {
		safeTitle = "book"
	}
	filename := safeTitle + "." + format

	var fallback strings.Builder
	for _, r := range filename {
		if r < 0x20 || r > 0x7e || r == '%' {
			fallback.WriteByte('_')
		} else {
			fallback.WriteRune(r)
		}
	}
	encoded := encodeRFC5987(filename)
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, fallback.String(), encoded)
}

func encodeURIComponent(s string) string {
	// url.PathEscape matches JS encodeURIComponent except for a few chars; handle RFC 3986 / JS encodeURIComponent.
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func encodeRFC5987(s string) string {
	// Matches JS encodeURIComponent(filename).replace(/[!'()*]/g, hex)
	var b strings.Builder
	for i := 0; i < len(s); {
		_, size := utf8.DecodeRuneInString(s[i:])
		if size == 1 {
			c := s[i]
			if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
				c == '-' || c == '_' || c == '.' || c == '~' {
				b.WriteByte(c)
				i++
				continue
			}
		}
		for j := 0; j < size; j++ {
			fmt.Fprintf(&b, "%%%02X", s[i+j])
		}
		i += size
	}
	return b.String()
}
