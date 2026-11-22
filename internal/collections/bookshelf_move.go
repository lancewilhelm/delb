package collections

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"sort"

	"github.com/google/uuid"
)

const (
	shelfWidth        = 340
	shelfMinWidth     = 120
	shelfMaxWidth     = 700
	shelfFloor        = 14
	shelfMinHeight    = 120
	shelfMaxHeight    = 500
	bookshelfMaxBooks = 20000
)

type shelfBook struct {
	ID           string `json:"id"`
	OffsetX      *int   `json:"offsetX,omitempty"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
	ManualWidth  bool   `json:"manualWidth"`
	ManualHeight bool   `json:"manualHeight"`
	SourcePages  *int   `json:"sourcePages"`
}

type shelfItem struct {
	X          int         `json:"x"`
	Horizontal bool        `json:"horizontal"`
	Books      []shelfBook `json:"books"`
}

type shelf struct {
	ID     string      `json:"id"`
	Height int         `json:"height"`
	Items  []shelfItem `json:"items"`
}

type bookcase struct {
	ID      string  `json:"id"`
	Width   int     `json:"width"`
	Shelves []shelf `json:"shelves"`
}

type shelfPicture struct {
	ID       string `json:"id"`
	AssetID  string `json:"assetId"`
	X        int    `json:"x"`
	Y        int    `json:"y"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
	Rotation int    `json:"rotation"`
}

type bookshelf struct {
	Bookcases []bookcase     `json:"bookcases"`
	Version   int            `json:"version,omitempty"`
	Pictures  []shelfPicture `json:"pictures"`
}

func emptyShelf() shelf {
	return shelf{
		ID:     uuid.NewString(),
		Height: 245,
		Items:  []shelfItem{},
	}
}

func emptyBookshelf() *bookshelf {
	return &bookshelf{
		Version:  2,
		Pictures: []shelfPicture{},
		Bookcases: []bookcase{
			{
				ID:      uuid.NewString(),
				Width:   shelfWidth,
				Shelves: []shelf{emptyShelf(), emptyShelf(), emptyShelf()},
			},
		},
	}
}

func itemWidth(item shelfItem) int {
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

func itemHeight(item shelfItem) int {
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

func parseIntRange(v any, minVal, maxVal int) (int, bool) {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, false
	}
	n := int(f)
	if n < minVal || n > maxVal {
		return 0, false
	}
	return n, true
}

func parseID(v any) (string, bool) {
	s, ok := v.(string)
	if !ok || len(s) == 0 || len(s) > 128 {
		return "", false
	}
	return s, true
}

// parseBookshelf mirrors shared/bookshelf.ts parseBookshelf.
func parseBookshelf(raw string) *bookshelf {
	var root any
	if err := json.Unmarshal([]byte(raw), &root); err != nil {
		return nil
	}
	obj, ok := root.(map[string]any)
	if !ok {
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

	pictures := []shelfPicture{}
	pictureIDs := map[string]struct{}{}
	if rawPicsVal, exists := obj["pictures"]; exists {
		rawPics, ok := rawPicsVal.([]any)
		if !ok {
			return nil
		}
		for _, rp := range rawPics {
			pm, ok := rp.(map[string]any)
			if !ok {
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
			if len(pictures) >= 100 {
				return nil
			}
			pictureIDs[pid] = struct{}{}
			pictures = append(pictures, shelfPicture{
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

	result := &bookshelf{
		Bookcases: make([]bookcase, 0, len(rawCases)),
		Version:   2,
		Pictures:  pictures,
	}
	ids := map[string]struct{}{}
	bookIDs := map[string]struct{}{}
	totalBooks := 0

	for _, rc := range rawCases {
		cm, ok := rc.(map[string]any)
		if !ok {
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
			if !ok {
				return nil
			}
			w := shelfWidth
			if lw, exists := sm["width"]; exists {
				parsedW, ok := parseIntRange(lw, shelfMinWidth, shelfMaxWidth)
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
			parsedW, ok := parseIntRange(cw, shelfMinWidth, shelfMaxWidth)
			if !ok {
				return nil
			}
			caseWidth = parsedW
		}

		bc := bookcase{
			ID:      cid,
			Width:   caseWidth,
			Shelves: make([]shelf, 0, len(rawShelves)),
		}

		for _, rs := range rawShelves {
			sm, ok := rs.(map[string]any)
			if !ok {
				return nil
			}
			sid, ok := parseID(sm["id"])
			if !ok {
				return nil
			}
			if _, dup := ids[sid]; dup {
				return nil
			}
			sh, ok := parseIntRange(sm["height"], shelfMinHeight, shelfMaxHeight)
			if !ok {
				return nil
			}
			rawItems, ok := sm["items"].([]any)
			if !ok {
				return nil
			}
			ids[sid] = struct{}{}

			s := shelf{
				ID:     sid,
				Height: sh,
				Items:  make([]shelfItem, 0, len(rawItems)),
			}

			for _, ri := range rawItems {
				im, ok := ri.(map[string]any)
				if !ok {
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

				it := shelfItem{
					X:          ix,
					Horizontal: horiz,
					Books:      make([]shelfBook, 0, len(rawBooks)),
				}

				for _, rb := range rawBooks {
					bm, ok := rb.(map[string]any)
					if !ok {
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
						ox, ok := parseIntRange(oxRaw, 0, shelfMaxWidth)
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
					if totalBooks > bookshelfMaxBooks {
						return nil
					}

					it.Books = append(it.Books, shelfBook{
						ID:           bid,
						OffsetX:      offsetX,
						Width:        bw,
						Height:       bh,
						ManualWidth:  mw,
						ManualHeight: mh,
						SourcePages:  sourcePages,
					})
				}

				if it.X+itemWidth(it) > bc.Width-2 || itemHeight(it) > s.Height-shelfFloor {
					return nil
				}
				s.Items = append(s.Items, it)
			}

			sort.Slice(s.Items, func(i, j int) bool {
				return s.Items[i].X < s.Items[j].X
			})
			for i := 1; i < len(s.Items); i++ {
				if s.Items[i-1].X+itemWidth(s.Items[i-1]) > s.Items[i].X {
					return nil
				}
			}
			bc.Shelves = append(bc.Shelves, s)
		}
		result.Bookcases = append(result.Bookcases, bc)
	}
	return result
}

// recordShelfBookMove mirrors server/utils/bookshelf/move.ts.
// Must be called inside the same collection lock and transaction as the book move.
func recordShelfBookMove(ctx context.Context, q queryable, collectionID string, removed map[string]struct{}) error {
	var (
		prevRevision int
		rawArr       string
		hasStored    bool
	)
	err := q.QueryRowContext(ctx, `
		SELECT revision, arrangement FROM collection_bookshelves WHERE collection_id = ? LIMIT 1
	`, collectionID).Scan(&prevRevision, &rawArr)
	if err == nil {
		hasStored = true
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	var arr *bookshelf
	if hasStored {
		arr = parseBookshelf(rawArr)
		if arr == nil {
			return errors.New("The collection bookshelf could not be read.")
		}
	} else {
		arr = emptyBookshelf()
	}

	for bi := range arr.Bookcases {
		for si := range arr.Bookcases[bi].Shelves {
			s := &arr.Bookcases[bi].Shelves[si]
			keptItems := make([]shelfItem, 0, len(s.Items))
			for _, it := range s.Items {
				keptBooks := make([]shelfBook, 0, len(it.Books))
				for _, b := range it.Books {
					if _, drop := removed[b.ID]; !drop {
						keptBooks = append(keptBooks, b)
					}
				}
				if len(keptBooks) > 0 {
					it.Books = keptBooks
					keptItems = append(keptItems, it)
				}
			}
			s.Items = keptItems
		}
	}

	nextRevision := prevRevision + 1
	encoded, err := json.Marshal(arr)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, `
		INSERT INTO collection_bookshelves (collection_id, revision, arrangement)
		VALUES (?, ?, ?)
		ON CONFLICT(collection_id) DO UPDATE SET
			revision = excluded.revision,
			arrangement = excluded.arrangement
	`, collectionID, nextRevision, string(encoded))
	return err
}
