package spines

import (
	"errors"
	"math"

	"github.com/lancewilhelm/delb/internal/books"
)

const (
	SpineMaxBytes          = 10 * 1024 * 1024
	SpineMaxPixels         = 24_000_000
	SpineStretchWidth      = 256
	SpineStretchHeight     = 768
	MiniSpineStretchWidth  = 360
	MiniSpineStretchHeight = 1080
	SpineMaxFitWidth       = 512
	SpineMaxFitHeight      = 1600
	ReferenceMaxDimension  = 2048
)

type SpineEdits struct {
	Left    float64 `json:"left"`
	Right   float64 `json:"right"`
	Top     float64 `json:"top"`
	Bottom  float64 `json:"bottom"`
	Stretch bool    `json:"stretch"`
}

func DefaultSpineEdits() SpineEdits {
	return SpineEdits{
		Left:    0,
		Right:   0,
		Top:     0,
		Bottom:  0,
		Stretch: false,
	}
}

func validPercent(v any) (float64, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 90 {
		return 0, false
	}
	return f, true
}

// ParseSpineEdits mirrors shared/spine-artwork.ts parseSpineEdits.
func ParseSpineEdits(raw any) (*SpineEdits, bool) {
	m, ok := raw.(map[string]any)
	if !ok || m == nil {
		return nil, false
	}
	left, ok := validPercent(m["left"])
	if !ok {
		return nil, false
	}
	right, ok := validPercent(m["right"])
	if !ok {
		return nil, false
	}
	top, ok := validPercent(m["top"])
	if !ok {
		return nil, false
	}
	bottom, ok := validPercent(m["bottom"])
	if !ok {
		return nil, false
	}
	stretch, ok := m["stretch"].(bool)
	if !ok {
		return nil, false
	}
	if left+right > 95 || top+bottom > 95 {
		return nil, false
	}
	return &SpineEdits{
		Left:    left,
		Right:   right,
		Top:     top,
		Bottom:  bottom,
		Stretch: stretch,
	}, true
}

// RenderSpine mirrors server/utils/books/spine-image.ts renderSpine using pure Go.
func RenderSpine(raw []byte, edits SpineEdits) (webpBytes []byte, contentType string, err error) {
	return renderSpineWithTarget(raw, edits, SpineStretchWidth, SpineStretchHeight)
}

// RenderMiniSpine renders a dedicated mini-cover spine image in WebP format
// with enough resolution for 600 dpi 10x30 mm prints.
func RenderMiniSpine(raw []byte, edits SpineEdits) (webpBytes []byte, contentType string, err error) {
	return renderSpineWithTarget(raw, edits, MiniSpineStretchWidth, MiniSpineStretchHeight)
}

func renderSpineWithTarget(raw []byte, edits SpineEdits, stretchW, stretchH int) (webpBytes []byte, contentType string, err error) {
	if len(raw) == 0 || len(raw) > SpineMaxBytes {
		return nil, "", errors.New("Invalid image size")
	}
	meta, err := books.SniffImageMeta(raw)
	if err != nil {
		return nil, "", errors.New("Unsupported image")
	}
	switch meta.Format {
	case "jpeg":
		contentType = "image/jpeg"
	case "png":
		contentType = "image/png"
	case "webp":
		contentType = "image/webp"
	default:
		return nil, "", errors.New("Unsupported image")
	}
	if meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width)*int64(meta.Height) > SpineMaxPixels {
		return nil, "", errors.New("Image exceeds pixel limit")
	}
	if books.IsAnimatedImage(raw, meta.Format) {
		return nil, "", errors.New("Unsupported animated image")
	}

	img, _, err := books.DecodeImageAndOrient(raw)
	if err != nil {
		return nil, "", err
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, "", errors.New("Missing image dimensions")
	}

	left := int(math.Floor(float64(w) * edits.Left / 100.0))
	top := int(math.Floor(float64(h) * edits.Top / 100.0))
	right := int(math.Floor(float64(w) * edits.Right / 100.0))
	bottom := int(math.Floor(float64(h) * edits.Bottom / 100.0))
	cropW := w - left - right
	cropH := h - top - bottom

	cropped, err := books.CropImage(img, left, top, cropW, cropH)
	if err != nil {
		return nil, "", err
	}

	var resized = books.ResizeInsideNoEnlarge(cropped, SpineMaxFitWidth, SpineMaxFitHeight)
	if edits.Stretch {
		resized = books.ResizeExactFill(cropped, stretchW, stretchH)
	}

	out, err := books.EncodeWebP(resized)
	if err != nil {
		return nil, "", err
	}
	return out, contentType, nil
}

// NormalizeReferenceImage mirrors normalize() in server/api/books/[id]/spine-generate/index.post.ts.
func NormalizeReferenceImage(raw []byte) ([]byte, error) {
	if len(raw) == 0 || len(raw) > SpineMaxBytes {
		return nil, errors.New("Image too large")
	}
	meta, err := books.SniffImageMeta(raw)
	if err != nil {
		return nil, errors.New("Unsupported image")
	}
	switch meta.Format {
	case "jpeg", "png", "webp", "tiff", "gif":
	default:
		return nil, errors.New("Unsupported image")
	}
	if meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width)*int64(meta.Height) > SpineMaxPixels {
		return nil, errors.New("Image exceeds pixel limit")
	}
	if books.IsAnimatedImage(raw, meta.Format) {
		return nil, errors.New("Unsupported animated image")
	}

	img, _, err := books.DecodeImageAndOrient(raw)
	if err != nil {
		return nil, err
	}
	resized := books.ResizeInsideNoEnlarge(img, ReferenceMaxDimension, ReferenceMaxDimension)
	return books.EncodePNG(resized)
}

func SniffOutputMime(raw []byte) string {
	meta, err := books.SniffImageMeta(raw)
	if err != nil {
		return "image/png"
	}
	switch meta.Format {
	case "jpeg":
		return "image/jpeg"
	case "webp":
		return "image/webp"
	default:
		return "image/png"
	}
}
