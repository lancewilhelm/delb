package collections

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

type colKind int

const (
	colText colKind = iota
	colInt
	colReal
)

type colSpec struct {
	Name     string
	Kind     colKind
	Nullable bool
}

type tableSpec struct {
	Name    string
	Columns []colSpec
}

var catalogSpecs = []tableSpec{
	{
		Name: "users",
		Columns: []colSpec{
			{Name: "id", Kind: colText},
			{Name: "name", Kind: colText},
			{Name: "email", Kind: colText},
			{Name: "email_verified", Kind: colInt},
			{Name: "image", Kind: colText, Nullable: true},
			{Name: "created_at", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
			{Name: "role", Kind: colText},
			{Name: "banned", Kind: colInt, Nullable: true},
			{Name: "ban_reason", Kind: colText, Nullable: true},
			{Name: "ban_expires", Kind: colInt, Nullable: true},
		},
	},
	{
		Name: "collections",
		Columns: []colSpec{
			{Name: "id", Kind: colText},
			{Name: "name", Kind: colText},
			{Name: "owner_user_id", Kind: colText},
			{Name: "is_default", Kind: colInt},
			{Name: "is_personal", Kind: colInt},
			{Name: "created_at", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "collection_members",
		Columns: []colSpec{
			{Name: "collection_id", Kind: colText},
			{Name: "user_id", Kind: colText},
			{Name: "role", Kind: colText},
			{Name: "created_at", Kind: colInt},
		},
	},
	{
		Name: "books",
		Columns: []colSpec{
			{Name: "id", Kind: colText},
			{Name: "collection_id", Kind: colText, Nullable: true},
			{Name: "added_by_user_id", Kind: colText, Nullable: true},
			{Name: "added_at", Kind: colInt},
			{Name: "title", Kind: colText},
			{Name: "sort_title", Kind: colText},
			{Name: "calibre_book_id", Kind: colInt, Nullable: true},
			{Name: "description", Kind: colText, Nullable: true},
			{Name: "published", Kind: colText, Nullable: true},
			{Name: "published_at", Kind: colInt, Nullable: true},
			{Name: "language", Kind: colText, Nullable: true},
			{Name: "has_physical_copy", Kind: colInt},
			{Name: "has_audiobook_copy", Kind: colInt},
			{Name: "pages", Kind: colInt, Nullable: true},
			{Name: "cover_image_path", Kind: colText, Nullable: true},
			{Name: "publisher_id", Kind: colText, Nullable: true},
			{Name: "series_id", Kind: colText, Nullable: true},
			{Name: "series_index", Kind: colReal, Nullable: true},
			{Name: "created_by_user_id", Kind: colText, Nullable: true},
			{Name: "created_at", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "legacy_collection_books",
		Columns: []colSpec{
			{Name: "collection_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "added_by_user_id", Kind: colText, Nullable: true},
			{Name: "added_at", Kind: colInt},
		},
	},
	{
		Name: "book_authors",
		Columns: []colSpec{
			{Name: "book_id", Kind: colText},
			{Name: "author_id", Kind: colText},
			{Name: "position", Kind: colInt, Nullable: true},
		},
	},
	{
		Name: "book_tags",
		Columns: []colSpec{
			{Name: "book_id", Kind: colText},
			{Name: "tag_id", Kind: colText},
		},
	},
	{
		Name: "book_genres",
		Columns: []colSpec{
			{Name: "book_id", Kind: colText},
			{Name: "genre_id", Kind: colText},
		},
	},
	{
		Name: "book_identifiers",
		Columns: []colSpec{
			{Name: "book_id", Kind: colText},
			{Name: "type", Kind: colText},
			{Name: "value", Kind: colText},
		},
	},
	{
		Name: "book_files",
		Columns: []colSpec{
			{Name: "id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "format", Kind: colText},
			{Name: "relative_path", Kind: colText},
			{Name: "created_at", Kind: colInt},
		},
	},
	{
		Name: "user_book_status",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "status", Kind: colText},
			{Name: "started_at", Kind: colInt, Nullable: true},
			{Name: "finished_at", Kind: colInt, Nullable: true},
			{Name: "dnf_at", Kind: colInt, Nullable: true},
			{Name: "tbr_rank", Kind: colInt, Nullable: true},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "user_book_reading_position",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "location", Kind: colText},
			{Name: "progress", Kind: colReal, Nullable: true},
			{Name: "client_session_id", Kind: colText, Nullable: true},
			{Name: "client_sequence", Kind: colInt, Nullable: true},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "user_book_preferences",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "progress_sync_enabled", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "user_book_progress_log",
		Columns: []colSpec{
			{Name: "id", Kind: colText},
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "progress_percent", Kind: colReal},
			{Name: "page_number", Kind: colInt, Nullable: true},
			{Name: "location", Kind: colText, Nullable: true},
			{Name: "source", Kind: colText},
			{Name: "occurred_at", Kind: colInt},
			{Name: "created_at", Kind: colInt},
		},
	},
	{
		Name: "book_ratings",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "rating", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "user_book_rationale",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "text", Kind: colText},
		},
	},
	{
		Name: "book_notes",
		Columns: []colSpec{
			{Name: "id", Kind: colText},
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "text", Kind: colText},
			{Name: "created_at", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "user_book_reviews",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "book_id", Kind: colText},
			{Name: "text", Kind: colText},
			{Name: "contains_spoilers", Kind: colInt},
			{Name: "created_at", Kind: colInt},
			{Name: "updated_at", Kind: colInt},
		},
	},
	{
		Name: "global_settings",
		Columns: []colSpec{
			{Name: "user_id", Kind: colText},
			{Name: "settings", Kind: colText},
			{Name: "updated_at", Kind: colInt},
		},
	},
}

var catalogSpecByName = func() map[string]tableSpec {
	m := make(map[string]tableSpec, len(catalogSpecs))
	for _, s := range catalogSpecs {
		m[s.Name] = s
	}
	return m
}()

var readerTables = []string{
	"user_book_status",
	"user_book_reading_position",
	"user_book_preferences",
	"user_book_progress_log",
	"book_ratings",
	"user_book_rationale",
	"book_notes",
	"user_book_reviews",
}

type sqlRow map[string]any

type catalogData struct {
	Tables map[string][]sqlRow
}

type MigrationChoice struct {
	BookID       string `json:"bookId"`
	CollectionID string `json:"collectionId"`
}

type MigrationPlan struct {
	Fingerprint     string            `json:"fingerprint"`
	Choices         []MigrationChoice `json:"choices"`
	DefaultID       string            `json:"defaultId"`
	RecoveredID     string            `json:"recoveredId"`
	OwnerID         string            `json:"ownerId"`
	DropboxTargetID *string           `json:"dropboxTargetId"`
}

type MigrationSplitCollection struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MigrationSplit struct {
	BookID        string                     `json:"bookId"`
	Title         string                     `json:"title"`
	CalibreBookID *int64                     `json:"calibreBookId"`
	Collections   []MigrationSplitCollection `json:"collections"`
}

type MigrationDropboxOption struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type MigrationDropboxTargets struct {
	NeedsChoice   bool                     `json:"needsChoice"`
	Options       []MigrationDropboxOption `json:"options"`
	ConfiguredIDs []string                 `json:"configuredIds"`
}

type MigrationPreview struct {
	State                   string                  `json:"state"`
	Fingerprint             string                  `json:"fingerprint"`
	Users                   int                     `json:"users"`
	PrivateCollections      int                     `json:"privateCollections"`
	RecoveredBooks          int                     `json:"recoveredBooks"`
	Splits                  []MigrationSplit        `json:"splits"`
	RetainedChoices         []MigrationChoice       `json:"retainedChoices"`
	Blockers                []string                `json:"blockers"`
	DropboxTargets          MigrationDropboxTargets `json:"dropboxTargets"`
	RetainedDropboxTargetID *string                 `json:"retainedDropboxTargetId"`
}

type ApplyMigrationInput struct {
	Fingerprint     string
	Choices         []MigrationChoice
	BackupConfirmed bool
	DropboxTargetID *string
}

func readTableRows(ctx context.Context, q queryable, spec tableSpec) ([]sqlRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT * FROM "`+spec.Name+`" ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	cols, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	specByCol := make(map[string]colSpec, len(spec.Columns))
	for _, c := range spec.Columns {
		specByCol[c.Name] = c
	}
	for _, col := range cols {
		if _, ok := specByCol[col]; !ok {
			return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Unrecognized legacy %s columns; check the migration version", spec.Name))
		}
	}

	result := make([]sqlRow, 0)
	for rows.Next() {
		rawVals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range rawVals {
			ptrs[i] = &rawVals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		row := make(sqlRow, len(spec.Columns))
		for i, col := range cols {
			row[col] = rawVals[i]
		}
		for _, c := range spec.Columns {
			v, exists := row[c.Name]
			if !exists {
				v = nil
				row[c.Name] = nil
			}
			if v == nil {
				if !c.Nullable {
					return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Invalid legacy %s.%s; repair the source before migration", spec.Name, c.Name))
				}
				continue
			}
			switch c.Kind {
			case colText:
				if _, ok := v.(string); !ok {
					return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Invalid legacy %s.%s; repair the source before migration", spec.Name, c.Name))
				}
			case colInt:
				switch num := v.(type) {
				case int64:
					row[c.Name] = num
				case float64:
					if math.IsNaN(num) || math.IsInf(num, 0) {
						return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Invalid legacy %s.%s; repair the source before migration", spec.Name, c.Name))
					}
					row[c.Name] = num
				default:
					return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Invalid legacy %s.%s; repair the source before migration", spec.Name, c.Name))
				}
			case colReal:
				switch num := v.(type) {
				case int64:
					row[c.Name] = num
				case float64:
					if math.IsNaN(num) || math.IsInf(num, 0) {
						return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Invalid legacy %s.%s; repair the source before migration", spec.Name, c.Name))
					}
					row[c.Name] = num
				default:
					return nil, httpapi.NewError(http.StatusConflict, fmt.Sprintf("Invalid legacy %s.%s; repair the source before migration", spec.Name, c.Name))
				}
			}
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func takeCatalogSnapshot(ctx context.Context, q queryable) (*catalogData, string, error) {
	data := &catalogData{
		Tables: make(map[string][]sqlRow, len(catalogSpecs)),
	}
	h := sha256.New()
	for _, spec := range catalogSpecs {
		rows, err := readTableRows(ctx, q, spec)
		if err != nil {
			return nil, "", err
		}
		data.Tables[spec.Name] = rows

		// Canonical serialization in deterministic table/column order.
		_, _ = h.Write([]byte(spec.Name))
		_, _ = h.Write([]byte{0})
		for _, row := range rows {
			for _, col := range spec.Columns {
				encoded, err := json.Marshal(row[col.Name])
				if err != nil {
					return nil, "", err
				}
				_, _ = h.Write(encoded)
				_, _ = h.Write([]byte{0})
			}
			_, _ = h.Write([]byte{1})
		}
		_, _ = h.Write([]byte{2})
	}
	return data, hex.EncodeToString(h.Sum(nil)), nil
}

type legacyDropboxInfo struct {
	UserID   string
	Settings map[string]any
	Dropbox  map[string]any
	IDs      []string
}

func extractLegacyDropbox(data *catalogData) *legacyDropboxInfo {
	rows := data.Tables["global_settings"]
	if len(rows) == 0 {
		return nil
	}
	row := rows[0]
	rawSettings, _ := row["settings"].(string)
	var parsed any
	if err := json.Unmarshal([]byte(rawSettings), &parsed); err != nil {
		return nil
	}
	settingsMap, ok := parsed.(map[string]any)
	if !ok {
		return nil
	}
	dropboxMap, ok := settingsMap["dropbox"].(map[string]any)
	if !ok {
		return nil
	}

	var candidates []string
	if tid, ok := dropboxMap["targetCollectionId"].(string); ok && strings.TrimSpace(tid) != "" {
		candidates = append(candidates, strings.TrimSpace(tid))
	}
	if addl, ok := dropboxMap["additionalCollectionIds"].([]any); ok {
		for _, item := range addl {
			if s, ok := item.(string); ok && strings.TrimSpace(s) != "" {
				candidates = append(candidates, strings.TrimSpace(s))
			}
		}
	}
	userID, _ := row["user_id"].(string)
	return &legacyDropboxInfo{
		UserID:   userID,
		Settings: settingsMap,
		Dropbox:  dropboxMap,
		IDs:      dedupeStrings(candidates),
	}
}

func parseRetainedPlan(raw string) (*MigrationPlan, error) {
	var m map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	}
	var p MigrationPlan
	if err := json.Unmarshal(m["fingerprint"], &p.Fingerprint); err != nil {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	}
	if err := json.Unmarshal(m["defaultId"], &p.DefaultID); err != nil {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	}
	if err := json.Unmarshal(m["recoveredId"], &p.RecoveredID); err != nil {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	}
	if err := json.Unmarshal(m["ownerId"], &p.OwnerID); err != nil {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	}
	if rawDT, exists := m["dropboxTargetId"]; !exists {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	} else if strings.TrimSpace(string(rawDT)) != "null" {
		var dt string
		if err := json.Unmarshal(rawDT, &dt); err != nil {
			return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
		}
		p.DropboxTargetID = &dt
	}
	var rawChoices []json.RawMessage
	if err := json.Unmarshal(m["choices"], &rawChoices); err != nil {
		return nil, httpapi.NewError(http.StatusConflict, "Invalid retained migration plan")
	}
	p.Choices = make([]MigrationChoice, 0, len(rawChoices))
	for _, rc := range rawChoices {
		var cm map[string]json.RawMessage
		if err := json.Unmarshal(rc, &cm); err != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid migration choice")
		}
		var bid, cid string
		if json.Unmarshal(cm["bookId"], &bid) != nil || json.Unmarshal(cm["collectionId"], &cid) != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid migration choice")
		}
		p.Choices = append(p.Choices, MigrationChoice{BookID: bid, CollectionID: cid})
	}
	return &p, nil
}

func PreviewCollectionMigration(ctx context.Context, db *sql.DB) (MigrationPreview, error) {
	state, err := collectionModelState(ctx, db)
	if err != nil {
		return MigrationPreview{}, err
	}
	if state == "exclusive" {
		return MigrationPreview{
			State:              state,
			Fingerprint:        "",
			Users:              0,
			PrivateCollections: 0,
			RecoveredBooks:     0,
			Splits:             []MigrationSplit{},
			RetainedChoices:    []MigrationChoice{},
			Blockers:           []string{},
			DropboxTargets: MigrationDropboxTargets{
				NeedsChoice:   false,
				Options:       []MigrationDropboxOption{},
				ConfiguredIDs: []string{},
			},
			RetainedDropboxTargetID: nil,
		}, nil
	}

	data, fingerprint, err := takeCatalogSnapshot(ctx, db)
	if err != nil {
		return MigrationPreview{}, err
	}

	var retained *MigrationPlan
	var journalRaw string
	err = db.QueryRowContext(ctx, `SELECT value FROM system_state WHERE key = 'collection-migration-plan' LIMIT 1`).Scan(&journalRaw)
	if err == nil {
		retained, err = parseRetainedPlan(journalRaw)
		if err != nil {
			return MigrationPreview{}, err
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return MigrationPreview{}, err
	}

	collectionNames := make(map[string]string, len(data.Tables["collections"]))
	for _, c := range data.Tables["collections"] {
		collectionNames[rowStr(c, "id")] = rowStr(c, "name")
	}

	linksByBook := make(map[string][]sqlRow)
	for _, link := range data.Tables["legacy_collection_books"] {
		bid := rowStr(link, "book_id")
		linksByBook[bid] = append(linksByBook[bid], link)
	}

	splits := make([]MigrationSplit, 0)
	recoveredBooks := 0
	for _, book := range data.Tables["books"] {
		bid := rowStr(book, "id")
		links := linksByBook[bid]
		if len(links) == 0 {
			recoveredBooks++
			continue
		}
		if len(links) > 1 {
			cols := make([]MigrationSplitCollection, 0, len(links))
			for _, l := range links {
				cid := rowStr(l, "collection_id")
				cname, ok := collectionNames[cid]
				if !ok {
					cname = cid
				}
				cols = append(cols, MigrationSplitCollection{ID: cid, Name: cname})
			}
			splits = append(splits, MigrationSplit{
				BookID:        bid,
				Title:         rowStr(book, "title"),
				CalibreBookID: rowOptInt64(book, "calibre_book_id"),
				Collections:   cols,
			})
		}
	}

	var opCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM storage_operations`).Scan(&opCount); err != nil {
		return MigrationPreview{}, err
	}

	hasOwner := false
	for _, u := range data.Tables["users"] {
		if rowStr(u, "role") == "owner" {
			hasOwner = true
			break
		}
	}

	badOwners := false
	privateCollections := 0
	for _, c := range data.Tables["collections"] {
		if rowInt64(c, "is_personal") == 1 {
			privateCollections++
		}
		cid := rowStr(c, "id")
		ownerUID := rowStr(c, "owner_user_id")
		ownerMembers := 0
		matchedOwner := false
		for _, m := range data.Tables["collection_members"] {
			if rowStr(m, "collection_id") == cid && rowStr(m, "role") == "owner" {
				ownerMembers++
				if rowStr(m, "user_id") == ownerUID {
					matchedOwner = true
				}
			}
		}
		if ownerMembers != 1 || !matchedOwner {
			badOwners = true
		}
	}

	blockers := make([]string, 0)
	if !hasOwner {
		blockers = append(blockers, "A system owner is required.")
	}
	if opCount > 0 {
		blockers = append(blockers, "Complete pending managed-file recovery before migration.")
	}
	if badOwners {
		blockers = append(blockers, "Repair inconsistent legacy collection owners before migration.")
	}

	dropbox := extractLegacyDropbox(data)
	options := make([]MigrationDropboxOption, 0, len(data.Tables["collections"]))
	for _, c := range data.Tables["collections"] {
		options = append(options, MigrationDropboxOption{
			ID:   rowStr(c, "id"),
			Name: rowStr(c, "name"),
		})
	}
	configuredIDs := []string{}
	needsChoice := false
	if dropbox != nil {
		configuredIDs = dropbox.IDs
		if len(dropbox.IDs) > 1 {
			needsChoice = true
		} else {
			for _, id := range dropbox.IDs {
				if _, exists := collectionNames[id]; !exists {
					needsChoice = true
					break
				}
			}
		}
	}

	retainedChoices := []MigrationChoice{}
	var retainedDropbox *string
	if retained != nil {
		if retained.Choices != nil {
			retainedChoices = retained.Choices
		}
		if retained.DropboxTargetID != nil {
			v := *retained.DropboxTargetID
			retainedDropbox = &v
		} else {
			empty := ""
			retainedDropbox = &empty
		}
	}

	return MigrationPreview{
		State:              state,
		Fingerprint:        fingerprint,
		Users:              len(data.Tables["users"]),
		PrivateCollections: privateCollections,
		RecoveredBooks:     recoveredBooks,
		Splits:             splits,
		RetainedChoices:    retainedChoices,
		Blockers:           blockers,
		DropboxTargets: MigrationDropboxTargets{
			NeedsChoice:   needsChoice,
			Options:       options,
			ConfiguredIDs: configuredIDs,
		},
		RetainedDropboxTargetID: retainedDropbox,
	}, nil
}

func deterministicCopyID(bookID, collectionID string) string {
	sum := sha256.Sum256([]byte(bookID + "\x00" + collectionID))
	h := hex.EncodeToString(sum[:])
	return fmt.Sprintf("%s-%s-5%s-a%s-%s", h[0:8], h[8:12], h[13:16], h[17:20], h[20:32])
}

func resolveManagedInside(root, stored string) (string, error) {
	if !strings.HasPrefix(stored, "library/") {
		return "", httpapi.NewError(http.StatusConflict, "Invalid managed path: "+stored)
	}
	for _, part := range strings.FieldsFunc(stored, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return "", httpapi.NewError(http.StatusConflict, "Invalid managed path: "+stored)
		}
	}
	file := filepath.Clean(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(stored, "library/"))))
	actual, err := filepath.EvalSymlinks(file)
	if err != nil {
		return "", err
	}
	linfo, err := os.Lstat(file)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(actual, root+string(os.PathSeparator)) || !linfo.Mode().IsRegular() {
		return "", httpapi.NewError(http.StatusConflict, "Unsafe managed file: "+stored)
	}
	return actual, nil
}

type copiedBookFiles struct {
	Files map[string]string
	Cover *string
}

func copyMigrationBookFiles(root string, book sqlRow, files []sqlRow, newID, fingerprint string) (copiedBookFiles, error) {
	known := make([]string, 0, len(files)+1)
	for _, f := range files {
		known = append(known, rowStr(f, "relative_path"))
	}
	coverPath := rowOptStr(book, "cover_image_path")
	if coverPath != nil && *coverPath != "" {
		known = append(known, *coverPath)
	}
	if len(known) == 0 {
		return copiedBookFiles{Files: map[string]string{}, Cover: nil}, nil
	}

	relativeDir := "collection-copies/" + newID
	parent := filepath.Join(root, "collection-copies")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return copiedBookFiles{}, err
	}
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		return copiedBookFiles{}, err
	}
	parentReal, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return copiedBookFiles{}, err
	}
	if parentInfo.Mode()&os.ModeSymlink != 0 || parentReal != parent {
		return copiedBookFiles{}, httpapi.NewError(http.StatusConflict, "Unsafe collection copy directory")
	}

	directory := filepath.Join(parent, newID)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return copiedBookFiles{}, err
	}
	dirInfo, err := os.Lstat(directory)
	if err != nil {
		return copiedBookFiles{}, err
	}
	if dirInfo.Mode()&os.ModeSymlink != 0 {
		return copiedBookFiles{}, httpapi.NewError(http.StatusConflict, "Unsafe collection copy directory")
	}

	markerPath := filepath.Join(directory, ".collection-migration.json")
	identityBytes, err := json.Marshal(struct {
		Fingerprint string `json:"fingerprint"`
		NewID       string `json:"newId"`
	}{
		Fingerprint: fingerprint,
		NewID:       newID,
	})
	if err != nil {
		return copiedBookFiles{}, err
	}
	identity := string(identityBytes)

	existingMarker, err := os.ReadFile(markerPath)
	if err == nil {
		if string(existingMarker) != identity {
			return copiedBookFiles{}, httpapi.NewError(http.StatusConflict, "Collection copy directory belongs to another migration")
		}
	} else if errors.Is(err, os.ErrNotExist) {
		entries, readErr := os.ReadDir(directory)
		if readErr != nil {
			return copiedBookFiles{}, readErr
		}
		if len(entries) > 0 {
			return copiedBookFiles{}, httpapi.NewError(http.StatusConflict, "Collection copy directory already contains files")
		}
		mf, openErr := os.OpenFile(markerPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if openErr != nil {
			return copiedBookFiles{}, openErr
		}
		_, wErr := mf.Write(identityBytes)
		sErr := mf.Sync()
		cErr := mf.Close()
		if wErr != nil {
			return copiedBookFiles{}, wErr
		}
		if sErr != nil {
			return copiedBookFiles{}, sErr
		}
		if cErr != nil {
			return copiedBookFiles{}, cErr
		}
	} else {
		return copiedBookFiles{}, err
	}

	type refPair struct {
		stored string
		source string
	}
	references := make([]refPair, 0, len(known))
	for _, stored := range known {
		src, err := resolveManagedInside(root, stored)
		if err != nil {
			return copiedBookFiles{}, err
		}
		references = append(references, refPair{stored: stored, source: src})
	}

	mapping := make(map[string]string, len(references))
	destinations := make(map[string]string)

	primary := references[0]
	if coverPath != nil && *coverPath != "" {
		for _, ref := range references {
			if ref.stored == *coverPath {
				primary = ref
				break
			}
		}
	}
	primaryDir := filepath.Dir(primary.source)

	for _, ref := range references {
		sourceDir := filepath.Dir(ref.source)
		prefix := ""
		if sourceDir != primaryDir {
			sum := sha256.Sum256([]byte(sourceDir))
			prefix = hex.EncodeToString(sum[:])[:12] + "-"
		}
		referencedNames := make(map[string]struct{})
		for _, other := range references {
			if filepath.Dir(other.source) == sourceDir {
				referencedNames[filepath.Base(other.source)] = struct{}{}
			}
		}

		entries, err := os.ReadDir(sourceDir)
		if err != nil {
			return copiedBookFiles{}, err
		}
		for _, entry := range entries {
			if entry.IsDir() || !entry.Type().IsRegular() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			_, isRef := referencedNames[entry.Name()]
			isCoverSidecar := coverPath != nil && *coverPath != "" && sourceDir == primaryDir && sidecarFileRe.MatchString(entry.Name())
			if !isRef && !isCoverSidecar {
				continue
			}
			sourcePath := filepath.Join(sourceDir, entry.Name())
			destination := filepath.Join(directory, prefix+entry.Name())

			if prev, exists := destinations[destination]; exists && prev != sourcePath {
				same, err := SameFileContents(prev, sourcePath)
				if err != nil {
					return copiedBookFiles{}, err
				}
				if !same {
					return copiedBookFiles{}, httpapi.NewError(http.StatusConflict, "Book file names collide during migration")
				}
			}
			destinations[destination] = sourcePath

			same, err := SameFileContents(sourcePath, destination)
			if err == nil {
				if same {
					continue
				}
				if rmErr := os.Remove(destination); rmErr != nil {
					return copiedBookFiles{}, rmErr
				}
			} else if !errors.Is(err, os.ErrNotExist) {
				return copiedBookFiles{}, err
			}

			if err := CopyVerifiedExclusive(sourcePath, destination); err != nil {
				return copiedBookFiles{}, err
			}
		}

		mapping[ref.stored] = "library/" + relativeDir + "/" + prefix + filepath.Base(ref.source)
	}

	var newCover *string
	if coverPath != nil && *coverPath != "" {
		if mapped, ok := mapping[*coverPath]; ok {
			newCover = &mapped
		}
	}
	return copiedBookFiles{Files: mapping, Cover: newCover}, nil
}

func ApplyCollectionMigration(ctx context.Context, db *sql.DB, libraryRoot string, input ApplyMigrationInput) (map[string]bool, error) {
	if !input.BackupConfirmed {
		return nil, httpapi.NewError(http.StatusBadRequest, "Confirm a matching database and library backup before migration")
	}
	if err := os.MkdirAll(libraryRoot, 0o755); err != nil {
		return nil, err
	}
	root, err := filepath.EvalSymlinks(libraryRoot)
	if err != nil {
		return nil, err
	}

	var res map[string]bool
	err = WithBookStorageLock(ctx, root, "collection-model-migration", func() error {
		state, err := collectionModelState(ctx, db)
		if err != nil {
			return err
		}
		if state == "exclusive" {
			res = map[string]bool{"complete": true}
			return nil
		}

		preview, err := PreviewCollectionMigration(ctx, db)
		if err != nil {
			return err
		}
		if len(preview.Blockers) > 0 {
			return httpapi.NewError(http.StatusConflict, strings.Join(preview.Blockers, " "))
		}
		if preview.Fingerprint != input.Fingerprint {
			return httpapi.NewError(http.StatusConflict, "Library changed. Preview the migration again.")
		}

		// Validate split choices cover every split book uniquely with a valid collection.
		if !validMigrationChoices(preview.Splits, input.Choices) {
			return httpapi.NewError(http.StatusBadRequest, "Choose which collection retains the original entry for every split book")
		}

		data, fingerprint, err := takeCatalogSnapshot(ctx, db)
		if err != nil {
			return err
		}

		if preview.DropboxTargets.NeedsChoice && input.DropboxTargetID == nil {
			return httpapi.NewError(http.StatusBadRequest, "Choose one Dropbox destination or the new shared default")
		}

		var dropboxTargetID *string
		if input.DropboxTargetID == nil {
			if len(preview.DropboxTargets.ConfiguredIDs) > 0 {
				v := preview.DropboxTargets.ConfiguredIDs[0]
				dropboxTargetID = &v
			}
		} else if *input.DropboxTargetID != "" {
			v := *input.DropboxTargetID
			dropboxTargetID = &v
		}

		if dropboxTargetID != nil {
			found := false
			for _, c := range data.Tables["collections"] {
				if rowStr(c, "id") == *dropboxTargetID {
					found = true
					break
				}
			}
			if !found {
				return httpapi.NewError(http.StatusBadRequest, "Invalid Dropbox destination")
			}
		}

		var ownerID string
		for _, u := range data.Tables["users"] {
			if rowStr(u, "role") == "owner" {
				ownerID = rowStr(u, "id")
				break
			}
		}
		if ownerID == "" {
			return httpapi.NewError(http.StatusConflict, "A system owner is required")
		}

		plan := MigrationPlan{
			Fingerprint:     fingerprint,
			Choices:         input.Choices,
			DefaultID:       uuid.NewString(),
			RecoveredID:     uuid.NewString(),
			OwnerID:         ownerID,
			DropboxTargetID: dropboxTargetID,
		}

		// Transaction 1: persist/verify retained plan and set collections-model='migrating'.
		tx1, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx1.Rollback() }()

		if err := lockCollectionChanges(ctx, tx1); err != nil {
			return err
		}
		var retainedRaw string
		err = tx1.QueryRowContext(ctx, `SELECT value FROM system_state WHERE key = 'collection-migration-plan' LIMIT 1`).Scan(&retainedRaw)
		if err == nil {
			retained, parseErr := parseRetainedPlan(retainedRaw)
			if parseErr != nil {
				return parseErr
			}
			if retained.Fingerprint != fingerprint ||
				!optStrEqual(retained.DropboxTargetID, dropboxTargetID) ||
				!choicesEqualSorted(retained.Choices, input.Choices) {
				return httpapi.NewError(http.StatusConflict, "Resume with the retained migration choices")
			}
			plan = *retained
		} else if errors.Is(err, sql.ErrNoRows) {
			encodedPlan, marshalErr := json.Marshal(plan)
			if marshalErr != nil {
				return marshalErr
			}
			if _, execErr := tx1.ExecContext(ctx, `
				INSERT INTO system_state (key, value) VALUES ('collection-migration-plan', ?)
			`, string(encodedPlan)); execErr != nil {
				return execErr
			}
		} else {
			return err
		}

		if _, err := tx1.ExecContext(ctx, `
			UPDATE system_state SET value = 'migrating' WHERE key = 'collections-model'
		`); err != nil {
			return err
		}
		if err := tx1.Commit(); err != nil {
			return err
		}

		// Plan book assignments and copy files outside the database transaction.
		type bookAssignment struct {
			Book         sqlRow
			Links        []sqlRow
			CollectionID string
			Link         sqlRow
		}
		type bookCopy struct {
			Original     sqlRow
			Row          sqlRow
			CollectionID string
			Files        copiedBookFiles
		}

		choiceMap := make(map[string]string, len(plan.Choices))
		for _, ch := range plan.Choices {
			choiceMap[ch.BookID] = ch.CollectionID
		}

		linksByBook := make(map[string][]sqlRow)
		for _, link := range data.Tables["legacy_collection_books"] {
			bid := rowStr(link, "book_id")
			linksByBook[bid] = append(linksByBook[bid], link)
		}

		filesByBook := make(map[string][]sqlRow)
		for _, bf := range data.Tables["book_files"] {
			bid := rowStr(bf, "book_id")
			filesByBook[bid] = append(filesByBook[bid], bf)
		}

		assignments := make([]bookAssignment, 0, len(data.Tables["books"]))
		for _, book := range data.Tables["books"] {
			bid := rowStr(book, "id")
			links := linksByBook[bid]
			cid, chosen := choiceMap[bid]
			if !chosen {
				if len(links) > 0 {
					cid = rowStr(links[0], "collection_id")
				} else {
					cid = plan.RecoveredID
				}
			}
			var matchedLink sqlRow
			for _, l := range links {
				if rowStr(l, "collection_id") == cid {
					matchedLink = l
					break
				}
			}
			assignments = append(assignments, bookAssignment{
				Book:         book,
				Links:        links,
				CollectionID: cid,
				Link:         matchedLink,
			})
		}

		var copies []bookCopy
		for _, a := range assignments {
			origID := rowStr(a.Book, "id")
			for _, link := range a.Links {
				lcid := rowStr(link, "collection_id")
				if lcid == a.CollectionID {
					continue
				}
				newID := deterministicCopyID(origID, lcid)
				copied, err := copyMigrationBookFiles(root, a.Book, filesByBook[origID], newID, fingerprint)
				if err != nil {
					return err
				}
				cloned := cloneRow(a.Book)
				cloned["id"] = newID
				cloned["calibre_book_id"] = nil
				cloned["collection_id"] = lcid
				cloned["added_by_user_id"] = link["added_by_user_id"]
				cloned["added_at"] = link["added_at"]
				copies = append(copies, bookCopy{
					Original:     a.Book,
					Row:          cloned,
					CollectionID: lcid,
					Files:        copied,
				})
			}
		}

		// Transaction 2: apply all database changes atomically after verifying snapshot fingerprint.
		tx2, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx2.Rollback() }()

		if err := lockCollectionChanges(ctx, tx2); err != nil {
			return err
		}
		_, currentFP, err := takeCatalogSnapshot(ctx, tx2)
		if err != nil {
			return err
		}
		if currentFP != fingerprint {
			return httpapi.NewError(http.StatusConflict, "Library changed during migration. Restore the matching backup before retrying.")
		}

		now := time.Now().UTC().Unix()
		if _, err := tx2.ExecContext(ctx, `UPDATE collections SET is_personal = 0, is_default = 0`); err != nil {
			return err
		}
		if _, err := tx2.ExecContext(ctx, `
			INSERT INTO collections (id, name, owner_user_id, is_personal, is_default, created_at, updated_at)
			VALUES (?, 'Default', ?, 0, 1, ?, ?)
		`, plan.DefaultID, plan.OwnerID, now, now); err != nil {
			return err
		}
		if _, err := tx2.ExecContext(ctx, `
			INSERT INTO collection_members (collection_id, user_id, role, created_at)
			SELECT ?, id, 'editor', ? FROM users WHERE id != ?
		`, plan.DefaultID, now, plan.OwnerID); err != nil {
			return err
		}

		if dropbox := extractLegacyDropbox(data); dropbox != nil {
			nextDropbox := make(map[string]any, len(dropbox.Dropbox)+2)
			for k, v := range dropbox.Dropbox {
				nextDropbox[k] = v
			}
			dtVal := ""
			if plan.DropboxTargetID != nil {
				dtVal = *plan.DropboxTargetID
			}
			nextDropbox["targetCollectionId"] = dtVal
			nextDropbox["additionalCollectionIds"] = []string{}

			nextSettings := make(map[string]any, len(dropbox.Settings))
			for k, v := range dropbox.Settings {
				nextSettings[k] = v
			}
			nextSettings["dropbox"] = nextDropbox
			encodedSettings, err := json.Marshal(nextSettings)
			if err != nil {
				return err
			}
			if _, err := tx2.ExecContext(ctx, `
				UPDATE global_settings SET settings = ? WHERE user_id = ?
			`, string(encodedSettings), dropbox.UserID); err != nil {
				return err
			}
		}

		if preview.RecoveredBooks > 0 {
			if _, err := tx2.ExecContext(ctx, `
				INSERT INTO collections (id, name, owner_user_id, is_personal, is_default, created_at, updated_at)
				VALUES (?, 'Recovered books', ?, 0, 0, ?, ?)
			`, plan.RecoveredID, plan.OwnerID, now, now); err != nil {
				return err
			}
		}

		for _, a := range assignments {
			addedBy := a.Book["created_by_user_id"]
			addedAt := a.Book["created_at"]
			if a.Link != nil {
				if a.Link["added_by_user_id"] != nil {
					addedBy = a.Link["added_by_user_id"]
				}
				if a.Link["added_at"] != nil {
					addedAt = a.Link["added_at"]
				}
			}
			if _, err := tx2.ExecContext(ctx, `
				UPDATE books SET collection_id = ?, added_by_user_id = ?, added_at = ? WHERE id = ?
			`, a.CollectionID, addedBy, addedAt, rowStr(a.Book, "id")); err != nil {
				return err
			}
		}

		for _, cp := range copies {
			origID := rowStr(cp.Original, "id")
			newID := rowStr(cp.Row, "id")

			bookRow := cloneRow(cp.Row)
			if cp.Files.Cover != nil {
				bookRow["cover_image_path"] = *cp.Files.Cover
			} else {
				bookRow["cover_image_path"] = nil
			}
			if err := insertCatalogRow(ctx, tx2, "books", bookRow); err != nil {
				return err
			}

			for _, tbl := range []string{"book_authors", "book_tags", "book_genres", "book_identifiers"} {
				for _, r := range data.Tables[tbl] {
					if rowStr(r, "book_id") != origID {
						continue
					}
					cloned := cloneRow(r)
					cloned["book_id"] = newID
					if err := insertCatalogRow(ctx, tx2, tbl, cloned); err != nil {
						return err
					}
				}
			}

			for _, bf := range data.Tables["book_files"] {
				if rowStr(bf, "book_id") != origID {
					continue
				}
				rel := rowStr(bf, "relative_path")
				mapped, ok := cp.Files.Files[rel]
				if !ok || mapped == "" {
					return httpapi.NewError(http.StatusConflict, "Missing verified book copy")
				}
				cloned := cloneRow(bf)
				cloned["id"] = uuid.NewString()
				cloned["book_id"] = newID
				cloned["relative_path"] = mapped
				if err := insertCatalogRow(ctx, tx2, "book_files", cloned); err != nil {
					return err
				}
			}

			members := make(map[string]struct{})
			for _, m := range data.Tables["collection_members"] {
				if rowStr(m, "collection_id") == cp.CollectionID {
					members[rowStr(m, "user_id")] = struct{}{}
				}
			}
			for _, tbl := range readerTables {
				for _, r := range data.Tables[tbl] {
					if rowStr(r, "book_id") != origID {
						continue
					}
					if _, isMember := members[rowStr(r, "user_id")]; !isMember {
						continue
					}
					cloned := cloneRow(r)
					if _, hasID := cloned["id"]; hasID {
						cloned["id"] = uuid.NewString()
					}
					cloned["book_id"] = newID
					if err := insertCatalogRow(ctx, tx2, tbl, cloned); err != nil {
						return err
					}
				}
			}
		}

		// Recompute tbr_rank per user from source snapshot so copies stay adjacent.
		for _, user := range data.Tables["users"] {
			uid := rowStr(user, "id")
			var queue []sqlRow
			for _, st := range data.Tables["user_book_status"] {
				if rowStr(st, "user_id") == uid && rowStr(st, "status") == "to_be_read" {
					queue = append(queue, st)
				}
			}
			sort.Slice(queue, func(i, j int) bool {
				ri := rowTBRRank(queue[i])
				rj := rowTBRRank(queue[j])
				if ri != rj {
					return ri < rj
				}
				return rowStr(queue[i], "book_id") < rowStr(queue[j], "book_id")
			})

			rank := 0
			for _, orig := range queue {
				origBID := rowStr(orig, "book_id")
				ids := []string{origBID}
				for _, cp := range copies {
					if rowStr(cp.Original, "id") == origBID {
						ids = append(ids, rowStr(cp.Row, "id"))
					}
				}
				for _, id := range ids {
					var dummy int
					visErr := tx2.QueryRowContext(ctx, `
						SELECT 1 FROM books b
						JOIN collection_members cm ON cm.collection_id = b.collection_id
						WHERE b.id = ? AND cm.user_id = ?
						LIMIT 1
					`, id, uid).Scan(&dummy)
					var rankArg any
					if visErr == nil {
						rank++
						rankArg = rank
					} else if !errors.Is(visErr, sql.ErrNoRows) {
						return visErr
					}
					if _, err := tx2.ExecContext(ctx, `
						UPDATE user_book_status SET tbr_rank = ? WHERE user_id = ? AND book_id = ?
					`, rankArg, uid, id); err != nil {
						return err
					}
				}
			}
		}

		var unassigned int
		err = tx2.QueryRowContext(ctx, `SELECT 1 FROM books WHERE collection_id IS NULL LIMIT 1`).Scan(&unassigned)
		if err == nil {
			return httpapi.NewError(http.StatusConflict, "Migration left an unassigned book")
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}

		if _, err := tx2.ExecContext(ctx, `
			UPDATE system_state SET value = 'exclusive' WHERE key = 'collections-model'
		`); err != nil {
			return err
		}

		if err := tx2.Commit(); err != nil {
			return err
		}

		res = map[string]bool{"complete": true}
		return nil
	})
	return res, err
}

func insertCatalogRow(ctx context.Context, q queryable, table string, row sqlRow) error {
	spec, ok := catalogSpecByName[table]
	if !ok {
		return fmt.Errorf("unknown catalog table %q", table)
	}
	colNames := make([]string, 0, len(spec.Columns))
	args := make([]any, 0, len(spec.Columns))
	for _, c := range spec.Columns {
		colNames = append(colNames, `"`+c.Name+`"`)
		args = append(args, row[c.Name])
	}
	query := `INSERT INTO "` + table + `" (` + strings.Join(colNames, ", ") + `) VALUES (` + makePlaceholders(len(colNames)) + `)`
	_, err := q.ExecContext(ctx, query, args...)
	return err
}

func validMigrationChoices(splits []MigrationSplit, choices []MigrationChoice) bool {
	if len(choices) != len(splits) {
		return false
	}
	seen := make(map[string]string, len(choices))
	for _, c := range choices {
		if _, dup := seen[c.BookID]; dup {
			return false
		}
		seen[c.BookID] = c.CollectionID
	}
	for _, sp := range splits {
		chosen, ok := seen[sp.BookID]
		if !ok {
			return false
		}
		validTarget := false
		for _, col := range sp.Collections {
			if col.ID == chosen {
				validTarget = true
				break
			}
		}
		if !validTarget {
			return false
		}
	}
	return true
}

func choicesEqualSorted(a, b []MigrationChoice) bool {
	if len(a) != len(b) {
		return false
	}
	sa := append([]MigrationChoice(nil), a...)
	sb := append([]MigrationChoice(nil), b...)
	sort.Slice(sa, func(i, j int) bool { return sa[i].BookID < sa[j].BookID })
	sort.Slice(sb, func(i, j int) bool { return sb[i].BookID < sb[j].BookID })
	for i := range sa {
		if sa[i] != sb[i] {
			return false
		}
	}
	return true
}

func optStrEqual(a, b *string) bool {
	if a == nil && b == nil {
		return true
	}
	if a == nil || b == nil {
		return false
	}
	return *a == *b
}

func cloneRow(r sqlRow) sqlRow {
	out := make(sqlRow, len(r))
	for k, v := range r {
		out[k] = v
	}
	return out
}

func rowStr(r sqlRow, key string) string {
	s, _ := r[key].(string)
	return s
}

func rowOptStr(r sqlRow, key string) *string {
	v, ok := r[key]
	if !ok || v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func rowInt64(r sqlRow, key string) int64 {
	switch v := r[key].(type) {
	case int64:
		return v
	case float64:
		return int64(v)
	default:
		return 0
	}
}

func rowOptInt64(r sqlRow, key string) *int64 {
	v, ok := r[key]
	if !ok || v == nil {
		return nil
	}
	switch n := v.(type) {
	case int64:
		val := n
		return &val
	case float64:
		val := int64(n)
		return &val
	default:
		return nil
	}
}

func rowTBRRank(r sqlRow) int64 {
	if v := rowOptInt64(r, "tbr_rank"); v != nil {
		return *v
	}
	return math.MaxInt64
}
