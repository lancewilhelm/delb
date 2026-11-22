package epub

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"net/url"
	"sort"
	"strings"
)

// ErrorCode mirrors packages/epub/src/types.ts EpubErrorCode.
type ErrorCode string

const (
	ErrInvalidEpub          ErrorCode = "INVALID_EPUB"
	ErrArchiveLimitExceeded ErrorCode = "ARCHIVE_LIMIT_EXCEEDED"
	ErrSignedEpub           ErrorCode = "SIGNED_EPUB"
	ErrEncryptedCover       ErrorCode = "ENCRYPTED_COVER"
	ErrMissingCover         ErrorCode = "MISSING_COVER"
	ErrUnsupportedImage     ErrorCode = "UNSUPPORTED_IMAGE"
)

// Error mirrors packages/epub/src/errors.ts EpubError.
type Error struct {
	Code    ErrorCode
	Message string
	Cause   error
}

func (e *Error) Error() string {
	return e.Message
}

func (e *Error) Unwrap() error {
	return e.Cause
}

func invalidEpub(msg string, cause error) *Error {
	return &Error{Code: ErrInvalidEpub, Message: msg, Cause: cause}
}

// ArchiveLimits mirrors packages/epub/src/types.ts ArchiveLimits.
type ArchiveLimits struct {
	MaxEntries                int
	MaxEntryUncompressedBytes int64
	MaxTotalUncompressedBytes int64
}

// DefaultArchiveLimits matches packages/epub/src/archive.ts DEFAULT_ARCHIVE_LIMITS.
var DefaultArchiveLimits = ArchiveLimits{
	MaxEntries:                10_000,
	MaxEntryUncompressedBytes: 256 * 1024 * 1024,
	MaxTotalUncompressedBytes: 1024 * 1024 * 1024,
}

// UploadArchiveLimits matches server/utils/books/epub.ts limits.
var UploadArchiveLimits = ArchiveLimits{
	MaxEntries:                10_000,
	MaxEntryUncompressedBytes: 32 * 1024 * 1024,
	MaxTotalUncompressedBytes: 256 * 1024 * 1024,
}

func resolveLimits(overrides *ArchiveLimits) ArchiveLimits {
	lim := DefaultArchiveLimits
	if overrides != nil {
		if overrides.MaxEntries > 0 {
			lim.MaxEntries = overrides.MaxEntries
		}
		if overrides.MaxEntryUncompressedBytes > 0 {
			lim.MaxEntryUncompressedBytes = overrides.MaxEntryUncompressedBytes
		}
		if overrides.MaxTotalUncompressedBytes > 0 {
			lim.MaxTotalUncompressedBytes = overrides.MaxTotalUncompressedBytes
		}
	}
	return lim
}

// NormalizeArchivePath mirrors packages/epub/src/path.ts normalizeArchivePath.
func NormalizeArchivePath(input string) (string, error) {
	if input == "" || strings.Contains(input, "\\") || strings.HasPrefix(input, "/") ||
		(len(input) >= 2 && ((input[0] >= 'a' && input[0] <= 'z') || (input[0] >= 'A' && input[0] <= 'Z')) && input[1] == ':') {
		display := input
		if display == "" {
			display = "<empty>"
		}
		return "", invalidEpub("Unsafe EPUB archive path: "+display, nil)
	}
	parts := make([]string, 0, 8)
	for _, part := range strings.Split(input, "/") {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			if len(parts) == 0 {
				return "", invalidEpub("EPUB path escapes the archive root: "+input, nil)
			}
			parts = parts[:len(parts)-1]
			continue
		}
		if strings.ContainsRune(part, '\x00') {
			return "", invalidEpub("EPUB paths cannot contain NUL bytes", nil)
		}
		parts = append(parts, part)
	}
	if len(parts) == 0 {
		return "", invalidEpub("Unsafe EPUB archive path: "+input, nil)
	}
	return strings.Join(parts, "/"), nil
}

func archiveDirname(input string) string {
	idx := strings.LastIndexByte(input, '/')
	if idx < 0 {
		return ""
	}
	return input[:idx]
}

func archiveBasename(input string) string {
	idx := strings.LastIndexByte(input, '/')
	if idx < 0 {
		return input
	}
	return input[idx+1:]
}

func archiveJoin(parts ...string) (string, error) {
	nonEmpty := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	return NormalizeArchivePath(strings.Join(nonEmpty, "/"))
}

func resolveHref(baseFile, href string) (string, error) {
	raw := href
	if idx := strings.IndexByte(raw, '#'); idx >= 0 {
		raw = raw[:idx]
	}
	if idx := strings.IndexByte(raw, '?'); idx >= 0 {
		raw = raw[:idx]
	}
	segs := strings.Split(raw, "/")
	for i, seg := range segs {
		decoded, err := url.PathUnescape(seg)
		if err != nil {
			return "", invalidEpub("Invalid percent-encoding in EPUB href: "+href, err)
		}
		segs[i] = decoded
	}
	return archiveJoin(archiveDirname(baseFile), strings.Join(segs, "/"))
}

func relativeHref(fromFile, targetFile string) string {
	fromDir := archiveDirname(fromFile)
	var from []string
	if fromDir != "" {
		from = strings.Split(fromDir, "/")
	}
	var target []string
	if targetFile != "" {
		target = strings.Split(targetFile, "/")
	}
	common := 0
	for common < len(from) && common < len(target) && from[common] == target[common] {
		common++
	}
	out := make([]string, 0, len(from)-common+len(target)-common)
	for range from[common:] {
		out = append(out, "..")
	}
	for _, seg := range target[common:] {
		out = append(out, url.PathEscape(seg))
	}
	if len(out) == 0 {
		return archiveBasename(targetFile)
	}
	return strings.Join(out, "/")
}

func uniqueArchivePath(files map[string][]byte, preferred string) string {
	if _, exists := files[preferred]; !exists {
		return preferred
	}
	dot := strings.LastIndexByte(preferred, '.')
	stem := preferred
	ext := ""
	if dot >= 0 {
		stem = preferred[:dot]
		ext = preferred[dot:]
	}
	for idx := 2; ; idx++ {
		cand := fmt.Sprintf("%s-%d%s", stem, idx, ext)
		if _, exists := files[cand]; !exists {
			return cand
		}
	}
}

// ValidateArchiveLimits mirrors packages/epub/src/archive.ts validateArchiveLimits.
func ValidateArchiveLimits(input []byte, overrides *ArchiveLimits) error {
	return preflightArchive(input, resolveLimits(overrides))
}

func preflightArchive(input []byte, limits ArchiveLimits) error {
	minSearch := len(input) - 65557
	if minSearch < 0 {
		minSearch = 0
	}
	eocd := findSignature(input, 0x06054b50, minSearch)
	if eocd < 0 {
		return invalidEpub("ZIP end-of-central-directory record was not found", nil)
	}

	entryCount := uint64(binary.LittleEndian.Uint16(input[eocd+10 : eocd+12]))
	centralOffset := uint64(binary.LittleEndian.Uint32(input[eocd+16 : eocd+20]))

	if entryCount == 0xffff || centralOffset == 0xffffffff {
		locOffset := eocd - 20
		if locOffset < 0 || binary.LittleEndian.Uint32(input[locOffset:locOffset+4]) != 0x07064b50 {
			return invalidEpub("ZIP64 locator is missing", nil)
		}
		zip64Offset := binary.LittleEndian.Uint64(input[locOffset+8 : locOffset+16])
		if zip64Offset+56 > uint64(len(input)) || binary.LittleEndian.Uint32(input[zip64Offset:zip64Offset+4]) != 0x06064b50 {
			return invalidEpub("ZIP64 directory record is missing", nil)
		}
		entryCount = binary.LittleEndian.Uint64(input[zip64Offset+32 : zip64Offset+40])
		centralOffset = binary.LittleEndian.Uint64(input[zip64Offset+48 : zip64Offset+56])
	}

	if entryCount > uint64(limits.MaxEntries) {
		return &Error{
			Code:    ErrArchiveLimitExceeded,
			Message: fmt.Sprintf("EPUB contains %d entries; the limit is %d", entryCount, limits.MaxEntries),
		}
	}

	offset := centralOffset
	var total int64
	names := make(map[string]struct{}, int(entryCount))

	for i := uint64(0); i < entryCount; i++ {
		if offset+46 > uint64(len(input)) || binary.LittleEndian.Uint32(input[offset:offset+4]) != 0x02014b50 {
			return invalidEpub("ZIP central directory is malformed", nil)
		}
		method := binary.LittleEndian.Uint16(input[offset+10 : offset+12])
		if method != 0 && method != 8 {
			return invalidEpub(fmt.Sprintf("EPUB uses unsupported ZIP compression method %d", method), nil)
		}
		compressed := uint64(binary.LittleEndian.Uint32(input[offset+20 : offset+24]))
		uncompressed := uint64(binary.LittleEndian.Uint32(input[offset+24 : offset+28]))
		nameLen := uint64(binary.LittleEndian.Uint16(input[offset+28 : offset+30]))
		extraLen := uint64(binary.LittleEndian.Uint16(input[offset+30 : offset+32]))
		commentLen := uint64(binary.LittleEndian.Uint16(input[offset+32 : offset+34]))
		nameStart := offset + 46
		extraStart := nameStart + nameLen
		if extraStart+extraLen+commentLen > uint64(len(input)) {
			return invalidEpub("ZIP entry exceeds the archive bounds", nil)
		}

		if compressed == 0xffffffff || uncompressed == 0xffffffff {
			zStart, zLen, ok, err := findExtraField(input, int(extraStart), int(extraLen), 0x0001)
			if err != nil {
				return err
			}
			if !ok {
				return invalidEpub("ZIP64 entry sizes are missing", nil)
			}
			cur := zStart
			end := zStart + zLen
			if uncompressed == 0xffffffff {
				if cur+8 > end {
					return invalidEpub("ZIP64 uncompressed size is missing", nil)
				}
				uncompressed = binary.LittleEndian.Uint64(input[cur : cur+8])
				cur += 8
			}
			if compressed == 0xffffffff {
				if cur+8 > end {
					return invalidEpub("ZIP64 compressed size is missing", nil)
				}
				_ = binary.LittleEndian.Uint64(input[cur : cur+8])
			}
		}

		rawName := string(input[nameStart : nameStart+nameLen])
		if !strings.HasSuffix(rawName, "/") {
			normName, err := NormalizeArchivePath(rawName)
			if err != nil {
				return err
			}
			if _, dup := names[normName]; dup {
				return invalidEpub("Duplicate EPUB archive path: "+normName, nil)
			}
			names[normName] = struct{}{}
			if uncompressed > uint64(limits.MaxEntryUncompressedBytes) {
				return &Error{
					Code:    ErrArchiveLimitExceeded,
					Message: fmt.Sprintf("%s exceeds the per-entry uncompressed size limit", normName),
				}
			}
			total += int64(uncompressed)
			if total > limits.MaxTotalUncompressedBytes {
				return &Error{
					Code:    ErrArchiveLimitExceeded,
					Message: "EPUB exceeds the total uncompressed size limit",
				}
			}
		}
		offset = extraStart + extraLen + commentLen
	}
	return nil
}

func findSignature(buf []byte, sig uint32, minimum int) int {
	for offset := len(buf) - 22; offset >= minimum; offset-- {
		if offset >= 0 && offset+4 <= len(buf) && binary.LittleEndian.Uint32(buf[offset:offset+4]) == sig {
			return offset
		}
	}
	return -1
}

func findExtraField(buf []byte, start, length int, wanted uint16) (int, int, bool, error) {
	cur := start
	end := start + length
	for cur+4 <= end {
		id := binary.LittleEndian.Uint16(buf[cur : cur+2])
		size := int(binary.LittleEndian.Uint16(buf[cur+2 : cur+4]))
		cur += 4
		if cur+size > end {
			return 0, 0, false, invalidEpub("ZIP extra field is malformed", nil)
		}
		if id == wanted {
			return cur, size, true, nil
		}
		cur += size
	}
	return 0, 0, false, nil
}

// ReadArchive validates archive limits and decompresses all entries into a normalized map.
func ReadArchive(input []byte, overrides *ArchiveLimits) (map[string][]byte, error) {
	lim := resolveLimits(overrides)
	if err := preflightArchive(input, lim); err != nil {
		return nil, err
	}
	zr, err := zip.NewReader(bytes.NewReader(input), int64(len(input)))
	if err != nil {
		return nil, invalidEpub("The input is not a readable ZIP-based EPUB archive", err)
	}
	files := make(map[string][]byte, len(zr.File))
	var actualTotal int64
	for _, f := range zr.File {
		if strings.HasSuffix(f.Name, "/") {
			continue
		}
		normName, err := NormalizeArchivePath(f.Name)
		if err != nil {
			return nil, err
		}
		if _, dup := files[normName]; dup {
			return nil, invalidEpub("Duplicate EPUB archive path: "+normName, nil)
		}
		rc, err := f.Open()
		if err != nil {
			return nil, invalidEpub("The input is not a readable ZIP-based EPUB archive", err)
		}
		data, err := io.ReadAll(io.LimitReader(rc, lim.MaxEntryUncompressedBytes+1))
		_ = rc.Close()
		if err != nil {
			return nil, invalidEpub("The input is not a readable ZIP-based EPUB archive", err)
		}
		if int64(len(data)) > lim.MaxEntryUncompressedBytes {
			return nil, &Error{
				Code:    ErrArchiveLimitExceeded,
				Message: fmt.Sprintf("%s exceeds the per-entry uncompressed size limit", normName),
			}
		}
		actualTotal += int64(len(data))
		if actualTotal > lim.MaxTotalUncompressedBytes {
			return nil, &Error{
				Code:    ErrArchiveLimitExceeded,
				Message: "EPUB exceeds the total uncompressed size limit",
			}
		}
		files[normName] = data
	}
	return files, nil
}

// WriteArchive writes a canonical EPUB ZIP archive with uncompressed `mimetype` first
// (zero extra field, stored method 0) followed by deflated entries in sorted order.
func WriteArchive(files map[string][]byte) ([]byte, error) {
	mimetype, ok := files["mimetype"]
	if !ok || string(mimetype) != "application/epub+zip" {
		return nil, invalidEpub("EPUB mimetype must contain exactly application/epub+zip", nil)
	}
	otherNames := make([]string, 0, len(files))
	for name := range files {
		if name != "mimetype" {
			otherNames = append(otherNames, name)
		}
	}
	sort.Strings(otherNames)
	ordered := append([]string{"mimetype"}, otherNames...)
	if len(ordered) > 0xffff {
		return nil, invalidEpub("Writing ZIP64 EPUBs is not supported", nil)
	}

	var localBuf bytes.Buffer
	var centralBuf bytes.Buffer
	for _, name := range ordered {
		normName, err := NormalizeArchivePath(name)
		if err != nil {
			return nil, err
		}
		original := files[name]
		stored := normName == "mimetype"
		var compressed []byte
		if stored {
			compressed = original
		} else {
			var comp bytes.Buffer
			fw, err := flate.NewWriter(&comp, 6)
			if err != nil {
				return nil, err
			}
			if _, err := fw.Write(original); err != nil {
				return nil, err
			}
			if err := fw.Close(); err != nil {
				return nil, err
			}
			compressed = comp.Bytes()
		}
		localOffset := localBuf.Len()
		if uint64(len(original)) > 0xffffffff || uint64(len(compressed)) > 0xffffffff || uint64(localOffset) > 0xffffffff {
			return nil, invalidEpub("Writing ZIP64 EPUBs is not supported", nil)
		}

		crc := crc32.ChecksumIEEE(original)
		nameBytes := []byte(normName)
		ver := uint16(20)
		method := uint16(8)
		if stored {
			ver = 10
			method = 0
		}

		var lh [30]byte
		binary.LittleEndian.PutUint32(lh[0:4], 0x04034b50)
		binary.LittleEndian.PutUint16(lh[4:6], ver)
		binary.LittleEndian.PutUint16(lh[6:8], 0x0800)
		binary.LittleEndian.PutUint16(lh[8:10], method)
		binary.LittleEndian.PutUint16(lh[10:12], 0)
		binary.LittleEndian.PutUint16(lh[12:14], 0x0021)
		binary.LittleEndian.PutUint32(lh[14:18], crc)
		binary.LittleEndian.PutUint32(lh[18:22], uint32(len(compressed)))
		binary.LittleEndian.PutUint32(lh[22:26], uint32(len(original)))
		binary.LittleEndian.PutUint16(lh[26:28], uint16(len(nameBytes)))
		localBuf.Write(lh[:])
		localBuf.Write(nameBytes)
		localBuf.Write(compressed)

		var ch [46]byte
		binary.LittleEndian.PutUint32(ch[0:4], 0x02014b50)
		binary.LittleEndian.PutUint16(ch[4:6], 20)
		binary.LittleEndian.PutUint16(ch[6:8], ver)
		binary.LittleEndian.PutUint16(ch[8:10], 0x0800)
		binary.LittleEndian.PutUint16(ch[10:12], method)
		binary.LittleEndian.PutUint16(ch[12:14], 0)
		binary.LittleEndian.PutUint16(ch[14:16], 0x0021)
		binary.LittleEndian.PutUint32(ch[16:20], crc)
		binary.LittleEndian.PutUint32(ch[20:24], uint32(len(compressed)))
		binary.LittleEndian.PutUint32(ch[24:28], uint32(len(original)))
		binary.LittleEndian.PutUint16(ch[28:30], uint16(len(nameBytes)))
		binary.LittleEndian.PutUint32(ch[42:46], uint32(localOffset))
		centralBuf.Write(ch[:])
		centralBuf.Write(nameBytes)
	}

	var eocd [22]byte
	binary.LittleEndian.PutUint32(eocd[0:4], 0x06054b50)
	binary.LittleEndian.PutUint16(eocd[8:10], uint16(len(ordered)))
	binary.LittleEndian.PutUint16(eocd[10:12], uint16(len(ordered)))
	binary.LittleEndian.PutUint32(eocd[12:16], uint32(centralBuf.Len()))
	binary.LittleEndian.PutUint32(eocd[16:20], uint32(localBuf.Len()))

	out := make([]byte, 0, localBuf.Len()+centralBuf.Len()+len(eocd))
	out = append(out, localBuf.Bytes()...)
	out = append(out, centralBuf.Bytes()...)
	out = append(out, eocd[:]...)
	return out, nil
}
