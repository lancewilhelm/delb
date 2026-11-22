package books

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/storage"
)

const (
	googleBooksEndpoint = "https://www.googleapis.com/books/v1/volumes"
	hardcoverEndpoint   = "https://api.hardcover.app/v1/graphql"
	hardcoverQuery      = `
query SearchBooks($query: String!) {
  search(query: $query, query_type: "Book", per_page: 50) {
    results
  }
}
`
)

var (
	bearerPrefixRe   = regexp.MustCompile(`(?i)^Bearer\s+`)
	dateOnlyYMDRe    = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})$`)
	identStripDashRe = regexp.MustCompile(`[\s-]+`)
)

func (s *Service) getHardcoverToken(ctx context.Context) (string, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM global_secrets WHERE id = 'hardcoverToken' LIMIT 1`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return bearerPrefixRe.ReplaceAllString(strings.TrimSpace(raw), ""), nil
}

func (s *Service) getDefaultMetadataProvider(ctx context.Context) string {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT settings FROM global_settings LIMIT 1`).Scan(&raw)
	if err != nil || strings.TrimSpace(raw) == "" {
		return "googleBooks"
	}
	var obj map[string]any
	if json.Unmarshal([]byte(raw), &obj) == nil {
		if prov, ok := obj["metadataProvider"].(string); ok && prov == "hardcover" {
			return "hardcover"
		}
	}
	return "googleBooks"
}

// GET /api/books/metadata/search
func (s *Service) handleMetadataSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		httpapi.WriteError(w, http.StatusBadRequest, `Search query parameter "q" is required`)
		return
	}
	u, _ := url.Parse(googleBooksEndpoint)
	params := u.Query()
	params.Set("q", q)
	params.Set("maxResults", "20")
	u.RawQuery = params.Encode()

	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, u.String(), nil)
	if err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch metadata from Google Books")
		return
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		s.logger.Error("GET /api/books/metadata/search upstream error", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch metadata from Google Books")
		return
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch metadata from Google Books")
		return
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 5*1024*1024))
	if err != nil {
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch metadata from Google Books")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func toFloatPtr(v any) *float64 {
	switch x := v.(type) {
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return nil
		}
		return &x
	case string:
		s := strings.TrimSpace(x)
		if s == "" {
			return nil
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return &f
		}
	}
	return nil
}

func toStringSlice(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			if t := strings.TrimSpace(s); t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

func (s *Service) queryHardcoverRaw(ctx context.Context, token, query, userAgent string) (any, error) {
	payload, _ := json.Marshal(map[string]any{
		"query":     hardcoverQuery,
		"variables": map[string]string{"query": query},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hardcoverEndpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("User-Agent", userAgent)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	rawBytes, err := io.ReadAll(io.LimitReader(resp.Body, 10*1024*1024))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, httpapi.NewError(http.StatusBadGateway, "Hardcover upstream error")
	}
	var gqlResp struct {
		Data struct {
			Search struct {
				Results any `json:"results"`
			} `json:"search"`
		} `json:"data"`
		Errors any `json:"errors"`
	}
	if err := json.Unmarshal(rawBytes, &gqlResp); err != nil {
		return nil, err
	}
	if gqlResp.Errors != nil {
		errJSON, _ := json.Marshal(gqlResp.Errors)
		return nil, httpapi.NewError(http.StatusBadGateway, "Hardcover GraphQL errors: "+string(errJSON))
	}
	parsed := gqlResp.Data.Search.Results
	if sVal, ok := parsed.(string); ok {
		var obj any
		if json.Unmarshal([]byte(sVal), &obj) == nil {
			parsed = obj
		} else {
			parsed = map[string]any{}
		}
	}
	return parsed, nil
}

// GET /api/books/metadata/hardcover/search
func (s *Service) handleHardcoverSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	if q == "" {
		httpapi.WriteError(w, http.StatusBadRequest, `Search query parameter "q" is required`)
		return
	}
	token, err := s.getHardcoverToken(r.Context())
	if err != nil {
		s.writeErr(w, "GET /api/books/metadata/hardcover/search token failed", err)
		return
	}
	if token == "" {
		httpapi.WriteError(w, http.StatusPreconditionFailed, "Hardcover token is not configured. Set it in Admin Settings → Metadata.")
		return
	}

	parsed, err := s.queryHardcoverRaw(r.Context(), token, q, "Delb/HardcoverMetadataProxy")
	if err != nil {
		s.logger.Error("Hardcover API error", "error", err)
		httpapi.WriteError(w, http.StatusInternalServerError, "Failed to fetch metadata from Hardcover")
		return
	}

	var hits []any
	if obj, ok := parsed.(map[string]any); ok {
		if arr, ok := obj["hits"].([]any); ok {
			hits = arr
		}
	}

	mapped := make([]map[string]any, 0, len(hits))
	for _, rawHit := range hits {
		hitObj, _ := rawHit.(map[string]any)
		doc, _ := hitObj["document"].(map[string]any)
		if doc == nil {
			doc = map[string]any{}
		}

		contribTypes := toStringSlice(doc["contribution_types"])
		hasCoverArtist, hasIllustrator, hasContributor, hasCreator, hasAuthor := false, false, false, false, false
		for _, ct := range contribTypes {
			switch strings.ToLower(ct) {
			case "cover artist":
				hasCoverArtist = true
			case "illustrator":
				hasIllustrator = true
			case "contributor":
				hasContributor = true
			case "creator":
				hasCreator = true
			case "author":
				hasAuthor = true
			}
		}

		var authors []string
		if contribs, ok := doc["contributions"].([]any); ok {
			var names []string
			for _, rawC := range contribs {
				cObj, _ := rawC.(map[string]any)
				aObj, _ := cObj["author"].(map[string]any)
				name, _ := aObj["name"].(string)
				name = strings.TrimSpace(name)
				if name == "" {
					continue
				}
				roleRaw, _ := cObj["contribution"].(string)
				role := strings.ToLower(strings.TrimSpace(roleRaw))
				if role == "cover artist" || role == "illustrator" {
					continue
				}
				if role == "author" {
					names = append(names, name)
					continue
				}
				if role == "" && (hasAuthor || hasCoverArtist || hasIllustrator || hasContributor || hasCreator) {
					names = append(names, name)
				}
			}
			authors = uniqByLower(names)
		}
		if len(authors) == 0 {
			authors = uniqByLower(toStringSlice(doc["author_names"]))
		}
		if authors == nil {
			authors = make([]string, 0)
		}

		genres := uniqByLower(toStringSlice(doc["genres"]))
		if genres == nil {
			genres = make([]string, 0)
		}

		var hardcoverID string
		switch v := doc["id"].(type) {
		case string:
			hardcoverID = v
		case float64:
			hardcoverID = strconv.FormatInt(int64(v), 10)
		}
		idents := make([]IdentifierInput, 0, 1)
		if hardcoverID != "" {
			idents = append(idents, IdentifierInput{Type: "hardcover", Value: hardcoverID})
		}

		var published *string
		if rd, ok := doc["release_date"].(string); ok {
			if m := dateOnlyYMDRe.FindStringSubmatch(strings.TrimSpace(rd)); m != nil {
				sVal := m[1]
				published = &sVal
			}
		}
		pages := toFloatPtr(doc["pages"])

		var seriesName *string
		var seriesIdx *float64
		if fs, ok := doc["featured_series"].(map[string]any); ok {
			if sObj, ok := fs["series"].(map[string]any); ok {
				if n, ok := sObj["name"].(string); ok {
					seriesName = &n
				}
			}
			seriesIdx = toFloatPtr(fs["details"])
			if seriesIdx == nil {
				seriesIdx = toFloatPtr(fs["position"])
			}
		}

		var cover *string
		if imgObj, ok := doc["image"].(map[string]any); ok {
			if u, ok := imgObj["url"].(string); ok {
				cover = &u
			}
		}
		title, _ := doc["title"].(string)
		desc, _ := doc["description"].(string)
		slug, _ := doc["slug"].(string)

		mapped = append(mapped, map[string]any{
			"id":             doc["id"],
			"title":          title,
			"authors":        authors,
			"cover":          cover,
			"description":    desc,
			"hardcover_slug": slug,
			"genres":         genres,
			"identifiers":    idents,
			"published":      published,
			"pages":          pages,
			"series":         seriesName,
			"seriesIndex":    seriesIdx,
		})
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"query":   q,
			"results": mapped,
			"raw":     parsed,
		},
	})
}

// GET /api/books/metadata/cover
func (s *Service) handleMetadataCover(w http.ResponseWriter, r *http.Request) {
	urlRaw := strings.TrimSpace(r.URL.Query().Get("url"))
	if urlRaw == "" {
		httpapi.WriteError(w, http.StatusBadRequest, `Missing "url"`)
		return
	}
	fetcher := DefaultExternalImageFetcher()
	imgBytes, contentType, err := fetcher.Fetch(r.Context(), urlRaw)
	if err != nil {
		s.writeErr(w, "GET /api/books/metadata/cover failed", err)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Content-Length", strconv.Itoa(len(imgBytes)))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(imgBytes)
}

type googleVolumeInfo struct {
	Title               string `json:"title,omitempty"`
	Authors             []string `json:"authors,omitempty"`
	Publisher           string `json:"publisher,omitempty"`
	PublishedDate       string `json:"publishedDate,omitempty"`
	Description         string `json:"description,omitempty"`
	IndustryIdentifiers []struct {
		Type       string `json:"type"`
		Identifier string `json:"identifier"`
	} `json:"industryIdentifiers,omitempty"`
	PageCount   *float64 `json:"pageCount,omitempty"`
	Categories  []string `json:"categories,omitempty"`
	Series      string   `json:"series,omitempty"`
	SeriesIndex *float64 `json:"seriesIndex,omitempty"`
	ImageLinks  *struct {
		Thumbnail      string `json:"thumbnail,omitempty"`
		SmallThumbnail string `json:"smallThumbnail,omitempty"`
	} `json:"imageLinks,omitempty"`
	Language string `json:"language,omitempty"`
}

type googleBookItem struct {
	ID         string           `json:"id"`
	VolumeInfo googleVolumeInfo `json:"volumeInfo"`
}

func (s *Service) fetchTopMetadataItem(ctx context.Context, query string) (string, *googleBookItem, error) {
	provider := s.getDefaultMetadataProvider(ctx)
	if provider == "hardcover" {
		token, err := s.getHardcoverToken(ctx)
		if err != nil {
			return provider, nil, err
		}
		if token == "" {
			return provider, nil, httpapi.NewError(http.StatusPreconditionFailed, "Hardcover token is not configured. Set it in Admin Settings → Metadata.")
		}
		parsed, err := s.queryHardcoverRaw(ctx, token, query, "delb/HardcoverMetadataProxy")
		if err != nil {
			var httpErr *httpapi.HTTPError
			if errors.As(err, &httpErr) {
				return provider, nil, httpErr
			}
			return provider, nil, httpapi.NewError(http.StatusBadGateway, "Failed to fetch metadata from Hardcover.")
		}
		var topDoc map[string]any
		if obj, ok := parsed.(map[string]any); ok {
			if hits, ok := obj["hits"].([]any); ok && len(hits) > 0 {
				if h, ok := hits[0].(map[string]any); ok {
					topDoc, _ = h["document"].(map[string]any)
				}
			}
		}
		if topDoc == nil {
			return provider, nil, httpapi.NewError(http.StatusNotFound, "No results found.")
		}
		var idStr string
		switch v := topDoc["id"].(type) {
		case string:
			idStr = v
		case float64:
			idStr = strconv.FormatInt(int64(v), 10)
		}
		title, _ := topDoc["title"].(string)
		desc, _ := topDoc["description"].(string)
		published, _ := topDoc["release_date"].(string)
		var seriesName string
		var seriesIdx *float64
		if fs, ok := topDoc["featured_series"].(map[string]any); ok {
			if so, ok := fs["series"].(map[string]any); ok {
				seriesName, _ = so["name"].(string)
			}
			seriesIdx = toFloatPtr(fs["details"])
			if seriesIdx == nil {
				seriesIdx = toFloatPtr(fs["position"])
			}
		}
		item := &googleBookItem{
			ID: idStr,
			VolumeInfo: googleVolumeInfo{
				Title:         strings.TrimSpace(title),
				Authors:       toStringSlice(topDoc["author_names"]),
				PublishedDate: strings.TrimSpace(published),
				Description:   strings.TrimSpace(desc),
				Categories:    toStringSlice(topDoc["genres"]),
				PageCount:     toFloatPtr(topDoc["pages"]),
				Series:        strings.TrimSpace(seriesName),
				SeriesIndex:   seriesIdx,
			},
		}
		if idStr != "" {
			norm := identStripDashRe.ReplaceAllString(strings.TrimSpace(idStr), "")
			if norm != "" {
				item.VolumeInfo.IndustryIdentifiers = []struct {
					Type       string `json:"type"`
					Identifier string `json:"identifier"`
				}{{Type: "HARDCOVER", Identifier: norm}}
			}
		}
		if imgObj, ok := topDoc["image"].(map[string]any); ok {
			if u, ok := imgObj["url"].(string); ok && strings.TrimSpace(u) != "" {
				item.VolumeInfo.ImageLinks = &struct {
					Thumbnail      string `json:"thumbnail,omitempty"`
					SmallThumbnail string `json:"smallThumbnail,omitempty"`
				}{Thumbnail: strings.TrimSpace(u)}
			}
		}
		return provider, item, nil
	}

	u, _ := url.Parse(googleBooksEndpoint)
	params := u.Query()
	params.Set("q", query)
	params.Set("maxResults", "1")
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return provider, nil, httpapi.NewError(http.StatusBadGateway, "Failed to fetch metadata from Google Books.")
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return provider, nil, httpapi.NewError(http.StatusBadGateway, "Failed to fetch metadata from Google Books.")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return provider, nil, httpapi.NewError(http.StatusBadGateway, "Failed to fetch metadata from Google Books.")
	}
	var gbResp struct {
		Items []googleBookItem `json:"items"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 5*1024*1024)).Decode(&gbResp); err != nil {
		return provider, nil, httpapi.NewError(http.StatusBadGateway, "Failed to fetch metadata from Google Books.")
	}
	if len(gbResp.Items) == 0 {
		return provider, nil, httpapi.NewError(http.StatusNotFound, "No results found.")
	}
	return provider, &gbResp.Items[0], nil
}

func normalizeProviderIdentifierType(raw string) string {
	t := strings.ToLower(strings.TrimSpace(raw))
	switch t {
	case "isbn_13", "isbn13", "isbn-13":
		return "isbn13"
	case "isbn_10", "isbn10", "isbn-10":
		return "isbn10"
	case "isbn":
		return "isbn"
	default:
		return t
	}
}

// POST /api/books/metadata-import/create
func (s *Service) handleMetadataImportCreate(w http.ResponseWriter, r *http.Request) {
	userID := httpapi.SessionFromContext(r.Context()).User.ID

	body, err := decodeBodyObject(r)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var query string
	if rawQ, ok := body["query"]; ok && strings.TrimSpace(string(rawQ)) != "null" {
		_ = json.Unmarshal(rawQ, &query)
		query = strings.TrimSpace(query)
	}

	var hasPhysicalCopy bool
	if rawPhys, ok := body["hasPhysicalCopy"]; ok {
		if json.Unmarshal(rawPhys, &hasPhysicalCopy) != nil || strings.TrimSpace(string(rawPhys)) == "null" {
			httpapi.WriteError(w, http.StatusBadRequest, `Invalid "hasPhysicalCopy" in request body`)
			return
		}
	}

	colProvided, colIDs, err := parseCollectionIDsField(body)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	collectionID, err := collections.ResolveBookTarget(r.Context(), s.db, userID, colProvided, colIDs)
	if err != nil {
		s.writeErr(w, "POST /api/books/metadata-import/create target failed", err)
		return
	}
	collectionIDs := []string{collectionID}

	var duplicateAction string
	if rawDA, ok := body["duplicateAction"]; ok {
		var da string
		if json.Unmarshal(rawDA, &da) == nil {
			da = strings.TrimSpace(da)
			if da == "add_new" || da == "use_existing" || da == "replace_existing" {
				duplicateAction = da
			}
		}
	}
	if duplicateAction == "" {
		if rawAD, ok := body["allowDuplicate"]; ok {
			var ad bool
			if json.Unmarshal(rawAD, &ad) == nil && ad {
				duplicateAction = "add_new"
			}
		}
	}

	var provider string
	if rawP, ok := body["provider"]; ok {
		var p string
		if json.Unmarshal(rawP, &p) == nil && (p == "googleBooks" || p == "hardcover") {
			provider = p
		}
	}

	var metadataItem *googleBookItem
	if rawItem, ok := body["item"]; ok {
		var rawObj map[string]json.RawMessage
		if json.Unmarshal(rawItem, &rawObj) != nil || rawObj == nil {
			httpapi.WriteError(w, http.StatusBadRequest, `Invalid "item" in request body`)
			return
		}
		var idCheck string
		var viCheck map[string]any
		if json.Unmarshal(rawObj["id"], &idCheck) != nil || strings.TrimSpace(idCheck) == "" ||
			json.Unmarshal(rawObj["volumeInfo"], &viCheck) != nil || viCheck == nil {
			httpapi.WriteError(w, http.StatusBadRequest, `Invalid "item" in request body`)
			return
		}
		var item googleBookItem
		if err := json.Unmarshal(rawItem, &item); err != nil {
			httpapi.WriteError(w, http.StatusBadRequest, `Invalid "item" in request body`)
			return
		}
		metadataItem = &item
	}

	if metadataItem == nil {
		if query == "" {
			httpapi.WriteError(w, http.StatusBadRequest, `Missing "query" in request body`)
			return
		}
		prov, item, err := s.fetchTopMetadataItem(r.Context(), query)
		if err != nil {
			s.writeErr(w, "POST /api/books/metadata-import/create fetch top failed", err)
			return
		}
		metadataItem = item
		provider = prov
	}
	if provider == "" {
		provider = "googleBooks"
	}

	vi := metadataItem.VolumeInfo
	title := strings.TrimSpace(vi.Title)
	if title == "" {
		title = "Untitled"
	}
	authorNames := uniqByLower(vi.Authors)
	if len(authorNames) == 0 {
		authorNames = []string{"Unknown Author"}
	}

	var description, language, published, publisherName, seriesName *string
	var publishedAt *int64
	if s := strings.TrimSpace(vi.Description); s != "" {
		description = &s
	}
	if s := strings.TrimSpace(vi.Language); s != "" {
		language = &s
	}
	if s := strings.TrimSpace(vi.PublishedDate); s != "" {
		published = &s
		publishedAt = NormalizePublishedAtUnix(s)
	}
	if s := strings.TrimSpace(vi.Publisher); s != "" {
		publisherName = &s
	}
	if s := strings.TrimSpace(vi.Series); s != "" {
		seriesName = &s
	}
	var seriesIndex *float64
	if vi.SeriesIndex != nil && !math.IsNaN(*vi.SeriesIndex) && !math.IsInf(*vi.SeriesIndex, 0) {
		v := *vi.SeriesIndex
		seriesIndex = &v
	}
	var pages *int64
	if vi.PageCount != nil && !math.IsNaN(*vi.PageCount) && !math.IsInf(*vi.PageCount, 0) {
		p := int64(*vi.PageCount)
		pages = &p
	}

	categories := uniqByLower(vi.Categories)
	identByType := make(map[string]IdentifierInput)
	var identOrder []string
	for _, rawIdent := range vi.IndustryIdentifiers {
		t := normalizeProviderIdentifierType(rawIdent.Type)
		v := identStripDashRe.ReplaceAllString(strings.TrimSpace(rawIdent.Identifier), "")
		if t == "" || v == "" {
			continue
		}
		if _, exists := identByType[t]; !exists {
			identOrder = append(identOrder, t)
		}
		identByType[t] = IdentifierInput{Type: t, Value: v}
	}
	industryIdentifiers := make([]IdentifierInput, 0, len(identOrder))
	for _, t := range identOrder {
		industryIdentifiers = append(industryIdentifiers, identByType[t])
	}

	var coverURL string
	if vi.ImageLinks != nil {
		rawCover := vi.ImageLinks.Thumbnail
		if rawCover == "" {
			rawCover = vi.ImageLinks.SmallThumbnail
		}
		if rawCover != "" {
			coverURL = strings.ReplaceAll(rawCover, "&edge=curl", "")
		}
	}

	candidates, err := FindPossibleDuplicates(r.Context(), s.db, userID, title, strings.Join(authorNames, ", "), industryIdentifiers, 8)
	if err != nil {
		s.writeErr(w, "POST /api/books/metadata-import/create dupes failed", err)
		return
	}

	var selectedExistingBookID string
	if rawEB, ok := body["existingBookId"]; ok {
		var eb string
		if json.Unmarshal(rawEB, &eb) == nil {
			selectedExistingBookID = strings.TrimSpace(eb)
		}
	}

	if len(candidates) > 0 && duplicateAction == "" {
		httpapi.WriteErrorWithData(w, http.StatusConflict, "Possible duplicate", map[string]any{
			"code": "possible_duplicate",
			"incoming": map[string]any{
				"title":       title,
				"author":      strings.Join(authorNames, ", "),
				"identifiers": industryIdentifiers,
				"query":       query,
				"provider":    provider,
			},
			"metadata": map[string]any{
				"provider": provider,
				"item":     metadataItem,
			},
			"candidates": candidates,
		})
		return
	}

	validateExistingDest := func(tx *sql.Tx, bookID string) error {
		target, err := collections.ResolveBookTarget(r.Context(), tx, userID, true, collectionIDs)
		if err != nil {
			return err
		}
		cur, err := collections.AssertBookEditor(r.Context(), tx, userID, bookID)
		if err != nil {
			return err
		}
		if cur != target {
			return httpapi.NewError(http.StatusConflict, "This entry belongs to another collection. Create an independent entry or use Move collection.")
		}
		return nil
	}

	// Duplicate resolution: use_existing
	if len(candidates) > 0 && duplicateAction == "use_existing" {
		useBookID := selectedExistingBookID
		if useBookID == "" {
			useBookID = candidates[0].Book.ID
		}
		allowed := false
		for _, c := range candidates {
			if c.Book.ID == useBookID {
				allowed = true
				break
			}
		}
		if !allowed {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid existingBookId for duplicate resolution")
			return
		}

		tx, err := s.db.BeginTx(r.Context(), nil)
		if err != nil {
			s.writeErr(w, "metadata-import use_existing tx failed", err)
			return
		}
		defer func() { _ = tx.Rollback() }()
		if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
			s.writeErr(w, "metadata-import use_existing lock failed", err)
			return
		}
		if err := validateExistingDest(tx, useBookID); err != nil {
			s.writeErr(w, "metadata-import use_existing validate failed", err)
			return
		}
		if hasPhysicalCopy {
			if _, err := tx.ExecContext(r.Context(), `
				UPDATE books SET has_physical_copy = 1, updated_at = ? WHERE id = ?
			`, time.Now().UTC().Unix(), useBookID); err != nil {
				s.writeErr(w, "metadata-import use_existing update failed", err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			s.writeErr(w, "metadata-import use_existing commit failed", err)
			return
		}
		var existingTitle string
		_ = s.db.QueryRowContext(r.Context(), `SELECT title FROM books WHERE id = ? LIMIT 1`, useBookID).Scan(&existingTitle)
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"book":                map[string]any{"id": useBookID, "title": existingTitle},
				"duplicateResolution": "use_existing",
				"provider":            provider,
				"query":               query,
				"collectionIds":       collectionIDs,
			},
		})
		return
	}

	// Duplicate resolution: replace_existing
	if len(candidates) > 0 && duplicateAction == "replace_existing" {
		replaceBookID := selectedExistingBookID
		if replaceBookID == "" {
			replaceBookID = candidates[0].Book.ID
		}
		allowed := false
		for _, c := range candidates {
			if c.Book.ID == replaceBookID {
				allowed = true
				break
			}
		}
		if !allowed {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid existingBookId for duplicate resolution")
			return
		}

		err := storage.WithBookStorageLock(r.Context(), s.libraryDir, replaceBookID, func() error {
			tx, err := s.db.BeginTx(r.Context(), nil)
			if err != nil {
				return err
			}
			defer func() { _ = tx.Rollback() }()
			if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
				return err
			}
			if err := validateExistingDest(tx, replaceBookID); err != nil {
				return err
			}

			var publisherID, seriesID *string
			var serIdxVal *float64
			if publisherName != nil {
				pid, err := findOrCreatePublisherByName(r.Context(), tx, *publisherName)
				if err != nil {
					return err
				}
				publisherID = &pid
			}
			if seriesName != nil {
				sid, err := findOrCreateSeriesByName(r.Context(), tx, *seriesName)
				if err != nil {
					return err
				}
				seriesID = &sid
				serIdxVal = seriesIndex
			}

			now := time.Now().UTC().Unix()
			if hasPhysicalCopy {
				if _, err := tx.ExecContext(r.Context(), `
					UPDATE books
					SET title = ?, sort_title = ?, description = ?, published = ?, published_at = ?,
					    language = ?, pages = ?, publisher_id = ?, series_id = ?, series_index = ?,
					    has_physical_copy = 1, updated_at = ?
					WHERE id = ?
				`, title, MakeTitleSortKey(title), description, published, publishedAt,
					language, pages, publisherID, seriesID, serIdxVal, now, replaceBookID); err != nil {
					return err
				}
			} else {
				if _, err := tx.ExecContext(r.Context(), `
					UPDATE books
					SET title = ?, sort_title = ?, description = ?, published = ?, published_at = ?,
					    language = ?, pages = ?, publisher_id = ?, series_id = ?, series_index = ?,
					    updated_at = ?
					WHERE id = ?
				`, title, MakeTitleSortKey(title), description, published, publishedAt,
					language, pages, publisherID, seriesID, serIdxVal, now, replaceBookID); err != nil {
					return err
				}
			}

			if _, err := tx.ExecContext(r.Context(), `DELETE FROM book_authors WHERE book_id = ?`, replaceBookID); err != nil {
				return err
			}
			for i, name := range authorNames {
				aid, err := findOrCreateAuthorByName(r.Context(), tx, name)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(r.Context(), `INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)`, replaceBookID, aid, i+1); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(r.Context(), `DELETE FROM book_tags WHERE book_id = ?`, replaceBookID); err != nil {
				return err
			}
			for _, name := range categories {
				tid, err := findOrCreateTagByName(r.Context(), tx, name)
				if err != nil {
					return err
				}
				if _, err := tx.ExecContext(r.Context(), `INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?)`, replaceBookID, tid); err != nil {
					return err
				}
			}
			if _, err := tx.ExecContext(r.Context(), `DELETE FROM book_identifiers WHERE book_id = ?`, replaceBookID); err != nil {
				return err
			}
			for _, ident := range industryIdentifiers {
				if _, err := tx.ExecContext(r.Context(), `INSERT INTO book_identifiers (book_id, type, value) VALUES (?, ?, ?)`, replaceBookID, ident.Type, ident.Value); err != nil {
					return err
				}
			}
			if err := tx.Commit(); err != nil {
				return err
			}

			// Ensure canonical directory & optional cover best-effort.
			s.ensureCanonicalDirBestEffort(authorNames, title, replaceBookID)
			if coverURL != "" {
				s.fetchAndAttachImportedCoverBestEffort(r.Context(), userID, collectionIDs, replaceBookID, authorNames, title, coverURL, validateExistingDest)
			}
			_, _ = storage.MoveBookStorageToCanonical(r.Context(), s.db, s.libraryDir, replaceBookID, func(tx *sql.Tx) error {
				if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
					return err
				}
				return validateExistingDest(tx, replaceBookID)
			})
			return nil
		})
		if err != nil {
			s.writeErr(w, "metadata-import replace_existing failed", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"book":                map[string]any{"id": replaceBookID, "title": title},
				"duplicateResolution": "replace_existing",
				"provider":            provider,
				"query":               query,
				"collectionIds":       collectionIDs,
			},
		})
		return
	}

	// Normal creation
	bookID := uuid.NewString()
	now := time.Now().UTC().Unix()
	physInt := 0
	if hasPhysicalCopy {
		physInt = 1
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "metadata-import create tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := collections.LockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "metadata-import create lock failed", err)
		return
	}
	if _, err := collections.ResolveBookTarget(r.Context(), tx, userID, true, collectionIDs); err != nil {
		s.writeErr(w, "metadata-import create target failed", err)
		return
	}

	var publisherID, seriesID *string
	var serIdxVal *float64
	if publisherName != nil {
		pid, err := findOrCreatePublisherByName(r.Context(), tx, *publisherName)
		if err != nil {
			s.writeErr(w, "metadata-import create publisher failed", err)
			return
		}
		publisherID = &pid
	}
	if seriesName != nil {
		sid, err := findOrCreateSeriesByName(r.Context(), tx, *seriesName)
		if err != nil {
			s.writeErr(w, "metadata-import create series failed", err)
			return
		}
		seriesID = &sid
		serIdxVal = seriesIndex
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO books (
			id, collection_id, added_by_user_id, added_at,
			title, sort_title, description, published, published_at,
			language, pages, has_physical_copy, publisher_id, series_id, series_index,
			created_by_user_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, bookID, collectionID, userID, now,
		title, MakeTitleSortKey(title), description, published, publishedAt,
		language, pages, physInt, publisherID, seriesID, serIdxVal,
		userID, now, now); err != nil {
		s.writeErr(w, "metadata-import create insert book failed", err)
		return
	}

	for i, name := range authorNames {
		aid, err := findOrCreateAuthorByName(r.Context(), tx, name)
		if err != nil {
			s.writeErr(w, "metadata-import create author failed", err)
			return
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO book_authors (book_id, author_id, position) VALUES (?, ?, ?)`, bookID, aid, i+1); err != nil {
			s.writeErr(w, "metadata-import create book_author failed", err)
			return
		}
	}
	for _, name := range categories {
		tid, err := findOrCreateTagByName(r.Context(), tx, name)
		if err != nil {
			s.writeErr(w, "metadata-import create tag failed", err)
			return
		}
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO book_tags (book_id, tag_id) VALUES (?, ?)`, bookID, tid); err != nil {
			s.writeErr(w, "metadata-import create book_tag failed", err)
			return
		}
	}
	for _, ident := range industryIdentifiers {
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO book_identifiers (book_id, type, value) VALUES (?, ?, ?)`, bookID, ident.Type, ident.Value); err != nil {
			s.writeErr(w, "metadata-import create ident failed", err)
			return
		}
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "metadata-import create commit failed", err)
		return
	}

	s.ensureCanonicalDirBestEffort(authorNames, title, bookID)
	if coverURL != "" {
		_ = storage.WithBookStorageLock(r.Context(), s.libraryDir, bookID, func() error {
			s.fetchAndAttachImportedCoverBestEffort(r.Context(), userID, collectionIDs, bookID, authorNames, title, coverURL, validateExistingDest)
			return nil
		})
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"book": map[string]any{
				"id":    bookID,
				"title": title,
			},
			"provider":      provider,
			"query":         query,
			"collectionIds": collectionIDs,
		},
	})
}

func (s *Service) ensureCanonicalDirBestEffort(authorNames []string, title, bookID string) {
	markerRel := storage.BuildBookStorageRelativePath(authorNames, title, bookID, "dir.marker")
	dirRel := path.Dir(markerRel)
	if abs, err := storage.ResolveUnderLibrary(s.libraryDir, dirRel); err == nil {
		_ = os.MkdirAll(abs, 0o755)
	}
}

func (s *Service) fetchAndAttachImportedCoverBestEffort(
	ctx context.Context,
	userID string,
	collectionIDs []string,
	bookID string,
	authorNames []string,
	title string,
	coverURL string,
	validateDest func(tx *sql.Tx, bookID string) error,
) {
	markerRel := storage.BuildBookStorageRelativePath(authorNames, title, bookID, "cover.thumb.webp")
	dirRel := path.Dir(markerRel)
	dirAbs, err := storage.ResolveUnderLibrary(s.libraryDir, dirRel)
	if err != nil {
		return
	}
	if err := os.MkdirAll(dirAbs, 0o755); err != nil {
		return
	}
	imgBytes, _, err := DefaultExternalImageFetcher().Fetch(ctx, coverURL)
	if err != nil {
		return
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := collections.LockCollectionChanges(ctx, tx); err != nil {
		return
	}
	if err := validateDest(tx, bookID); err != nil {
		return
	}
	_, thumb, _, err := EnsureCoverOutputsFromBytes(imgBytes, "", "", CoverProcessingOpts{
		OutputDirAbs:      dirAbs,
		OutputDirRelPosix: dirRel,
		SourceBaseName:    "cover.source",
		ThumbFileName:     "thumb.webp",
		ThumbMaxWidth:     320,
		DoNotOverwrite:    false,
	})
	if err != nil {
		return
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE books SET cover_image_path = ?, updated_at = ? WHERE id = ?
	`, thumb.RelativePath, time.Now().UTC().Unix(), bookID); err != nil {
		return
	}
	_ = tx.Commit()
}
