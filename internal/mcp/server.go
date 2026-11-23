package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/httpapi"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	maxMCPBodyBytes     int64 = 64 * 1024
	maxSafeJSInteger          = 9007199254740991
)

var (
	isoDateRe        = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	sha256HexRe      = regexp.MustCompile(`^[0-9a-f]{64}$`)
	identTypeRe      = regexp.MustCompile(`^[A-Za-z0-9_]+$`)
	noNewlineRe      = regexp.MustCompile(`^[^\r\n]+$`)
	validStatusesSet = map[string]struct{}{
		"to_be_read": {},
		"reading":    {},
		"finished":   {},
		"dnf":        {},
	}
	allowedMetadataKeys = map[string]struct{}{
		"title":         {},
		"description":   {},
		"published":     {},
		"language":      {},
		"pages":         {},
		"publisherName": {},
		"seriesName":    {},
		"seriesIndex":   {},
		"authors":       {},
		"tags":          {},
		"identifiers":   {},
	}
)

func boolPtr(v bool) *bool { return &v }

func readOnlyAnnotations() *sdkmcp.ToolAnnotations {
	return &sdkmcp.ToolAnnotations{
		ReadOnlyHint:    true,
		DestructiveHint: boolPtr(false),
		OpenWorldHint:   boolPtr(false),
	}
}

func personalWriteAnnotations() *sdkmcp.ToolAnnotations {
	return &sdkmcp.ToolAnnotations{
		ReadOnlyHint:    false,
		DestructiveHint: boolPtr(false),
		OpenWorldHint:   boolPtr(false),
	}
}

func nonIdempotentWriteAnnotations() *sdkmcp.ToolAnnotations {
	return &sdkmcp.ToolAnnotations{
		ReadOnlyHint:    false,
		DestructiveHint: boolPtr(false),
		IdempotentHint:  false,
		OpenWorldHint:   boolPtr(false),
	}
}

func utf16Len(s string) int {
	return len(utf16.Encode([]rune(s)))
}

func isValidID(s string) bool {
	l := utf16Len(s)
	return l >= 1 && l <= 128
}

func parseStrictISODateLocal(s string) (int64, bool) {
	m := isoDateRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	if mo < 1 || mo > 12 || d < 1 || d > 31 {
		return 0, false
	}
	dt := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.Local)
	if dt.Year() != y || int(dt.Month()) != mo || dt.Day() != d {
		return 0, false
	}
	return dt.Unix(), true
}

func decodeToolArgs(req *sdkmcp.CallToolRequest) (map[string]json.RawMessage, error) {
	if req == nil || req.Params == nil || len(bytes.TrimSpace(req.Params.Arguments)) == 0 {
		return map[string]json.RawMessage{}, nil
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(req.Params.Arguments, &m); err != nil || m == nil {
		return nil, httpapi.NewError(http.StatusBadRequest, "Invalid tool arguments.")
	}
	return m, nil
}

func wrapToolResult(op func() (any, error)) (*sdkmcp.CallToolResult, error) {
	val, err := op()
	if err != nil {
		var httpErr *httpapi.HTTPError
		msg := "Delb could not complete the request."
		if errors.As(err, &httpErr) {
			switch httpErr.Status {
			case http.StatusNotFound:
				msg = "Book or shelf not found."
			case http.StatusForbidden:
				msg = "Connection does not permit this change."
			case http.StatusConflict:
				msg = "Book metadata changed. Read the book again before updating it."
			case http.StatusBadRequest:
				msg = httpErr.Message
			}
		}
		return &sdkmcp.CallToolResult{
			IsError: true,
			Content: []sdkmcp.Content{
				&sdkmcp.TextContent{Text: msg},
			},
		}, nil
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(val); err != nil {
		return &sdkmcp.CallToolResult{
			IsError: true,
			Content: []sdkmcp.Content{
				&sdkmcp.TextContent{Text: "Delb could not complete the request."},
			},
		}, nil
	}
	text := string(bytes.TrimSuffix(buf.Bytes(), []byte("\n")))
	return &sdkmcp.CallToolResult{
		Content: []sdkmcp.Content{
			&sdkmcp.TextContent{Text: text},
		},
	}, nil
}

func (s *Service) buildMCPServer(actor *Actor) *sdkmcp.Server {
	srv := sdkmcp.NewServer(&sdkmcp.Implementation{
		Name:    "delb",
		Version: "1.0.0",
	}, nil)

	idSchema := map[string]any{"type": "string", "minLength": 1, "maxLength": 128}
	statusValues := []string{"to_be_read", "reading", "finished", "dnf"}

	// 1. list_collections
	srv.AddTool(&sdkmcp.Tool{
		Name:        "list_collections",
		Description: "List your accessible collections.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Annotations: readOnlyAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			return s.listCollections(ctx, actor)
		})
	})

	// 2. search_books
	srv.AddTool(&sdkmcp.Tool{
		Name:        "search_books",
		Description: "Search or browse visible books by title, author, or identifier. Use nextCursor as after for the next page, keeping the same filters.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": map[string]any{"type": "string", "maxLength": 200, "default": ""},
				"statuses": map[string]any{
					"type":        "array",
					"description": "Limit results to the chosen personal statuses; none means no status.",
					"minItems":    1,
					"maxItems":    5,
					"items":       map[string]any{"type": "string", "enum": append(append([]string(nil), statusValues...), "none")},
				},
				"collectionId": idSchema,
				"shelfId":      idSchema,
				"after":        idSchema,
				"limit":        map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
			},
		},
		Annotations: readOnlyAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			in := searchBooksInput{Limit: 20}
			if raw, ok := args["query"]; ok {
				if err := json.Unmarshal(raw, &in.Query); err != nil || utf16Len(in.Query) > 200 {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid query.")
				}
			}
			if raw, ok := args["statuses"]; ok {
				var statuses []string
				if err := json.Unmarshal(raw, &statuses); err != nil || len(statuses) < 1 || len(statuses) > 5 {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid statuses filter.")
				}
				for _, st := range statuses {
					if st != "none" {
						if _, valid := validStatusesSet[st]; !valid {
							return nil, httpapi.NewError(http.StatusBadRequest, "Invalid status value.")
						}
					}
				}
				in.Statuses = statuses
			}
			if raw, ok := args["collectionId"]; ok {
				if err := json.Unmarshal(raw, &in.CollectionID); err != nil || !isValidID(in.CollectionID) {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid collectionId.")
				}
			}
			if raw, ok := args["shelfId"]; ok {
				if err := json.Unmarshal(raw, &in.ShelfID); err != nil || !isValidID(in.ShelfID) {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid shelfId.")
				}
			}
			if raw, ok := args["after"]; ok {
				if err := json.Unmarshal(raw, &in.After); err != nil || !isValidID(in.After) {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid after cursor.")
				}
			}
			if raw, ok := args["limit"]; ok {
				n, ok := parseStrictIntRange(raw, 1, 50)
				if !ok {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid limit.")
				}
				in.Limit = int(n)
			}
			return s.searchBooks(ctx, actor, in)
		})
	})

	// 3. get_book
	srv.AddTool(&sdkmcp.Tool{
		Name:        "get_book",
		Description: "Read book details, metadataVersion, your reading status and note. Truncated flags identify fields too large for safe replacement through MCP.",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{"bookId": idSchema},
			"required":   []string{"bookId"},
		},
		Annotations: readOnlyAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var bookID string
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}
			return s.getBook(ctx, actor, bookID)
		})
	})

	// 4. get_reading_progress
	srv.AddTool(&sdkmcp.Tool{
		Name:        "get_reading_progress",
		Description: "Read your recent progress history, book page count, saved reader percentage and progress-sync setting. History and saved reader location are separate.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"bookId": idSchema,
				"limit":  map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
			},
			"required": []string{"bookId"},
		},
		Annotations: readOnlyAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var bookID string
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}
			limit := 20
			if raw, ok := args["limit"]; ok {
				n, ok := parseStrictIntRange(raw, 1, 50)
				if !ok {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid limit.")
				}
				limit = int(n)
			}
			return s.getReadingProgress(ctx, actor, bookID, limit)
		})
	})

	// 5. log_reading_progress
	srv.AddTool(&sdkmcp.Tool{
		Name:        "log_reading_progress",
		Description: "Append a manual progress entry for your account by providing exactly one of pageNumber or progressPercent. Page numbers require a book page count. occurredAt is an optional YYYY-MM-DD date. This does not change the saved reader location or reading status; if progress sync is enabled, the reader may use the latest logged percentage when reopened. Each call adds a history entry, so check history before retrying an uncertain call.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"bookId":          idSchema,
				"progressPercent": map[string]any{"type": "number", "minimum": 0, "maximum": 100},
				"pageNumber":      map[string]any{"type": "integer", "minimum": 0},
				"occurredAt":      map[string]any{"type": "string", "format": "date"},
			},
			"required": []string{"bookId"},
		},
		Annotations: nonIdempotentWriteAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var bookID string
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}

			var progressPercent *float64
			if raw, ok := args["progressPercent"]; ok {
				var f float64
				if json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) || f < 0 || f > 100 {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid progressPercent.")
				}
				progressPercent = &f
			}

			var pageNumber *int64
			if raw, ok := args["pageNumber"]; ok {
				n, ok := parseStrictIntRange(raw, 0, maxSafeJSInteger)
				if !ok {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid pageNumber.")
				}
				pageNumber = &n
			}

			if (progressPercent == nil) == (pageNumber == nil) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Provide either a percentage or a page number.")
			}

			occurredSec := time.Now().UTC().Unix()
			if raw, ok := args["occurredAt"]; ok {
				var sDate string
				if json.Unmarshal(raw, &sDate) != nil {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid occurredAt date.")
				}
				sec, valid := parseStrictISODateLocal(sDate)
				if !valid {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid occurredAt date.")
				}
				occurredSec = sec
			}

			return s.logReadingProgress(ctx, actor, bookID, progressPercent, pageNumber, occurredSec)
		})
	})

	// 6. list_my_shelves
	srv.AddTool(&sdkmcp.Tool{
		Name:        "list_my_shelves",
		Description: "List your personal shelves.",
		InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		Annotations: readOnlyAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			return s.myShelves(ctx, actor)
		})
	})

	// 7. list_my_tbr
	srv.AddTool(&sdkmcp.Tool{
		Name:        "list_my_tbr",
		Description: "List your To be read queue in its saved order, including each private note. Use nextCursor as after to continue.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"after": idSchema,
				"limit": map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
			},
		},
		Annotations: readOnlyAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var after string
			if raw, ok := args["after"]; ok {
				if json.Unmarshal(raw, &after) != nil || !isValidID(after) {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid after cursor.")
				}
			}
			limit := 20
			if raw, ok := args["limit"]; ok {
				n, ok := parseStrictIntRange(raw, 1, 50)
				if !ok {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid limit.")
				}
				limit = int(n)
			}
			return s.listMyTbr(ctx, actor, after, limit)
		})
	})

	// 8. set_reading_status
	srv.AddTool(&sdkmcp.Tool{
		Name:        "set_reading_status",
		Description: "Change your reading status, dates, or TBR rank. Dates are YYYY-MM-DD; null clears a date, subject to Delb status rules. A TBR rank moves the book to that 1-based position in your global queue. Include only fields you want to change. Marking a book finished may update reading progress.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"bookId":     idSchema,
				"status":     map[string]any{"type": []string{"string", "null"}, "enum": []any{"to_be_read", "reading", "finished", "dnf", nil}},
				"startedAt":  map[string]any{"type": []string{"string", "null"}, "format": "date"},
				"finishedAt": map[string]any{"type": []string{"string", "null"}, "format": "date"},
				"dnfAt":      map[string]any{"type": []string{"string", "null"}, "format": "date"},
				"tbrRank":    map[string]any{"type": "integer", "minimum": 1, "maximum": 1000000},
			},
			"required": []string{"bookId"},
		},
		Annotations: personalWriteAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var bookID string
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}

			var ch books.StatusChange
			if raw, ok := args["status"]; ok {
				ch.StatusSet = true
				if strings.TrimSpace(string(raw)) != "null" {
					var st string
					if json.Unmarshal(raw, &st) != nil {
						return nil, httpapi.NewError(http.StatusBadRequest, "Invalid status.")
					}
					if _, valid := validStatusesSet[st]; !valid {
						return nil, httpapi.NewError(http.StatusBadRequest, "Invalid status.")
					}
					ch.Status = &st
				}
			}

			parseNullableDate := func(key string) (bool, *int64, error) {
				raw, ok := args[key]
				if !ok {
					return false, nil, nil
				}
				if strings.TrimSpace(string(raw)) == "null" {
					return true, nil, nil
				}
				var sDate string
				if json.Unmarshal(raw, &sDate) != nil {
					return false, nil, httpapi.NewError(http.StatusBadRequest, "Invalid "+key+" date.")
				}
				sec, valid := parseStrictISODateLocal(sDate)
				if !valid {
					return false, nil, httpapi.NewError(http.StatusBadRequest, "Invalid "+key+" date.")
				}
				return true, &sec, nil
			}

			var derr error
			if ch.StartedAtSet, ch.StartedAt, derr = parseNullableDate("startedAt"); derr != nil {
				return nil, derr
			}
			if ch.FinishedAtSet, ch.FinishedAt, derr = parseNullableDate("finishedAt"); derr != nil {
				return nil, derr
			}
			if ch.DnfAtSet, ch.DnfAt, derr = parseNullableDate("dnfAt"); derr != nil {
				return nil, derr
			}
			if raw, ok := args["tbrRank"]; ok {
				n, ok := parseStrictIntRange(raw, 1, 1000000)
				if !ok {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid tbrRank.")
				}
				v := int(n)
				ch.TbrRankSet = true
				ch.TbrRank = &v
			}

			if !ch.StatusSet && !ch.StartedAtSet && !ch.FinishedAtSet && !ch.DnfAtSet && !ch.TbrRankSet {
				return nil, httpapi.NewError(http.StatusBadRequest, "Choose a status, date, or TBR rank to change.")
			}

			return s.setStatus(ctx, actor, bookID, ch)
		})
	})

	// 9. set_tbr_note
	srv.AddTool(&sdkmcp.Tool{
		Name:        "set_tbr_note",
		Description: "Set or clear your private TBR note for an accessible book. An empty string clears it.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"bookId": idSchema,
				"note":   map[string]any{"type": "string", "maxLength": 10000},
			},
			"required": []string{"bookId", "note"},
		},
		Annotations: personalWriteAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var bookID, note string
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}
			if raw, ok := args["note"]; !ok || json.Unmarshal(raw, &note) != nil || utf16Len(note) > 10000 {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid note.")
			}
			return s.setTbrNote(ctx, actor, bookID, note)
		})
	})

	// 10. update_book_metadata
	srv.AddTool(&sdkmcp.Tool{
		Name:        "update_book_metadata",
		Description: "Update only the supplied shared catalog fields. Read get_book first and provide its metadataVersion to prevent overwriting later changes. Authors, tags and identifiers replace their entire lists. Requires metadata permission and collection editor access. Changing title or authors may move managed storage; inspect storageWarning.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"bookId":          idSchema,
				"expectedVersion": map[string]any{"type": "string", "pattern": "^[0-9a-f]{64}$"},
				"changes": map[string]any{
					"type":                 "object",
					"additionalProperties": false,
					"properties": map[string]any{
						"title":         map[string]any{"type": "string", "minLength": 1, "maxLength": 500},
						"description":   map[string]any{"type": []string{"string", "null"}, "maxLength": 12000},
						"published":     map[string]any{"type": []string{"string", "null"}, "maxLength": 100},
						"language":      map[string]any{"type": []string{"string", "null"}, "maxLength": 100},
						"pages":         map[string]any{"type": []string{"integer", "null"}, "minimum": 0, "maximum": 1000000},
						"publisherName": map[string]any{"type": []string{"string", "null"}, "maxLength": 300},
						"seriesName":    map[string]any{"type": []string{"string", "null"}, "maxLength": 300},
						"seriesIndex":   map[string]any{"type": []string{"number", "null"}},
						"authors":       map[string]any{"type": "array", "minItems": 1, "maxItems": 100, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 300}},
						"tags":          map[string]any{"type": []string{"array", "null"}, "maxItems": 100, "items": map[string]any{"type": "string", "minLength": 1, "maxLength": 300}},
						"identifiers": map[string]any{
							"type":     []string{"array", "null"},
							"maxItems": 100,
							"items": map[string]any{
								"type": "object",
								"properties": map[string]any{
									"type":  map[string]any{"type": "string", "pattern": "^[A-Za-z0-9_]+$", "maxLength": 50},
									"value": map[string]any{"type": "string", "minLength": 1, "maxLength": 300},
								},
								"required": []string{"type", "value"},
							},
						},
					},
				},
			},
			"required": []string{"bookId", "expectedVersion", "changes"},
		},
		Annotations: personalWriteAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var bookID, expectedVersion string
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}
			if raw, ok := args["expectedVersion"]; !ok || json.Unmarshal(raw, &expectedVersion) != nil || !sha256HexRe.MatchString(expectedVersion) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid expectedVersion.")
			}
			changesRaw, ok := args["changes"]
			if !ok {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid changes.")
			}
			var changes map[string]json.RawMessage
			if json.Unmarshal(changesRaw, &changes) != nil || changes == nil {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid changes.")
			}
			if len(changes) == 0 {
				return nil, httpapi.NewError(http.StatusBadRequest, "Choose metadata fields to change.")
			}
			for k := range changes {
				if _, allowed := allowedMetadataKeys[k]; !allowed {
					return nil, httpapi.NewError(http.StatusBadRequest, "Unknown metadata field: "+k)
				}
			}

			validated, err := validateAndConvertMetadataChanges(changes)
			if err != nil {
				return nil, err
			}
			return s.editMetadata(ctx, actor, bookID, expectedVersion, validated)
		})
	})

	// 11. set_shelf_membership
	srv.AddTool(&sdkmcp.Tool{
		Name:        "set_shelf_membership",
		Description: "Add or remove a visible book from one of your personal shelves.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"shelfId": idSchema,
				"bookId":  idSchema,
				"present": map[string]any{"type": "boolean"},
			},
			"required": []string{"shelfId", "bookId", "present"},
		},
		Annotations: personalWriteAnnotations(),
	}, func(ctx context.Context, req *sdkmcp.CallToolRequest) (*sdkmcp.CallToolResult, error) {
		return wrapToolResult(func() (any, error) {
			args, err := decodeToolArgs(req)
			if err != nil {
				return nil, err
			}
			var shelfID, bookID string
			var present bool
			if raw, ok := args["shelfId"]; !ok || json.Unmarshal(raw, &shelfID) != nil || !isValidID(shelfID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid shelfId.")
			}
			if raw, ok := args["bookId"]; !ok || json.Unmarshal(raw, &bookID) != nil || !isValidID(bookID) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid bookId.")
			}
			if raw, ok := args["present"]; !ok || json.Unmarshal(raw, &present) != nil {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid present flag.")
			}
			return s.setShelf(ctx, actor, shelfID, bookID, present)
		})
	})

	return srv
}

func parseStrictIntRange(raw json.RawMessage, minVal, maxVal int64) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || math.Trunc(f) != f {
		return 0, false
	}
	n := int64(f)
	if n < minVal || n > maxVal {
		return 0, false
	}
	return n, true
}

func validateAndConvertMetadataChanges(changes map[string]json.RawMessage) (map[string]json.RawMessage, error) {
	out := make(map[string]json.RawMessage, len(changes))

	if raw, ok := changes["title"]; ok {
		var s string
		if json.Unmarshal(raw, &s) != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid title.")
		}
		trimmed := strings.TrimSpace(s)
		if trimmed == "" || utf16Len(trimmed) > 500 {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid title.")
		}
		b, _ := json.Marshal(trimmed)
		out["title"] = b
	}

	validateNullableStr := func(key string, maxLen int) error {
		raw, ok := changes[key]
		if !ok {
			return nil
		}
		if strings.TrimSpace(string(raw)) == "null" {
			out[key] = json.RawMessage("null")
			return nil
		}
		var s string
		if json.Unmarshal(raw, &s) != nil || utf16Len(s) > maxLen {
			return httpapi.NewError(http.StatusBadRequest, "Invalid "+key+".")
		}
		out[key] = raw
		return nil
	}

	for _, field := range []struct {
		key    string
		maxLen int
	}{
		{"description", 12000},
		{"published", 100},
		{"language", 100},
		{"publisherName", 300},
		{"seriesName", 300},
	} {
		if err := validateNullableStr(field.key, field.maxLen); err != nil {
			return nil, err
		}
	}

	if raw, ok := changes["pages"]; ok {
		if strings.TrimSpace(string(raw)) == "null" {
			out["pages"] = json.RawMessage("null")
		} else {
			if _, ok := parseStrictIntRange(raw, 0, 1000000); !ok {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid pages.")
			}
			out["pages"] = raw
		}
	}

	if raw, ok := changes["seriesIndex"]; ok {
		if strings.TrimSpace(string(raw)) == "null" {
			out["seriesIndex"] = json.RawMessage("null")
		} else {
			var f float64
			if json.Unmarshal(raw, &f) != nil || math.IsNaN(f) || math.IsInf(f, 0) {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid seriesIndex.")
			}
			out["seriesIndex"] = raw
		}
	}

	if raw, ok := changes["authors"]; ok {
		var list []string
		if json.Unmarshal(raw, &list) != nil || len(list) < 1 || len(list) > 100 {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid authors.")
		}
		trimmed := make([]string, len(list))
		for i, a := range list {
			t := strings.TrimSpace(a)
			if t == "" || utf16Len(t) > 300 {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid author.")
			}
			trimmed[i] = t
		}
		b, _ := json.Marshal(trimmed)
		out["authors"] = b
	}

	if raw, ok := changes["tags"]; ok {
		if strings.TrimSpace(string(raw)) == "null" {
			out["tags"] = json.RawMessage("null")
		} else {
			var list []string
			if json.Unmarshal(raw, &list) != nil || len(list) > 100 {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid tags.")
			}
			trimmed := make([]string, len(list))
			for i, t := range list {
				s := strings.TrimSpace(t)
				if s == "" || utf16Len(s) > 300 {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid tag.")
				}
				trimmed[i] = s
			}
			b, _ := json.Marshal(trimmed)
			out["tags"] = b
		}
	}

	if raw, ok := changes["identifiers"]; ok {
		if strings.TrimSpace(string(raw)) == "null" {
			out["identifiers"] = json.RawMessage("null")
		} else {
			var list []struct {
				Type  *string `json:"type"`
				Value *string `json:"value"`
			}
			if json.Unmarshal(raw, &list) != nil || len(list) > 100 {
				return nil, httpapi.NewError(http.StatusBadRequest, "Invalid identifiers.")
			}
			lines := make([]string, 0, len(list))
			for _, it := range list {
				if it.Type == nil || it.Value == nil {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid identifier.")
				}
				t := *it.Type
				v := strings.TrimSpace(*it.Value)
				if !identTypeRe.MatchString(t) || utf16Len(t) > 50 || v == "" || utf16Len(v) > 300 || !noNewlineRe.MatchString(v) {
					return nil, httpapi.NewError(http.StatusBadRequest, "Invalid identifier.")
				}
				lines = append(lines, t+":"+v)
			}
			b, _ := json.Marshal(strings.Join(lines, "\n"))
			out["identifiers"] = b
		}
	}

	return out, nil
}

// /api/mcp mirrors server/api/mcp.ts using the official Go MCP SDK StreamableHTTPHandler.
func (s *Service) handleMCP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "private, no-store")

	// This endpoint is for MCP clients, not browser JavaScript.
	if r.Header.Get("Origin") != "" {
		httpapi.WriteError(w, http.StatusForbidden, "Browser origins are not allowed.")
		return
	}

	actor, err := s.authenticateConnection(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		s.logger.ErrorContext(r.Context(), "/api/mcp auth lookup failed", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	if actor == nil {
		s.logger.WarnContext(r.Context(), "mcp authentication rejected")
		w.Header().Set("WWW-Authenticate", "Bearer")
		httpapi.WriteError(w, http.StatusUnauthorized, "Invalid or expired connection.")
		return
	}
	httpapi.SetRequestUserID(r.Context(), actor.UserID)
	s.logger.DebugContext(r.Context(), "mcp request authenticated",
		"userId", actor.UserID,
		"connectionId", actor.ConnectionID,
		"method", r.Method,
	)

	if r.Method != http.MethodPost && r.Method != http.MethodGet && r.Method != http.MethodDelete {
		httpapi.WriteError(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return
	}

	handler := sdkmcp.NewStreamableHTTPHandler(func(_ *http.Request) *sdkmcp.Server {
		return s.buildMCPServer(actor)
	}, &sdkmcp.StreamableHTTPOptions{
		Stateless:                  true,
		MaxRequestBodyBytes:        maxMCPBodyBytes,
		DisableLocalhostProtection: true,
		Logger:                     s.logger,
	})
	handler.ServeHTTP(w, r)
}
