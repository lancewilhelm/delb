package mcp_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/books"
	"github.com/lancewilhelm/delb/internal/bookshelf"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	delbmcp "github.com/lancewilhelm/delb/internal/mcp"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpEnv struct {
	t   *testing.T
	db  *sql.DB
	srv *httptest.Server
}

func newMCPEnv(t *testing.T) *mcpEnv {
	t.Helper()
	ctx := context.Background()
	tmp := t.TempDir()
	libDir := filepath.Join(tmp, "library")
	opened, err := db.Open(ctx, "file:"+filepath.Join(tmp, "test.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	secret := "mcp-test-secret-0123456789abcdef0123456789"
	authSvc := auth.NewService(auth.ServiceOptions{DB: opened.DB, Secret: secret, Logger: discard})
	booksSvc := books.NewService(books.ServiceOptions{DB: opened.DB, AuthService: authSvc, LibraryDir: libDir, Logger: discard})
	shelfSvc := bookshelf.NewService(bookshelf.ServiceOptions{DB: opened.DB, AuthService: authSvc, TokenSecret: secret, Logger: discard})
	mcpSvc := delbmcp.NewService(delbmcp.ServiceOptions{
		DB:               opened.DB,
		AuthService:      authSvc,
		BooksService:     booksSvc,
		BookshelfService: shelfSvc,
		Logger:           discard,
	})
	handler := httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{booksSvc, shelfSvc, mcpSvc},
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return &mcpEnv{t: t, db: opened.DB, srv: srv}
}

type actorUser struct {
	ID     string
	Email  string
	Cookie string
}

func (e *mcpEnv) signUp(name, email string) actorUser {
	e.t.Helper()
	b, _ := json.Marshal(map[string]any{"name": name, "email": email, "password": "secret-password-12345"})
	req, _ := http.NewRequest(http.MethodPost, e.srv.URL+"/api/auth/sign-up/email", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", e.srv.URL)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		raw, _ := io.ReadAll(resp.Body)
		e.t.Fatalf("signup %s: %d %s", email, resp.StatusCode, string(raw))
	}
	var out struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	var cookies []string
	for _, c := range resp.Cookies() {
		cookies = append(cookies, c.Name+"="+c.Value)
	}
	return actorUser{ID: out.User.ID, Email: email, Cookie: strings.Join(cookies, "; ")}
}

func (e *mcpEnv) reqJSON(u *actorUser, method, path string, body any) (int, []byte) {
	e.t.Helper()
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rdr)
	req.Header.Set("Origin", e.srv.URL)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if u != nil {
		req.Header.Set("Cookie", u.Cookie)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

type authRoundTripper struct {
	token string
	base  http.RoundTripper
}

func (a authRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header.Set("Authorization", "Bearer "+a.token)
	return a.base.RoundTrip(clone)
}

func (e *mcpEnv) connectMCP(token string) *sdkmcp.ClientSession {
	e.t.Helper()
	client := sdkmcp.NewClient(&sdkmcp.Implementation{Name: "test-client", Version: "1.0"}, nil)
	httpClient := &http.Client{
		Transport: authRoundTripper{token: token, base: http.DefaultTransport},
	}
	sess, err := client.Connect(context.Background(), &sdkmcp.StreamableClientTransport{
		Endpoint:   e.srv.URL + "/api/mcp",
		HTTPClient: httpClient,
	}, nil)
	if err != nil {
		e.t.Fatalf("connectMCP: %v", err)
	}
	e.t.Cleanup(func() { _ = sess.Close() })
	return sess
}

func callToolJSON(t *testing.T, sess *sdkmcp.ClientSession, name string, args map[string]any) map[string]any {
	t.Helper()
	res, err := sess.CallTool(context.Background(), &sdkmcp.CallToolParams{
		Name:      name,
		Arguments: args,
	})
	if err != nil {
		t.Fatalf("CallTool %s error: %v", name, err)
	}
	if res.IsError {
		t.Fatalf("CallTool %s returned IsError=true: %+v", name, res.Content)
	}
	tc := res.Content[0].(*sdkmcp.TextContent)
	var out map[string]any
	if err := json.Unmarshal([]byte(tc.Text), &out); err != nil {
		t.Fatalf("CallTool %s unmarshal %q: %v", name, tc.Text, err)
	}
	return out
}

func callToolExpectErr(t *testing.T, sess *sdkmcp.ClientSession, name string, args map[string]any) string {
	t.Helper()
	res, err := sess.CallTool(context.Background(), &sdkmcp.CallToolParams{
		Name:      name,
		Arguments: args,
	})
	if err != nil {
		t.Fatalf("CallTool %s transport error: %v", name, err)
	}
	if !res.IsError {
		t.Fatalf("CallTool %s expected IsError=true, got %+v", name, res.Content)
	}
	return res.Content[0].(*sdkmcp.TextContent).Text
}

func TestMCPConnectionsAndServerParity(t *testing.T) {
	env := newMCPEnv(t)
	owner := env.signUp("Owner", "owner@example.invalid")
	outsider := env.signUp("Outsider", "outsider@example.invalid")

	// Create book, shelf
	_, bookRaw := env.reqJSON(&owner, http.MethodPost, "/api/books", map[string]any{
		"title":   "Earthsea",
		"authors": []string{"Ursula Le Guin"},
		"pages":   200,
	})
	var bookOut struct {
		Data struct {
			Book struct{ ID string } `json:"book"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bookRaw, &bookOut)
	bookID := bookOut.Data.Book.ID

	_, shelfRaw := env.reqJSON(&owner, http.MethodPost, "/api/shelves", map[string]any{"name": "Favs"})
	var shelfOut struct {
		Data struct{ ID string } `json:"data"`
	}
	_ = json.Unmarshal(shelfRaw, &shelfOut)
	shelfID := shelfOut.Data.ID

	// Create RO and RW connections
	status, roRaw := env.reqJSON(&owner, http.MethodPost, "/api/mcp-connections", map[string]any{
		"name":     "Reader",
		"canWrite": false,
	})
	if status != 200 {
		t.Fatalf("create RO connection: %d %s", status, string(roRaw))
	}
	var roConn struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	_ = json.Unmarshal(roRaw, &roConn)

	status, rwRaw := env.reqJSON(&owner, http.MethodPost, "/api/mcp-connections", map[string]any{
		"name":     "Writer",
		"canWrite": true,
	})
	if status != 200 {
		t.Fatalf("create RW connection: %d %s", status, string(rwRaw))
	}
	var rwConn struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	_ = json.Unmarshal(rwRaw, &rwConn)

	// Listing never leaks token
	status, listRaw := env.reqJSON(&owner, http.MethodGet, "/api/mcp-connections", nil)
	if status != 200 || strings.Contains(string(listRaw), roConn.Token) {
		t.Fatalf("listing failed or leaked token: %d %s", status, string(listRaw))
	}

	// Browser origin rejected on /api/mcp -> 403; unauth -> 401
	{
		req, _ := http.NewRequest(http.MethodPost, env.srv.URL+"/api/mcp", nil)
		resp, _ := http.DefaultClient.Do(req)
		resp.Body.Close()
		if resp.StatusCode != 401 || resp.Header.Get("WWW-Authenticate") != "Bearer" {
			t.Fatalf("unauth /api/mcp = %d www-auth=%q", resp.StatusCode, resp.Header.Get("WWW-Authenticate"))
		}

		req2, _ := http.NewRequest(http.MethodPost, env.srv.URL+"/api/mcp", nil)
		req2.Header.Set("Authorization", "Bearer "+rwConn.Token)
		req2.Header.Set("Origin", env.srv.URL)
		resp2, _ := http.DefaultClient.Do(req2)
		resp2.Body.Close()
		if resp2.StatusCode != 403 {
			t.Fatalf("origin /api/mcp = %d, want 403", resp2.StatusCode)
		}
	}

	// Legacy stateless 2025-03-26 JSON-RPC requests work without Mcp-Session-Id
	{
		initReq, _ := http.NewRequest(http.MethodPost, env.srv.URL+"/api/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"legacy","version":"1"}}}`)))
		initReq.Header.Set("Authorization", "Bearer "+roConn.Token)
		initReq.Header.Set("Content-Type", "application/json")
		initReq.Header.Set("Accept", "application/json, text/event-stream")
		resp, err := http.DefaultClient.Do(initReq)
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(b), "2025-03-26") {
			t.Fatalf("legacy init failed: %d %s", resp.StatusCode, string(b))
		}

		toolsReq, _ := http.NewRequest(http.MethodPost, env.srv.URL+"/api/mcp", bytes.NewReader([]byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)))
		toolsReq.Header.Set("Authorization", "Bearer "+roConn.Token)
		toolsReq.Header.Set("Content-Type", "application/json")
		toolsReq.Header.Set("Accept", "application/json, text/event-stream")
		toolsReq.Header.Set("MCP-Protocol-Version", "2025-03-26")
		resp2, err := http.DefaultClient.Do(toolsReq)
		if err != nil {
			t.Fatal(err)
		}
		b2, _ := io.ReadAll(resp2.Body)
		resp2.Body.Close()
		if resp2.StatusCode != 200 || !strings.Contains(string(b2), "search_books") {
			t.Fatalf("legacy tools/list failed: %d %s", resp2.StatusCode, string(b2))
		}
	}

	// Connect SDK clients
	roClient := env.connectMCP(roConn.Token)
	rwClient := env.connectMCP(rwConn.Token)

	// Verify all 11 tools + log_reading_progress idempotentHint == false
	toolsRes, err := rwClient.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}
	if len(toolsRes.Tools) != 11 {
		t.Fatalf("expected 11 MCP tools, got %d", len(toolsRes.Tools))
	}
	foundLogTool := false
	for _, tl := range toolsRes.Tools {
		if tl.Name == "log_reading_progress" {
			foundLogTool = true
			if tl.Annotations == nil || tl.Annotations.IdempotentHint {
				t.Fatalf("log_reading_progress must have idempotentHint=false, got %+v", tl.Annotations)
			}
		}
	}
	if !foundLogTool {
		t.Fatal("missing log_reading_progress tool")
	}

	// Read-only denied write; writer succeeds
	callToolExpectErr(t, roClient, "set_reading_status", map[string]any{"bookId": bookID, "status": "reading"})
	stOut := callToolJSON(t, rwClient, "set_reading_status", map[string]any{
		"bookId":    bookID,
		"status":    "reading",
		"startedAt": "2024-03-05",
	})
	if stOut["status"] != "reading" {
		t.Fatalf("set_reading_status = %v", stOut)
	}

	// Invalid calendar date returns isError=true
	callToolExpectErr(t, rwClient, "set_reading_status", map[string]any{
		"bookId":    bookID,
		"startedAt": "2024-02-31",
	})

	// Progress logging & page conversion
	logOut := callToolJSON(t, rwClient, "log_reading_progress", map[string]any{
		"bookId":     bookID,
		"pageNumber": 50,
		"occurredAt": "2024-03-10",
	})
	if logOut["progressPercent"] != float64(25) || logOut["pageNumber"] != float64(50) {
		t.Fatalf("log_reading_progress = %v", logOut)
	}
	progOut := callToolJSON(t, rwClient, "get_reading_progress", map[string]any{"bookId": bookID})
	if progOut["pageCount"] != float64(200) || len(progOut["history"].([]any)) != 1 {
		t.Fatalf("get_reading_progress = %v", progOut)
	}

	// TBR note & shelf membership
	callToolJSON(t, rwClient, "set_tbr_note", map[string]any{"bookId": bookID, "note": "  Must read  "})
	callToolJSON(t, rwClient, "set_shelf_membership", map[string]any{"shelfId": shelfID, "bookId": bookID, "present": true})
	srch := callToolJSON(t, rwClient, "search_books", map[string]any{"shelfId": shelfID})
	if len(srch["items"].([]any)) != 1 {
		t.Fatalf("expected 1 book on shelf, got %v", srch)
	}

	// Metadata update requires canEditMetadata permission + matching metadataVersion
	detail := callToolJSON(t, rwClient, "get_book", map[string]any{"bookId": bookID})
	ver := detail["metadataVersion"].(string)
	callToolExpectErr(t, rwClient, "update_book_metadata", map[string]any{
		"bookId":          bookID,
		"expectedVersion": ver,
		"changes":         map[string]any{"title": "Denied"},
	})

	// Outsider PATCH returns 404; owner PATCH enables metadata edits
	if st, _ := env.reqJSON(&outsider, http.MethodPatch, "/api/mcp-connections", map[string]any{
		"id":              rwConn.ID,
		"canEditMetadata": true,
	}); st != 404 {
		t.Fatalf("outsider PATCH = %d, want 404", st)
	}
	if st, _ := env.reqJSON(&owner, http.MethodPatch, "/api/mcp-connections", map[string]any{
		"id":              rwConn.ID,
		"canEditMetadata": true,
	}); st != 200 {
		t.Fatalf("owner PATCH = %d, want 200", st)
	}

	upd := callToolJSON(t, rwClient, "update_book_metadata", map[string]any{
		"bookId":          bookID,
		"expectedVersion": ver,
		"changes": map[string]any{
			"title":       "A Wizard of Earthsea",
			"tags":        []string{"Favorites"},
			"genres":      []string{"Fantasy"},
			"identifiers": []map[string]any{{"type": "isbn", "value": "9780547773742"}},
		},
	})
	updBook := upd["book"].(map[string]any)
	if updBook["title"] != "A Wizard of Earthsea" {
		t.Fatalf("update_book_metadata = %v", upd)
	}
	if genres, ok := updBook["genres"].([]any); !ok || len(genres) != 1 || genres[0] != "Fantasy" {
		t.Fatalf("update_book_metadata genres = %v, want [Fantasy]", updBook["genres"])
	}
	access := callToolJSON(t, rwClient, "get_library_access", map[string]any{})
	if access["role"] != "owner" || access["canEditCatalog"] != true || access["restrictedByTagRules"] != false {
		t.Fatalf("owner get_library_access = %v", access)
	}

	// A reader cannot change catalog metadata even with a metadata-enabled connection,
	// and tag visibility rules hide blocked books from MCP search and reads.
	status, readerRaw := env.reqJSON(&outsider, http.MethodPost, "/api/mcp-connections", map[string]any{
		"name":            "Reader writer",
		"canWrite":        true,
		"canEditMetadata": true,
	})
	if status != 200 {
		t.Fatalf("create reader connection: %d %s", status, string(readerRaw))
	}
	var readerConn struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	_ = json.Unmarshal(readerRaw, &readerConn)
	if st, raw := env.reqJSON(&outsider, http.MethodPatch, "/api/mcp-connections", map[string]any{
		"id":              readerConn.ID,
		"canEditMetadata": true,
	}); st != 200 {
		t.Fatalf("reader PATCH = %d %s", st, string(raw))
	}
	readerClient := env.connectMCP(readerConn.Token)
	readerAccess := callToolJSON(t, readerClient, "get_library_access", map[string]any{})
	if readerAccess["role"] != "reader" || readerAccess["canEditCatalog"] != false {
		t.Fatalf("reader get_library_access = %v", readerAccess)
	}
	readerDetail := callToolJSON(t, readerClient, "get_book", map[string]any{"bookId": bookID})
	if msg := callToolExpectErr(t, readerClient, "update_book_metadata", map[string]any{
		"bookId":          bookID,
		"expectedVersion": readerDetail["metadataVersion"].(string),
		"changes":         map[string]any{"title": "Reader edit"},
	}); !strings.Contains(msg, "Editor or administrator") {
		t.Fatalf("reader update_book_metadata message = %q", msg)
	}
	if _, err := env.db.Exec(`
		INSERT INTO user_tag_rules (user_id, tag_id, mode, created_at)
		SELECT u.id, t.id, 'block', 0 FROM users u, tags t
		WHERE u.email = 'outsider@example.invalid' AND t.name = 'Favorites'
	`); err != nil {
		t.Fatalf("add block rule: %v", err)
	}
	hidden := callToolJSON(t, readerClient, "search_books", map[string]any{"query": "Earthsea"})
	if len(hidden["items"].([]any)) != 0 {
		t.Fatalf("blocked book visible to reader in MCP search: %v", hidden)
	}
	callToolExpectErr(t, readerClient, "get_book", map[string]any{"bookId": bookID})
	if access := callToolJSON(t, readerClient, "get_library_access", map[string]any{}); access["restrictedByTagRules"] != true {
		t.Fatalf("restricted reader get_library_access = %v", access)
	}

	// Stale expectedVersion returns conflict isError=true
	msg := callToolExpectErr(t, rwClient, "update_book_metadata", map[string]any{
		"bookId":          bookID,
		"expectedVersion": ver,
		"changes":         map[string]any{"description": "Stale"},
	})
	if !strings.Contains(msg, "changed") {
		t.Fatalf("unexpected conflict message: %q", msg)
	}

	// Expiry rejects further calls
	if _, err := env.db.Exec(`UPDATE mcp_connections SET expires_at = ? WHERE id = ?`, time.Now().UnixMilli()-1000, roConn.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := roClient.CallTool(context.Background(), &sdkmcp.CallToolParams{Name: "list_my_shelves"}); err == nil {
		t.Fatal("expired token should be rejected with 401")
	}

	// Revocation rejects further calls
	if st, _ := env.reqJSON(&owner, http.MethodDelete, "/api/mcp-connections", map[string]any{"id": rwConn.ID}); st != 200 {
		t.Fatalf("DELETE connection = %d", st)
	}
	if _, err := rwClient.CallTool(context.Background(), &sdkmcp.CallToolParams{Name: "list_my_shelves"}); err == nil {
		t.Fatal("revoked token should be rejected with 401")
	}
}
