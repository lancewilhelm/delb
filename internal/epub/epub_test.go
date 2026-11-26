package epub

import (
	"archive/zip"
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

func makeSamplePNG(t *testing.T, w, h int, c color.RGBA) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("png.Encode: %v", err)
	}
	return buf.Bytes()
}

func makeMinimalEPUB(t *testing.T, version string, includeCover bool, includeSignature bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	// Uncompressed mimetype first
	mh := &zip.FileHeader{Name: "mimetype", Method: zip.Store}
	mw, _ := zw.CreateHeader(mh)
	_, _ = mw.Write([]byte("application/epub+zip"))

	cw, _ := zw.Create("META-INF/container.xml")
	_, _ = cw.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`))

	if includeSignature {
		sw, _ := zw.Create("META-INF/signatures.xml")
		_, _ = sw.Write([]byte(`<signatures/>`))
	}

	coverMeta := ""
	coverItem := ""
	if includeCover {
		if version == "3.0" {
			coverItem = `<item id="cover-img" href="images/cover.png" media-type="image/png" properties="cover-image"/>`
		} else {
			coverMeta = `<meta name="cover" content="cover-img"/>`
			coverItem = `<item id="cover-img" href="images/cover.png" media-type="image/png"/>`
		}
		iw, _ := zw.Create("OEBPS/images/cover.png")
		_, _ = iw.Write(makeSamplePNG(t, 16, 24, color.RGBA{R: 12, G: 34, B: 56, A: 255}))
	}

	opf, _ := zw.Create("OEBPS/content.opf")
	_, _ = opf.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="` + version + `" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:isbn:9780143127741</dc:identifier>
    <dc:title>Test EPUB ` + version + `</dc:title>
    <dc:creator>Ada Lovelace</dc:creator>
    <dc:publisher>Analytical Press</dc:publisher>
    <dc:date>2024-05-01</dc:date>
    <dc:language>en</dc:language>
    <dc:subject>Computing</dc:subject>
    <dc:subject>History of Science</dc:subject>
    <dc:subject>computing</dc:subject>
    ` + coverMeta + `
  </metadata>
  <manifest>
    ` + coverItem + `
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`))

	ch, _ := zw.Create("OEBPS/ch1.xhtml")
	_, _ = ch.Write([]byte(`<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Ch1</title></head><body><p>Hello</p></body></html>`))

	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestNormalizeArchivePathAndLimits(t *testing.T) {
	if got, err := NormalizeArchivePath("OEBPS/./images/../cover.png"); err != nil || got != "OEBPS/cover.png" {
		t.Fatalf("NormalizeArchivePath = %q, %v", got, err)
	}
	for _, bad := range []string{"", "../secret", "/etc/passwd", `OEBPS\cover.png`, "C:/foo"} {
		if _, err := NormalizeArchivePath(bad); err == nil {
			t.Fatalf("expected unsafe path error for %q", bad)
		}
	}

	data := makeMinimalEPUB(t, "3.0", true, false)
	err := ValidateArchiveLimits(data, &ArchiveLimits{MaxEntries: 2})
	var epubErr *Error
	if !errors.As(err, &epubErr) || epubErr.Code != ErrArchiveLimitExceeded {
		t.Fatalf("expected ARCHIVE_LIMIT_EXCEEDED, got %v", err)
	}
}

func TestParseMetadataAndCoverRoundTrip(t *testing.T) {
	for _, ver := range []string{"2.0", "3.0"} {
		t.Run("epub-"+ver, func(t *testing.T) {
			raw := makeMinimalEPUB(t, ver, true, false)
			meta, err := ParseMetadataFromBytes(raw, "Fallback")
			if err != nil {
				t.Fatalf("ParseMetadataFromBytes: %v", err)
			}
			if meta.Title != "Test EPUB "+ver || meta.Author != "Ada Lovelace" {
				t.Fatalf("unexpected meta: %+v", meta)
			}
			if meta.Publisher != "Analytical Press" || meta.Language != "en" {
				t.Fatalf("unexpected pub/lang: %+v", meta)
			}
			if len(meta.Subjects) != 2 || meta.Subjects[0] != "Computing" || meta.Subjects[1] != "History of Science" {
				t.Fatalf("unexpected subjects: %+v", meta.Subjects)
			}

			coverData, mediaType, ok, err := ExtractCoverFromBytes(raw)
			if err != nil || !ok || len(coverData) == 0 || mediaType != "image/png" {
				t.Fatalf("ExtractCoverFromBytes: ok=%v mt=%q len=%d err=%v", ok, mediaType, len(coverData), err)
			}

			// Rewrite cover with a new PNG and verify InspectCover sees the new cover.
			newPNG := makeSamplePNG(t, 20, 30, color.RGBA{R: 200, G: 100, B: 50, A: 255})
			res, err := SetCover(raw, newPNG, "image/png", CoverMutationOptions{Limits: &UploadArchiveLimits})
			if err != nil {
				t.Fatalf("SetCover: %v", err)
			}
			inspected, err := InspectCover(res.Data, &UploadArchiveLimits)
			if err != nil {
				t.Fatalf("InspectCover: %v", err)
			}
			if inspected == nil || !bytes.Equal(inspected.ImageData, newPNG) {
				t.Fatalf("rewritten cover did not round-trip")
			}
		})
	}
}

func TestSetCoverRejectsSignedEPUB(t *testing.T) {
	raw := makeMinimalEPUB(t, "3.0", true, true)
	newPNG := makeSamplePNG(t, 12, 12, color.RGBA{R: 1, G: 2, B: 3, A: 255})
	_, err := SetCover(raw, newPNG, "image/png", CoverMutationOptions{})
	var epubErr *Error
	if !errors.As(err, &epubErr) || epubErr.Code != ErrSignedEpub {
		t.Fatalf("expected SIGNED_EPUB error, got %v", err)
	}
}

func TestParseDemoOrdinaryEPUBIfPresent(t *testing.T) {
	demoPath := filepath.Join("..", "..", "review", "demo", "ordinary.epub")
	data, err := os.ReadFile(demoPath)
	if os.IsNotExist(err) {
		t.Skip("review/demo/ordinary.epub not generated")
	}
	if err != nil {
		t.Fatalf("read demo epub: %v", err)
	}
	meta, err := ParseMetadataFromBytes(data, "Fallback")
	if err != nil {
		t.Fatalf("ParseMetadataFromBytes(ordinary.epub): %v", err)
	}
	if meta.Title == "" {
		t.Fatalf("expected non-empty title from ordinary.epub")
	}
}
