package bookshelf

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/google/uuid"
)

const (
	ShelfWidth        = 340
	ShelfCaseGap      = 10
	ShelfMinWidth     = 120
	ShelfMaxWidth     = 700
	ShelfFloor        = 14
	ShelfMinHeight    = 120
	ShelfMaxHeight    = 500
	BookshelfMaxBooks = 20000
	MaxShelfPictures  = 100
)

type BookDimensions struct {
	Width        int  `json:"width"`
	Height       int  `json:"height"`
	ManualWidth  bool `json:"manualWidth"`
	ManualHeight bool `json:"manualHeight"`
	SourcePages  *int `json:"sourcePages"`
}

type ShelfBook struct {
	ID           string `json:"id"`
	OffsetX      *int   `json:"offsetX,omitempty"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	ManualWidth  bool   `json:"manualWidth"`
	ManualHeight bool   `json:"manualHeight"`
	SourcePages  *int   `json:"sourcePages"`
}

type ShelfItem struct {
	X          int         `json:"x"`
	Horizontal bool        `json:"horizontal"`
	Books      []ShelfBook `json:"books"`
}

type Shelf struct {
	ID     string      `json:"id"`
	Height int         `json:"height"`
	Items  []ShelfItem `json:"items"`
}

type Bookcase struct {
	ID      string  `json:"id"`
	Width   int     `json:"width"`
	Shelves []Shelf `json:"shelves"`
}

type ShelfPicture struct {
	ID       string `json:"id"`
	AssetID  string `json:"assetId"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Rotation int    `json:"rotation"`
}

type Bookshelf struct {
	Bookcases []Bookcase     `json:"bookcases"`
	Version   int            `json:"version,omitempty"`
	Pictures  []ShelfPicture `json:"pictures"`
}

type ShelfCatalogBook struct {
	ID         string
	Pages      *int
	Dimensions *BookDimensions
}

type BookPlacementAnchor struct {
	CaseID     string `json:"caseId"`
	ShelfID    string `json:"shelfId"`
	StackID    string `json:"stackId"`
	X          int    `json:"x"`
	BookX      *int   `json:"bookX,omitempty"`
	Horizontal bool   `json:"horizontal"`
	Order      int    `json:"order"`
	Width      *int   `json:"width,omitempty"`
	Height     *int   `json:"height,omitempty"`
	Dormant    *bool  `json:"dormant,omitempty"`
}

type BookLayoutEntry struct {
	Book      ShelfBook
	Placement *BookPlacementAnchor
}

func EmptyShelf() Shelf {
	return Shelf{
		ID:     uuid.NewString(),
		Height: 245,
		Items:  []ShelfItem{},
	}
}

func EmptyBookshelf() *Bookshelf {
	return &Bookshelf{
		Version:  2,
		Pictures: []ShelfPicture{},
		Bookcases: []Bookcase{
			{
				ID:      uuid.NewString(),
				Width:   ShelfWidth,
				Shelves: []Shelf{EmptyShelf(), EmptyShelf(), EmptyShelf()},
			},
		},
	}
}

func CloneBookshelf(b *Bookshelf) *Bookshelf {
	if b == nil {
		return nil
	}
	pics := make([]ShelfPicture, len(b.Pictures))
	copy(pics, b.Pictures)
	cases := make([]Bookcase, len(b.Bookcases))
	for i, c := range b.Bookcases {
		shelves := make([]Shelf, len(c.Shelves))
		for j, s := range c.Shelves {
			items := make([]ShelfItem, len(s.Items))
			for k, it := range s.Items {
				books := make([]ShelfBook, len(it.Books))
				for l, bk := range it.Books {
					books[l] = cloneShelfBook(bk)
				}
				items[k] = ShelfItem{
					X:          it.X,
					Horizontal: it.Horizontal,
					Books:      books,
				}
			}
			shelves[j] = Shelf{
				ID:     s.ID,
				Height: s.Height,
				Items:  items,
			}
		}
		cases[i] = Bookcase{
			ID:      c.ID,
			Width:   c.Width,
			Shelves: shelves,
		}
	}
	return &Bookshelf{
		Bookcases: cases,
		Version:   b.Version,
		Pictures:  pics,
	}
}

func cloneShelfBook(b ShelfBook) ShelfBook {
	out := b
	if b.OffsetX != nil {
		v := *b.OffsetX
		out.OffsetX = &v
	}
	if b.SourcePages != nil {
		v := *b.SourcePages
		out.SourcePages = &v
	}
	return out
}

func BookshelfGeometry(layout *Bookshelf) *Bookshelf {
	pics := make([]ShelfPicture, len(layout.Pictures))
	copy(pics, layout.Pictures)
	cases := make([]Bookcase, len(layout.Bookcases))
	for i, c := range layout.Bookcases {
		shelves := make([]Shelf, len(c.Shelves))
		for j, s := range c.Shelves {
			shelves[j] = Shelf{
				ID:     s.ID,
				Height: s.Height,
				Items:  []ShelfItem{},
			}
		}
		cases[i] = Bookcase{
			ID:      c.ID,
			Width:   c.Width,
			Shelves: shelves,
		}
	}
	return &Bookshelf{
		Version:   layout.Version,
		Pictures:  pics,
		Bookcases: cases,
	}
}

func ItemWidth(item ShelfItem) int {
	maxW := 0
	for _, b := range item.Books {
		w := b.Width
		if item.Horizontal {
			ox := 0
			if b.OffsetX != nil {
				ox = *b.OffsetX
			}
			w = ox + b.Height
		}
		if w > maxW {
			maxW = w
		}
	}
	return maxW
}

func ItemHeight(item ShelfItem) int {
	if item.Horizontal {
		sum := 0
		for _, b := range item.Books {
			sum += b.Width
		}
		return sum
	}
	if len(item.Books) == 0 {
		return 0
	}
	return item.Books[0].Height
}

func NormalizedPages(pages *int) *int {
	if pages == nil || *pages < 0 || *pages > 1000000 {
		return nil
	}
	v := *pages
	return &v
}

func EstimatedWidth(pages *int) int {
	if pages != nil && *pages > 0 {
		w := int(math.Floor(20.0 + float64(*pages)/25.0 + 0.5))
		if w < 22 {
			return 22
		}
		if w > 55 {
			return 55
		}
		return w
	}
	return 32
}

func StableHeight(id string) int {
	var hash uint32
	for _, r := range id {
		u := uint32(r)
		if r > 0xFFFF {
			r1, _ := utf16.EncodeRune(r)
			u = uint32(r1)
		}
		hash = hash*31 + u
	}
	return 180 + int(hash%41)
}

func equalIntPtr(a, b *int) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func intPtr(v int) *int {
	return &v
}

func parseIntRange(v any, minVal, maxVal int) (int, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, false
	}
	if f < float64(minVal) || f > float64(maxVal) {
		return 0, false
	}
	return int(f), true
}

func parseSafeNonNegInt(raw json.RawMessage) (int, bool) {
	if len(raw) == 0 {
		return 0, false
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, false
	}
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, false
	}
	// JavaScript Number.MAX_SAFE_INTEGER = 2^53 - 1
	if f < 0 || f > 9007199254740991 {
		return 0, false
	}
	return int(f), true
}

func parseID(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) == 0 || len(s) > 128 {
		return "", false
	}
	return s, true
}

// RawHasVersion2 inspects a raw JSON value (before ParseBookshelf normalization)
// to see if it is an object with `"version": 2`.
func RawHasVersion2(raw []byte) bool {
	if len(raw) == 0 {
		return false
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil || obj == nil {
		return false
	}
	v, ok := obj["version"]
	if !ok {
		return false
	}
	n, ok := parseIntRange(v, 2, 2)
	return ok && n == 2
}

// ParseBookshelfJSON validates a JSON-encoded bookshelf arrangement and normalizes
// it identically to shared/bookshelf.ts parseBookshelf.
func ParseBookshelfJSON(raw []byte) *Bookshelf {
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil
	}
	return ParseBookshelfValue(root)
}

// ParseBookshelfStruct validates an already-constructed Bookshelf.
func ParseBookshelfStruct(b *Bookshelf) *Bookshelf {
	if b == nil {
		return nil
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return nil
	}
	return ParseBookshelfJSON(raw)
}

// ParseBookshelfValue mirrors shared/bookshelf.ts parseBookshelf.
func ParseBookshelfValue(root any) *Bookshelf {
	obj, ok := root.(map[string]any)
	if !ok || obj == nil {
		return nil
	}
	rawCases, ok := obj["bookcases"].([]any)
	if !ok || len(rawCases) < 1 || len(rawCases) > 1000 {
		return nil
	}
	if v, exists := obj["version"]; exists {
		if n, ok := parseIntRange(v, 2, 2); !ok || n != 2 {
			return nil
		}
	}

	pictures := []ShelfPicture{}
	pictureIDs := map[string]struct{}{}
	if rawPicsVal, exists := obj["pictures"]; exists {
		rawPics, ok := rawPicsVal.([]any)
		if !ok {
			return nil
		}
		for _, rp := range rawPics {
			pm, ok := rp.(map[string]any)
			if !ok || pm == nil {
				return nil
			}
			pid, ok := parseID(pm["id"])
			if !ok {
				return nil
			}
			if _, dup := pictureIDs[pid]; dup {
				return nil
			}
			assetID, ok := parseID(pm["assetId"])
			if !ok {
				return nil
			}
			px, ok := parseIntRange(pm["x"], -100000, 100000)
			if !ok {
				return nil
			}
			py, ok := parseIntRange(pm["y"], -100000, 100000)
			if !ok {
				return nil
			}
			pw, ok := parseIntRange(pm["width"], 10, 4000)
			if !ok {
				return nil
			}
			ph, ok := parseIntRange(pm["height"], 10, 4000)
			if !ok {
				return nil
			}
			rot, ok := parseIntRange(pm["rotation"], -180, 180)
			if !ok {
				return nil
			}
			if len(pictures) >= MaxShelfPictures {
				return nil
			}
			pictureIDs[pid] = struct{}{}
			pictures = append(pictures, ShelfPicture{
				ID:       pid,
				AssetID:  assetID,
				X:        px,
				Y:        py,
				Width:    pw,
				Height:   ph,
				Rotation: rot,
			})
		}
	}

	result := &Bookshelf{
		Bookcases: make([]Bookcase, 0, len(rawCases)),
		Version:   2,
		Pictures:  pictures,
	}
	ids := map[string]struct{}{}
	bookIDs := map[string]struct{}{}
	totalBooks := 0

	for _, rc := range rawCases {
		cm, ok := rc.(map[string]any)
		if !ok || cm == nil {
			return nil
		}
		cid, ok := parseID(cm["id"])
		if !ok {
			return nil
		}
		if _, dup := ids[cid]; dup {
			return nil
		}
		rawShelves, ok := cm["shelves"].([]any)
		if !ok || len(rawShelves) < 1 || len(rawShelves) > 1000 {
			return nil
		}
		ids[cid] = struct{}{}

		maxLegacyW := 0
		for _, rs := range rawShelves {
			sm, ok := rs.(map[string]any)
			if !ok || sm == nil {
				return nil
			}
			w := ShelfWidth
			if lw, exists := sm["width"]; exists {
				parsedW, ok := parseIntRange(lw, ShelfMinWidth, ShelfMaxWidth)
				if !ok {
					return nil
				}
				w = parsedW
			}
			if w > maxLegacyW {
				maxLegacyW = w
			}
		}

		caseWidth := maxLegacyW
		if cw, exists := cm["width"]; exists {
			parsedW, ok := parseIntRange(cw, ShelfMinWidth, ShelfMaxWidth)
			if !ok {
				return nil
			}
			caseWidth = parsedW
		}

		bc := Bookcase{
			ID:      cid,
			Width:   caseWidth,
			Shelves: make([]Shelf, 0, len(rawShelves)),
		}

		for _, rs := range rawShelves {
			sm, ok := rs.(map[string]any)
			if !ok || sm == nil {
				return nil
			}
			sid, ok := parseID(sm["id"])
			if !ok {
				return nil
			}
			if _, dup := ids[sid]; dup {
				return nil
			}
			sh, ok := parseIntRange(sm["height"], ShelfMinHeight, ShelfMaxHeight)
			if !ok {
				return nil
			}
			rawItems, ok := sm["items"].([]any)
			if !ok {
				return nil
			}
			ids[sid] = struct{}{}

			s := Shelf{
				ID:     sid,
				Height: sh,
				Items:  make([]ShelfItem, 0, len(rawItems)),
			}

			for _, ri := range rawItems {
				im, ok := ri.(map[string]any)
				if !ok || im == nil {
					return nil
				}
				ix, ok := parseIntRange(im["x"], 2, bc.Width-2)
				if !ok {
					return nil
				}
				horiz, ok := im["horizontal"].(bool)
				if !ok {
					return nil
				}
				rawBooks, ok := im["books"].([]any)
				if !ok || len(rawBooks) == 0 || (!horiz && len(rawBooks) != 1) {
					return nil
				}

				it := ShelfItem{
					X:          ix,
					Horizontal: horiz,
					Books:      make([]ShelfBook, 0, len(rawBooks)),
				}

				for _, rb := range rawBooks {
					bm, ok := rb.(map[string]any)
					if !ok || bm == nil {
						return nil
					}
					bid, ok := parseID(bm["id"])
					if !ok {
						return nil
					}
					if _, dup := bookIDs[bid]; dup {
						return nil
					}
					bw, ok := parseIntRange(bm["width"], 20, 55)
					if !ok {
						return nil
					}
					bh, ok := parseIntRange(bm["height"], 120, 230)
					if !ok {
						return nil
					}
					mw, ok := bm["manualWidth"].(bool)
					if !ok {
						return nil
					}
					mh, ok := bm["manualHeight"].(bool)
					if !ok {
						return nil
					}

					var offsetX *int
					if oxRaw, exists := bm["offsetX"]; exists {
						ox, ok := parseIntRange(oxRaw, 0, ShelfMaxWidth)
						if !ok {
							return nil
						}
						offsetX = &ox
					}
					if !horiz && offsetX != nil && *offsetX != 0 {
						return nil
					}

					var sourcePages *int
					spRaw, hasSP := bm["sourcePages"]
					if !hasSP {
						return nil
					}
					if spRaw != nil {
						sp, ok := parseIntRange(spRaw, 0, 1000000)
						if !ok {
							return nil
						}
						sourcePages = &sp
					}

					bookIDs[bid] = struct{}{}
					totalBooks++
					if totalBooks > BookshelfMaxBooks {
						return nil
					}

					it.Books = append(it.Books, ShelfBook{
						ID:           bid,
						OffsetX:      offsetX,
						Width:        bw,
						Height:       bh,
						ManualWidth:  mw,
						ManualHeight: mh,
						SourcePages:  sourcePages,
					})
				}

				if it.X+ItemWidth(it) > bc.Width-2 || ItemHeight(it) > s.Height-ShelfFloor {
					return nil
				}
				s.Items = append(s.Items, it)
			}

			sort.SliceStable(s.Items, func(i, j int) bool {
				return s.Items[i].X < s.Items[j].X
			})
			for i := 1; i < len(s.Items); i++ {
				if s.Items[i-1].X+ItemWidth(s.Items[i-1]) > s.Items[i].X {
					return nil
				}
			}
			bc.Shelves = append(bc.Shelves, s)
		}
		result.Bookcases = append(result.Bookcases, bc)
	}
	return result
}

// ReconcileBookshelf mirrors shared/bookshelf.ts reconcileBookshelf.
func ReconcileBookshelf(value *Bookshelf, catalog []ShelfCatalogBook) (bookshelf *Bookshelf, needsAdjustment []string, changed bool) {
	bs := CloneBookshelf(value)
	visible := make(map[string]ShelfCatalogBook, len(catalog))
	for _, c := range catalog {
		visible[c.ID] = c
	}
	found := make(map[string]struct{}, len(catalog))
	needsAdjustment = []string{}

	for bi := range bs.Bookcases {
		bc := &bs.Bookcases[bi]
		for si := range bc.Shelves {
			sh := &bc.Shelves[si]
			for ii := range sh.Items {
				it := &sh.Items[ii]
				prevLen := len(it.Books)
				kept := make([]ShelfBook, 0, len(it.Books))
				for _, bk := range it.Books {
					if _, ok := visible[bk.ID]; ok {
						kept = append(kept, bk)
					}
				}
				it.Books = kept
				if prevLen != len(it.Books) {
					changed = true
				}
				for bki := range it.Books {
					bk := &it.Books[bki]
					found[bk.ID] = struct{}{}
					cat := visible[bk.ID]
					pages := NormalizedPages(cat.Pages)
					if !bk.ManualWidth && !equalIntPtr(bk.SourcePages, pages) {
						old := bk.Width
						bk.Width = EstimatedWidth(pages)
						nonEmpty := make([]ShelfItem, 0, len(sh.Items))
						for _, other := range sh.Items {
							if len(other.Books) > 0 {
								nonEmpty = append(nonEmpty, other)
							}
						}
						sort.SliceStable(nonEmpty, func(i, j int) bool {
							return nonEmpty[i].X < nonEmpty[j].X
						})
						fits := ItemHeight(*it) <= sh.Height-ShelfFloor
						if fits {
							for idx, cur := range nonEmpty {
								if cur.X+ItemWidth(cur) > bc.Width-2 {
									fits = false
									break
								}
								if idx > 0 && nonEmpty[idx-1].X+ItemWidth(nonEmpty[idx-1]) > cur.X {
									fits = false
									break
								}
							}
						}
						if fits {
							bk.SourcePages = pages
							changed = true
						} else {
							bk.Width = old
							needsAdjustment = append(needsAdjustment, bk.ID)
						}
					}
				}
			}
			filteredItems := make([]ShelfItem, 0, len(sh.Items))
			for _, it := range sh.Items {
				if len(it.Books) > 0 {
					filteredItems = append(filteredItems, it)
				}
			}
			sh.Items = filteredItems
		}
	}

	type shelfRef struct {
		caseIdx  int
		shelfIdx int
	}
	var shelves []shelfRef
	for bi := range bs.Bookcases {
		for si := range bs.Bookcases[bi].Shelves {
			shelves = append(shelves, shelfRef{caseIdx: bi, shelfIdx: si})
		}
	}
	appendIndex := 0
	for i := len(shelves) - 1; i >= 0; i-- {
		ref := shelves[i]
		if len(bs.Bookcases[ref.caseIdx].Shelves[ref.shelfIdx].Items) > 0 {
			appendIndex = i
			break
		}
	}

	for _, cat := range catalog {
		if _, ok := found[cat.ID]; ok {
			continue
		}
		var newBook ShelfBook
		if cat.Dimensions != nil {
			newBook = ShelfBook{
				ID:           cat.ID,
				Width:        cat.Dimensions.Width,
				Height:       cat.Dimensions.Height,
				ManualWidth:  cat.Dimensions.ManualWidth,
				ManualHeight: cat.Dimensions.ManualHeight,
				SourcePages:  NormalizedPages(cat.Dimensions.SourcePages),
			}
		} else {
			pages := NormalizedPages(cat.Pages)
			newBook = ShelfBook{
				ID:           cat.ID,
				Width:        EstimatedWidth(pages),
				Height:       StableHeight(cat.ID),
				ManualWidth:  false,
				ManualHeight: false,
				SourcePages:  pages,
			}
		}
		pages := NormalizedPages(cat.Pages)
		if !newBook.ManualWidth && !equalIntPtr(newBook.SourcePages, pages) {
			newBook.Width = EstimatedWidth(pages)
			newBook.SourcePages = pages
		}
		item := ShelfItem{
			X:          2,
			Horizontal: false,
			Books:      []ShelfBook{newBook},
		}

		for {
			if appendIndex >= len(shelves) {
				nextCase := Bookcase{
					ID:      uuid.NewString(),
					Width:   ShelfWidth,
					Shelves: []Shelf{EmptyShelf(), EmptyShelf(), EmptyShelf()},
				}
				ci := len(bs.Bookcases)
				bs.Bookcases = append(bs.Bookcases, nextCase)
				for si := range nextCase.Shelves {
					shelves = append(shelves, shelfRef{caseIdx: ci, shelfIdx: si})
				}
			}
			ref := shelves[appendIndex]
			bc := &bs.Bookcases[ref.caseIdx]
			sh := &bc.Shelves[ref.shelfIdx]
			lastX := 2
			for _, entry := range sh.Items {
				if end := entry.X + ItemWidth(entry); end > lastX {
					lastX = end
				}
			}
			if lastX+ItemWidth(item) <= bc.Width-2 && ItemHeight(item) <= sh.Height-ShelfFloor {
				item.X = lastX
				sh.Items = append(sh.Items, item)
				changed = true
				break
			}
			appendIndex++
		}
	}

	return bs, needsAdjustment, changed
}

// ParsePlacement mirrors server/utils/shelves/model.ts parsePlacement.
func ParsePlacement(raw []byte) *BookPlacementAnchor {
	if len(raw) == 0 {
		return nil
	}
	var root any
	if err := json.Unmarshal(raw, &root); err != nil {
		return nil
	}
	m, ok := root.(map[string]any)
	if !ok || m == nil {
		return nil
	}
	caseID, ok := m["caseId"].(string)
	if !ok {
		return nil
	}
	shelfID, ok := m["shelfId"].(string)
	if !ok {
		return nil
	}
	stackID, ok := m["stackId"].(string)
	if !ok {
		return nil
	}
	x, ok := parseIntRange(m["x"], -9007199254740991, 9007199254740991)
	if !ok {
		return nil
	}
	horiz, ok := m["horizontal"].(bool)
	if !ok {
		return nil
	}
	order, ok := parseIntRange(m["order"], -9007199254740991, 9007199254740991)
	if !ok {
		return nil
	}
	out := &BookPlacementAnchor{
		CaseID:     caseID,
		ShelfID:    shelfID,
		StackID:    stackID,
		X:          x,
		Horizontal: horiz,
		Order:      order,
	}
	if bxRaw, exists := m["bookX"]; exists {
		if bx, ok := parseIntRange(bxRaw, -9007199254740991, 9007199254740991); ok {
			out.BookX = &bx
		}
	}
	if wRaw, exists := m["width"]; exists {
		if f, ok := wRaw.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			w := int(f)
			out.Width = &w
		}
	}
	if hRaw, exists := m["height"]; exists {
		if f, ok := hRaw.(float64); ok && !math.IsNaN(f) && !math.IsInf(f, 0) {
			h := int(f)
			out.Height = &h
		}
	}
	if dRaw, exists := m["dormant"]; exists {
		if d, ok := dRaw.(bool); ok {
			out.Dormant = &d
		}
	}
	return out
}

func placementBookX(p *BookPlacementAnchor) int {
	if p.BookX != nil {
		return *p.BookX
	}
	return p.X
}

// ComposeBookshelfLayout mirrors shared/bookshelf-layout.ts composeBookshelfLayout.
func ComposeBookshelfLayout(rawGeometry []byte, members []BookLayoutEntry, shelfID string) (*Bookshelf, []string, error) {
	geometry := ParseBookshelfJSON(rawGeometry)
	if geometry == nil {
		return nil, nil, errors.New("Invalid bookshelf geometry")
	}
	for _, c := range geometry.Bookcases {
		for _, s := range c.Shelves {
			if len(s.Items) > 0 {
				return nil, nil, errors.New("Invalid bookshelf geometry")
			}
		}
	}

	result := BookshelfGeometry(geometry)
	adjustments := []string{}

	type groupKey struct {
		caseID  string
		shelfID string
		stackID string
	}
	groups := make(map[groupKey][]BookLayoutEntry)
	groupOrder := make([]groupKey, 0)
	pending := make([]BookLayoutEntry, 0)

	for _, member := range members {
		if member.Placement == nil {
			pending = append(pending, member)
			continue
		}
		k := groupKey{
			caseID:  member.Placement.CaseID,
			shelfID: member.Placement.ShelfID,
			stackID: member.Placement.StackID,
		}
		if _, exists := groups[k]; !exists {
			groupOrder = append(groupOrder, k)
		}
		groups[k] = append(groups[k], member)
	}

	type rowRef struct {
		caseIdx  int
		shelfIdx int
	}
	type rowKey struct {
		caseID  string
		shelfID string
	}
	rows := make([]rowRef, 0)
	rowIndexes := make(map[rowKey]int)
	for bi := range result.Bookcases {
		for si := range result.Bookcases[bi].Shelves {
			idx := len(rows)
			rows = append(rows, rowRef{caseIdx: bi, shelfIdx: si})
			rowIndexes[rowKey{caseID: result.Bookcases[bi].ID, shelfID: result.Bookcases[bi].Shelves[si].ID}] = idx
		}
	}

	isDisplaced := func(m BookLayoutEntry) bool {
		p := m.Placement
		if p == nil {
			return false
		}
		if p.Dormant != nil && *p.Dormant {
			return true
		}
		if p.Width != nil && *p.Width != m.Book.Width {
			return true
		}
		if p.Height != nil && *p.Height != m.Book.Height {
			return true
		}
		return false
	}

	orderedGroups := make([][]BookLayoutEntry, 0, len(groupOrder))
	for _, k := range groupOrder {
		orderedGroups = append(orderedGroups, groups[k])
	}

	groupPriority := func(g []BookLayoutEntry) int {
		for _, m := range g {
			if isDisplaced(m) {
				return 1
			}
		}
		return 0
	}
	groupRowIndex := func(p *BookPlacementAnchor) int {
		if idx, ok := rowIndexes[rowKey{caseID: p.CaseID, shelfID: p.ShelfID}]; ok {
			return idx
		}
		return -1
	}
	groupMinX := func(g []BookLayoutEntry) int {
		minX := placementBookX(g[0].Placement)
		for _, m := range g[1:] {
			if bx := placementBookX(m.Placement); bx < minX {
				minX = bx
			}
		}
		return minX
	}

	sort.SliceStable(orderedGroups, func(i, j int) bool {
		a, b := orderedGroups[i], orderedGroups[j]
		pa, pb := groupPriority(a), groupPriority(b)
		if pa != pb {
			return pa < pb
		}
		ra, rb := groupRowIndex(a[0].Placement), groupRowIndex(b[0].Placement)
		if ra != rb {
			return ra < rb
		}
		xa, xb := groupMinX(a), groupMinX(b)
		if xa != xb {
			return xa < xb
		}
		return strings.Compare(a[0].Placement.StackID, b[0].Placement.StackID) < 0
	})

	for _, group := range orderedGroups {
		sort.SliceStable(group, func(i, j int) bool {
			if group[i].Placement.Order != group[j].Placement.Order {
				return group[i].Placement.Order < group[j].Placement.Order
			}
			return strings.Compare(group[i].Book.ID, group[j].Book.ID) < 0
		})
		p := group[0].Placement
		rIdx, exists := rowIndexes[rowKey{caseID: p.CaseID, shelfID: p.ShelfID}]
		mismatchHoriz := false
		for _, m := range group {
			if m.Placement.Horizontal != p.Horizontal {
				mismatchHoriz = true
				break
			}
		}
		if !exists || mismatchHoriz || (!p.Horizontal && len(group) > 1) {
			pending = append(pending, group...)
			continue
		}
		ref := rows[rIdx]
		bc := &result.Bookcases[ref.caseIdx]
		row := &bc.Shelves[ref.shelfIdx]

		left := groupMinX(group)
		books := make([]ShelfBook, len(group))
		for idx, m := range group {
			bk := cloneShelfBook(m.Book)
			if p.Horizontal {
				bk.OffsetX = intPtr(placementBookX(m.Placement) - left)
			} else {
				bk.OffsetX = intPtr(0)
			}
			books[idx] = bk
		}
		item := ShelfItem{
			X:          left,
			Horizontal: p.Horizontal,
			Books:      books,
		}

		fits := func(cand ShelfItem) bool {
			if cand.X < 2 || cand.X+ItemWidth(cand) > bc.Width-2 || ItemHeight(cand) > row.Height-ShelfFloor {
				return false
			}
			candEnd := cand.X + ItemWidth(cand)
			for _, other := range row.Items {
				if cand.X < other.X+ItemWidth(other) && other.X < candEnd {
					return false
				}
			}
			return true
		}

		if !fits(item) {
			var unchanged, changed []BookLayoutEntry
			unchangedSet := make(map[string]struct{})
			for _, m := range group {
				if isDisplaced(m) {
					changed = append(changed, m)
				} else {
					unchanged = append(unchanged, m)
					unchangedSet[m.Book.ID] = struct{}{}
				}
			}
			remBooks := make([]ShelfBook, 0, len(unchanged))
			for _, bk := range item.Books {
				if _, ok := unchangedSet[bk.ID]; ok {
					remBooks = append(remBooks, bk)
				}
			}
			remaining := ShelfItem{
				X:          item.X,
				Horizontal: item.Horizontal,
				Books:      remBooks,
			}
			if len(unchanged) > 0 && len(changed) > 0 && fits(remaining) {
				row.Items = append(row.Items, remaining)
				pending = append(pending, changed...)
			} else {
				pending = append(pending, group...)
			}
		} else {
			row.Items = append(row.Items, item)
		}
	}

	knownIDs := make(map[string]struct{})
	for _, c := range result.Bookcases {
		knownIDs[c.ID] = struct{}{}
		for _, s := range c.Shelves {
			knownIDs[s.ID] = struct{}{}
		}
	}
	generated := 0
	nextID := func(kind string) string {
		for {
			id := fmt.Sprintf("personal-%s-%s-%d", shelfID, kind, generated)
			generated++
			if _, exists := knownIDs[id]; !exists {
				knownIDs[id] = struct{}{}
				return id
			}
		}
	}

	appendIndex := 0
	for i := len(rows) - 1; i >= 0; i-- {
		ref := rows[i]
		if len(result.Bookcases[ref.caseIdx].Shelves[ref.shelfIdx].Items) > 0 {
			appendIndex = i
			break
		}
	}

	for _, member := range pending {
		bk := cloneShelfBook(member.Book)
		bk.OffsetX = intPtr(0)
		item := ShelfItem{
			X:          2,
			Horizontal: false,
			Books:      []ShelfBook{bk},
		}
		placed := false
		for appendIndex < len(rows) {
			ref := rows[appendIndex]
			bc := &result.Bookcases[ref.caseIdx]
			row := &bc.Shelves[ref.shelfIdx]
			x := 2
			for _, existing := range row.Items {
				if end := existing.X + ItemWidth(existing); end > x {
					x = end
				}
			}
			if x+ItemWidth(item) <= bc.Width-2 && ItemHeight(item) <= row.Height-ShelfFloor {
				item.X = x
				row.Items = append(row.Items, item)
				placed = true
				break
			}
			appendIndex++
		}
		if !placed {
			newCase := Bookcase{
				ID:    nextID("case"),
				Width: ShelfWidth,
				Shelves: []Shelf{
					{ID: nextID("row"), Height: 245, Items: []ShelfItem{item}},
					{ID: nextID("row"), Height: 245, Items: []ShelfItem{}},
					{ID: nextID("row"), Height: 245, Items: []ShelfItem{}},
				},
			}
			ci := len(result.Bookcases)
			result.Bookcases = append(result.Bookcases, newCase)
			for si := range newCase.Shelves {
				rows = append(rows, rowRef{caseIdx: ci, shelfIdx: si})
			}
		}
		if member.Placement != nil {
			adjustments = append(adjustments, member.Book.ID)
		}
	}

	if ParseBookshelfStruct(result) == nil {
		return nil, nil, errors.New("The bookshelf cannot fit its books")
	}
	return result, adjustments, nil
}
