package books

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/HugoSmits86/nativewebp"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"
	"golang.org/x/image/webp"
)

// ImageMeta contains basic sniffed metadata about an image byte slice.
type ImageMeta struct {
	Format string // "jpeg", "png", "webp", "gif", "tiff"
	Width  int
	Height int
}

// SniffImageMeta decodes image dimensions and format without decoding pixels.
func SniffImageMeta(data []byte) (ImageMeta, error) {
	// Ensure decoders are referenced (gif/jpeg/png register via init, webp/tiff explicit).
	_ = gif.DecodeConfig
	_ = jpeg.DecodeConfig
	_ = png.DecodeConfig
	_ = webp.DecodeConfig
	_ = tiff.DecodeConfig

	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		// Try webp & tiff explicitly in case not registered.
		if wcfg, werr := webp.DecodeConfig(bytes.NewReader(data)); werr == nil {
			return ImageMeta{Format: "webp", Width: wcfg.Width, Height: wcfg.Height}, nil
		}
		if tcfg, terr := tiff.DecodeConfig(bytes.NewReader(data)); terr == nil {
			return ImageMeta{Format: "tiff", Width: tcfg.Width, Height: tcfg.Height}, nil
		}
		return ImageMeta{}, err
	}
	return ImageMeta{
		Format: strings.ToLower(format),
		Width:  cfg.Width,
		Height: cfg.Height,
	}, nil
}

// DecodeImageAndOrient decodes JPEG/PNG/WebP/GIF/TIFF and applies JPEG EXIF orientation.
func DecodeImageAndOrient(data []byte) (image.Image, string, error) {
	meta, err := SniffImageMeta(data)
	if err != nil {
		return nil, "", err
	}
	var img image.Image
	switch meta.Format {
	case "jpeg":
		img, err = jpeg.Decode(bytes.NewReader(data))
	case "png":
		img, err = png.Decode(bytes.NewReader(data))
	case "webp":
		img, err = webp.Decode(bytes.NewReader(data))
	case "gif":
		img, err = gif.Decode(bytes.NewReader(data))
	case "tiff":
		img, err = tiff.Decode(bytes.NewReader(data))
	default:
		img, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, "", err
	}
	if meta.Format == "jpeg" {
		if orient := readJPEGExifOrientation(data); orient > 1 && orient <= 8 {
			img = applyExifOrientation(img, orient)
		}
	}
	return img, meta.Format, nil
}

// ResizeMaxWidth resizes img proportionally so its width is at most maxWidth (without enlarging).
func ResizeMaxWidth(img image.Image, maxWidth int) image.Image {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= 0 || h <= 0 || maxWidth <= 0 || w <= maxWidth {
		return img
	}
	newH := int(float64(h)*float64(maxWidth)/float64(w) + 0.5)
	if newH < 1 {
		newH = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, maxWidth, newH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Over, nil)
	return dst
}

// ResizeInsideNoEnlarge resizes img proportionally to fit within maxW x maxH
// without enlarging if already smaller.
func ResizeInsideNoEnlarge(img image.Image, maxW, maxH int) image.Image {
	bounds := img.Bounds()
	w := bounds.Dx()
	h := bounds.Dy()
	if w <= 0 || h <= 0 || maxW <= 0 || maxH <= 0 || (w <= maxW && h <= maxH) {
		return img
	}
	scaleW := float64(maxW) / float64(w)
	scaleH := float64(maxH) / float64(h)
	scale := scaleW
	if scaleH < scale {
		scale = scaleH
	}
	newW := int(float64(w)*scale + 0.5)
	newH := int(float64(h)*scale + 0.5)
	if newW < 1 {
		newW = 1
	}
	if newH < 1 {
		newH = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, newW, newH))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Over, nil)
	return dst
}

// ResizeExactFill resizes img to exact dimensions w x h (ignoring aspect ratio).
func ResizeExactFill(img image.Image, w, h int) image.Image {
	bounds := img.Bounds()
	if w <= 0 || h <= 0 {
		return img
	}
	dst := image.NewNRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, bounds, draw.Over, nil)
	return dst
}

// CropImage extracts the rectangle (left, top, left+width, top+height) relative
// to img.Bounds().Min into a new NRGBA image with origin (0, 0).
func CropImage(img image.Image, left, top, width, height int) (*image.NRGBA, error) {
	b := img.Bounds()
	if left < 0 || top < 0 || width <= 0 || height <= 0 || left+width > b.Dx() || top+height > b.Dy() {
		return nil, errors.New("crop region out of bounds")
	}
	dst := image.NewNRGBA(image.Rect(0, 0, width, height))
	srcRect := image.Rect(b.Min.X+left, b.Min.Y+top, b.Min.X+left+width, b.Min.Y+top+height)
	draw.Copy(dst, image.Point{}, img, srcRect, draw.Src, nil)
	return dst, nil
}

// IsAnimatedImage reports whether data is an animated GIF, APNG, or animated WebP.
func IsAnimatedImage(data []byte, format string) bool {
	switch strings.ToLower(format) {
	case "gif":
		g, err := gif.DecodeAll(bytes.NewReader(data))
		return err == nil && len(g.Image) > 1
	case "png":
		// APNG files contain an acTL chunk before the first IDAT chunk.
		if len(data) < 8 || !bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
			return false
		}
		pos := 8
		for pos+12 <= len(data) {
			chunkLen := int(binary.BigEndian.Uint32(data[pos : pos+4]))
			chunkType := string(data[pos+4 : pos+8])
			if chunkType == "acTL" {
				return true
			}
			if chunkType == "IDAT" || chunkType == "IEND" {
				return false
			}
			next := pos + 12 + chunkLen
			if chunkLen < 0 || next > len(data) {
				return false
			}
			pos = next
		}
		return false
	case "webp":
		// Extended WebP VP8X chunk has animation flag at bit 1 (0x02) of byte 0 of payload.
		if len(data) < 30 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
			return false
		}
		if string(data[12:16]) == "VP8X" && len(data) >= 21 {
			return (data[20] & 0x02) != 0
		}
		return false
	default:
		return false
	}
}

// EncodeWebP encodes img as pure-Go WebP using nativewebp.
func EncodeWebP(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := nativewebp.Encode(&buf, img, nil); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// EncodeJPEG encodes img as JPEG with the given quality (1..100).
func EncodeJPEG(img image.Image, quality int) ([]byte, error) {
	if quality <= 0 || quality > 100 {
		quality = 90
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// EncodePNG encodes img as PNG.
func EncodePNG(img image.Image) ([]byte, error) {
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// GenerateCoverThumbWebP creates a 320px-wide (default) WebP thumbnail.
func GenerateCoverThumbWebP(sourceBytes []byte, maxWidth int) ([]byte, error) {
	if maxWidth <= 0 {
		maxWidth = 320
	}
	img, _, err := DecodeImageAndOrient(sourceBytes)
	if err != nil {
		return nil, err
	}
	resized := ResizeMaxWidth(img, maxWidth)
	return EncodeWebP(resized)
}

type StoredCoverInfo struct {
	RelativePath string
	AbsPath      string
	MimeType     string
	Extension    string
	ByteLength   int64
}

type CoverProcessingOpts struct {
	OutputDirAbs      string
	OutputDirRelPosix string
	SourceBaseName    string
	ThumbFileName     string
	ThumbMaxWidth     int
	DoNotOverwrite    bool
}

// EnsureCoverOutputsFromBytes mirrors server/utils/books/covers.ts ensureCoverOutputsFromBytes
// (sourceFormat: "original").
func EnsureCoverOutputsFromBytes(sourceBytes []byte, sourceMimeHint, sourceExtHint string, p CoverProcessingOpts) (source StoredCoverInfo, thumb StoredCoverInfo, changed bool, err error) {
	normDir := storage.NormalizePosix(p.OutputDirRelPosix)
	if !strings.HasPrefix(normDir, "library/") {
		return source, thumb, false, httpapi.NewError(http.StatusInternalServerError, fmt.Sprintf("Expected a path under library/, got: %s", p.OutputDirRelPosix))
	}
	if p.SourceBaseName == "" {
		p.SourceBaseName = "cover.source"
	}
	if p.ThumbFileName == "" {
		p.ThumbFileName = "cover.thumb.webp"
	}
	if p.ThumbMaxWidth <= 0 {
		p.ThumbMaxWidth = 320
	}

	sniffedMime := "application/octet-stream"
	if meta, serr := SniffImageMeta(sourceBytes); serr == nil {
		sniffedMime = mimeFromImageFormat(meta.Format)
	}
	inputMime := strings.TrimSpace(sourceMimeHint)
	if inputMime == "" {
		inputMime = sniffedMime
	}
	inputExt := extFromMime(inputMime)
	if inputExt == "" {
		inputExt = strings.ToLower(strings.TrimSpace(sourceExtHint))
	}
	if inputExt == "" {
		inputExt = "bin"
	}
	if inputExt == "jpeg" {
		inputExt = "jpg"
	}

	sourceFileName := p.SourceBaseName + "." + inputExt
	sourceAbs := filepath.Join(p.OutputDirAbs, sourceFileName)
	sourceRel := normDir + "/" + sourceFileName

	thumbAbs := filepath.Join(p.OutputDirAbs, p.ThumbFileName)
	thumbRel := normDir + "/" + p.ThumbFileName

	if err := os.MkdirAll(p.OutputDirAbs, 0o755); err != nil {
		return source, thumb, false, err
	}

	if !p.DoNotOverwrite || !fileExistsNonEmpty(sourceAbs) {
		if err := os.WriteFile(sourceAbs, sourceBytes, 0o644); err != nil {
			return source, thumb, false, err
		}
		changed = true
	}

	if !p.DoNotOverwrite || !fileExistsNonEmpty(thumbAbs) {
		thumbBytes, terr := GenerateCoverThumbWebP(sourceBytes, p.ThumbMaxWidth)
		if terr != nil {
			return source, thumb, false, terr
		}
		if err := os.WriteFile(thumbAbs, thumbBytes, 0o644); err != nil {
			return source, thumb, false, err
		}
		changed = true
	}

	sStat, err := os.Stat(sourceAbs)
	if err != nil {
		return source, thumb, false, err
	}
	tStat, err := os.Stat(thumbAbs)
	if err != nil {
		return source, thumb, false, err
	}

	source = StoredCoverInfo{
		RelativePath: sourceRel,
		AbsPath:      sourceAbs,
		MimeType:     inputMime,
		Extension:    inputExt,
		ByteLength:   sStat.Size(),
	}
	thumb = StoredCoverInfo{
		RelativePath: thumbRel,
		AbsPath:      thumbAbs,
		MimeType:     "image/webp",
		Extension:    "webp",
		ByteLength:   tStat.Size(),
	}
	return source, thumb, changed, nil
}

func fileExistsNonEmpty(absPath string) bool {
	st, err := os.Stat(absPath)
	return err == nil && !st.IsDir() && st.Size() > 0
}

func mimeFromImageFormat(format string) string {
	switch strings.ToLower(format) {
	case "jpeg", "jpg":
		return "image/jpeg"
	case "png":
		return "image/png"
	case "webp":
		return "image/webp"
	case "gif":
		return "image/gif"
	case "tiff", "tif":
		return "image/tiff"
	default:
		return "application/octet-stream"
	}
}

func extFromMime(mime string) string {
	m := strings.ToLower(mime)
	switch {
	case strings.Contains(m, "image/jpeg"), strings.Contains(m, "image/jpg"):
		return "jpg"
	case strings.Contains(m, "image/png"):
		return "png"
	case strings.Contains(m, "image/webp"):
		return "webp"
	case strings.Contains(m, "image/gif"):
		return "gif"
	case strings.Contains(m, "image/svg"):
		return "svg"
	case strings.Contains(m, "image/tiff"):
		return "tiff"
	default:
		return ""
	}
}

// readJPEGExifOrientation scans a JPEG byte stream for an APP1 EXIF Orientation tag (0x0112).
func readJPEGExifOrientation(data []byte) int {
	if len(data) < 12 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	pos := 2
	for pos+4 <= len(data) {
		if data[pos] != 0xFF {
			return 1
		}
		marker := data[pos+1]
		pos += 2
		if marker == 0xD9 || marker == 0xDA {
			return 1
		}
		if pos+2 > len(data) {
			return 1
		}
		segLen := int(binary.BigEndian.Uint16(data[pos : pos+2]))
		if segLen < 2 || pos+segLen > len(data) {
			return 1
		}
		if marker == 0xE1 && segLen >= 14 && bytes.Equal(data[pos+2:pos+8], []byte("Exif\x00\x00")) {
			tiffData := data[pos+8 : pos+segLen]
			return parseTiffOrientation(tiffData)
		}
		pos += segLen
	}
	return 1
}

func parseTiffOrientation(tiffData []byte) int {
	if len(tiffData) < 8 {
		return 1
	}
	var order binary.ByteOrder
	if tiffData[0] == 'I' && tiffData[1] == 'I' {
		order = binary.LittleEndian
	} else if tiffData[0] == 'M' && tiffData[1] == 'M' {
		order = binary.BigEndian
	} else {
		return 1
	}
	if order.Uint16(tiffData[2:4]) != 42 {
		return 1
	}
	ifdOffset := int(order.Uint32(tiffData[4:8]))
	if ifdOffset < 0 || ifdOffset+2 > len(tiffData) {
		return 1
	}
	count := int(order.Uint16(tiffData[ifdOffset : ifdOffset+2]))
	cur := ifdOffset + 2
	for i := 0; i < count && cur+12 <= len(tiffData); i++ {
		tag := order.Uint16(tiffData[cur : cur+2])
		if tag == 0x0112 {
			return int(order.Uint16(tiffData[cur+8 : cur+10]))
		}
		cur += 12
	}
	return 1
}

func applyExifOrientation(src image.Image, orient int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.NRGBA
	switch orient {
	case 2: // flip horizontal
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(w-1-x, y, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 3: // rotate 180
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(w-1-x, h-1-y, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 4: // flip vertical
		dst = image.NewNRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(x, h-1-y, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 5: // transpose
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(y, x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 6: // rotate 90 CW
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(h-1-y, x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 7: // transverse
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(h-1-y, w-1-x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	case 8: // rotate 270 CW
		dst = image.NewNRGBA(image.Rect(0, 0, h, w))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				dst.Set(y, w-1-x, src.At(b.Min.X+x, b.Min.Y+y))
			}
		}
	default:
		return src
	}
	return dst
}

// ValidateRasterImageForExternalFetch verifies JPEG/PNG/WebP format, enforces pixel limit,
// decodes pixels, and re-encodes to PNG.
func ValidateRasterImageForExternalFetch(input []byte, maxPixels int64, maxBytes int64) ([]byte, error) {
	meta, err := SniffImageMeta(input)
	if err != nil {
		return nil, errors.New("unsupported image")
	}
	if meta.Format != "jpeg" && meta.Format != "png" && meta.Format != "webp" {
		return nil, errors.New("unsupported image format")
	}
	if meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width)*int64(meta.Height) > maxPixels {
		return nil, errors.New("image pixel limit exceeded")
	}
	img, _, err := DecodeImageAndOrient(input)
	if err != nil {
		return nil, err
	}
	out, err := EncodePNG(img)
	if err != nil {
		return nil, err
	}
	if int64(len(out)) > maxBytes {
		return nil, httpapi.NewError(http.StatusRequestEntityTooLarge, "External image is too large")
	}
	return out, nil
}
