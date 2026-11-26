package users_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lancewilhelm/delb"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/db"
	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/users"
)

func TestDeleteUserGuardsAndSuccess(t *testing.T) {
	ctx := context.Background()
	opened, err := db.Open(ctx, "file:"+filepath.Join(t.TempDir(), "users.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}

	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:        opened.DB,
		Secret:    "users-test-secret-0123456789abcdef0123456789",
		Logger:    discard,
		RateLimit: auth.RateLimitConfig{Disabled: true},
	})
	usersSvc := users.NewService(users.ServiceOptions{
		DB:          opened.DB,
		AuthService: authSvc,
		Logger:      discard,
	})
	srv := httptest.NewServer(httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{usersSvc},
	}))
	t.Cleanup(srv.Close)

	signup := func(name, email string) (string, string) {
		b, _ := json.Marshal(map[string]any{
			"name":     name,
			"email":    email,
			"password": "super-secret-password",
		})
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/sign-up/email", bytes.NewReader(b))
		req.Header.Set("Origin", srv.URL)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("signup: %v", err)
		}
		defer resp.Body.Close()
		var parsed map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&parsed)
		var pairs []string
		for _, c := range resp.Cookies() {
			pairs = append(pairs, c.Name+"="+c.Value)
		}
		return parsed["user"].(map[string]any)["id"].(string), strings.Join(pairs, "; ")
	}

	del := func(cookie string, body any) int {
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(http.MethodDelete, srv.URL+"/api/users/delete", r)
		req.Header.Set("Origin", srv.URL)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		if cookie != "" {
			req.Header.Set("Cookie", cookie)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("DELETE /api/users/delete: %v", err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}

	ownerID, ownerCookie := signup("Owner", "owner@example.invalid")
	adminID, adminCookie := signup("Admin", "admin@example.invalid")
	memberID, memberCookie := signup("Member", "member@example.invalid")

	if _, err := opened.DB.ExecContext(ctx, `UPDATE users SET role = 'admin' WHERE id = ?`, adminID); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	// Unauthenticated -> 401
	if code := del("", map[string]any{"id": memberID}); code != http.StatusUnauthorized {
		t.Fatalf("unauth delete = %d, want 401", code)
	}
	// Missing id -> 400
	if code := del(ownerCookie, map[string]any{}); code != http.StatusBadRequest {
		t.Fatalf("missing id = %d, want 400", code)
	}
	// Non-admin -> 403
	if code := del(memberCookie, map[string]any{"id": adminID}); code != http.StatusForbidden {
		t.Fatalf("non-admin delete = %d, want 403", code)
	}
	// Admin cannot delete system owner -> 403
	if code := del(adminCookie, map[string]any{"id": ownerID}); code != http.StatusForbidden {
		t.Fatalf("delete owner = %d, want 403", code)
	}
	// A user who added books can still be deleted; the library keeps the books.
	if _, err := opened.DB.ExecContext(ctx, `
		INSERT INTO books (id, title, added_by_user_id, created_by_user_id, created_at, updated_at)
		VALUES ('kept-book', 'Kept', ?, ?, 0, 0)
	`, memberID, memberID); err != nil {
		t.Fatalf("insert member book: %v", err)
	}
	if code := del(ownerCookie, map[string]any{"id": memberID}); code != http.StatusOK {
		t.Fatalf("delete user = %d, want 200", code)
	}
	// Deleting nonexistent user -> 404
	if code := del(ownerCookie, map[string]any{"id": memberID}); code != http.StatusNotFound {
		t.Fatalf("delete missing user = %d, want 404", code)
	}
	var kept int
	if err := opened.DB.QueryRowContext(ctx, `SELECT count(*) FROM books WHERE id = 'kept-book' AND created_by_user_id IS NULL`).Scan(&kept); err != nil || kept != 1 {
		t.Fatalf("library book after user deletion = (%d, %v), want 1", kept, err)
	}
}

func TestTagRulesAdminOnlyAndVisibility(t *testing.T) {
	ctx := context.Background()
	opened, err := db.Open(ctx, "file:"+filepath.Join(t.TempDir(), "rules.db"))
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = opened.DB.Close() })
	if _, err := db.Migrate(ctx, opened.DB, opened.FilePath, opened.IsMemory, delb.MigrationsFS); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	discard := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(auth.ServiceOptions{
		DB:        opened.DB,
		Secret:    "users-test-secret-0123456789abcdef0123456789",
		Logger:    discard,
		RateLimit: auth.RateLimitConfig{Disabled: true},
	})
	usersSvc := users.NewService(users.ServiceOptions{DB: opened.DB, AuthService: authSvc, Logger: discard})
	srv := httptest.NewServer(httpapi.NewHandler(httpapi.RouterOptions{
		DB:          opened.DB,
		Logger:      discard,
		AuthService: authSvc,
		Services:    []httpapi.RouteRegistrar{usersSvc},
	}))
	t.Cleanup(srv.Close)

	signup := func(name, email string) (string, string) {
		b, _ := json.Marshal(map[string]any{"name": name, "email": email, "password": "super-secret-password"})
		req, _ := http.NewRequest(http.MethodPost, srv.URL+"/api/auth/sign-up/email", bytes.NewReader(b))
		req.Header.Set("Origin", srv.URL)
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("signup: %v", err)
		}
		defer resp.Body.Close()
		var parsed map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&parsed)
		var pairs []string
		for _, c := range resp.Cookies() {
			pairs = append(pairs, c.Name+"="+c.Value)
		}
		u := parsed["user"].(map[string]any)
		return u["id"].(string) + "|" + u["role"].(string), strings.Join(pairs, "; ")
	}
	call := func(cookie, method, path string, body any) (int, map[string]any) {
		var r io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			r = bytes.NewReader(b)
		}
		req, _ := http.NewRequest(method, srv.URL+path, r)
		req.Header.Set("Origin", srv.URL)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Cookie", cookie)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("%s %s: %v", method, path, err)
		}
		defer resp.Body.Close()
		var parsed map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&parsed)
		return resp.StatusCode, parsed
	}

	ownerRef, ownerCookie := signup("Owner", "owner@example.invalid")
	readerRef, readerCookie := signup("Reader", "reader@example.invalid")
	ownerID, ownerRole, _ := strings.Cut(ownerRef, "|")
	readerID, readerRole, _ := strings.Cut(readerRef, "|")
	if ownerRole != "owner" || readerRole != "reader" {
		t.Fatalf("roles after sign-up = (%q, %q), want (owner, reader)", ownerRole, readerRole)
	}

	for _, stmt := range []string{
		`INSERT INTO tags (id, name, created_at, updated_at) VALUES ('t-kids', 'kids', 0, 0), ('t-adult', 'adult', 0, 0)`,
		`INSERT INTO books (id, title, created_at, updated_at) VALUES ('b-kids', 'Kids', 0, 0), ('b-adult', 'Adult', 0, 0), ('b-plain', 'Plain', 0, 0)`,
		`INSERT INTO book_tags (book_id, tag_id) VALUES ('b-kids', 't-kids'), ('b-adult', 't-adult')`,
	} {
		if _, err := opened.DB.ExecContext(ctx, stmt); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	visible := func(userID string) string {
		var ids string
		if err := opened.DB.QueryRowContext(ctx, `
			SELECT COALESCE(group_concat(book_id, ','), '') FROM (
				SELECT book_id FROM visible_books WHERE user_id = ? ORDER BY book_id
			)`, userID).Scan(&ids); err != nil {
			t.Fatalf("visible books: %v", err)
		}
		return ids
	}
	rulesPath := "/api/settings/admin/users/" + readerID + "/tag-rules"

	if code, _ := call(readerCookie, http.MethodGet, rulesPath, nil); code != http.StatusForbidden {
		t.Fatalf("reader GET rules = %d, want 403", code)
	}
	if code, _ := call(readerCookie, http.MethodPut, rulesPath, map[string]any{"allowTagIds": []string{}, "blockTagIds": []string{}}); code != http.StatusForbidden {
		t.Fatalf("reader PUT rules = %d, want 403", code)
	}
	if got := visible(readerID); got != "b-adult,b-kids,b-plain" {
		t.Fatalf("reader without rules sees %q", got)
	}

	if code, body := call(ownerCookie, http.MethodPut, rulesPath, map[string]any{"allowTagIds": []string{}, "blockTagIds": []string{"t-adult"}}); code != http.StatusOK {
		t.Fatalf("PUT block rule = %d %v", code, body)
	}
	if got := visible(readerID); got != "b-kids,b-plain" {
		t.Fatalf("reader with block rule sees %q", got)
	}

	code, body := call(ownerCookie, http.MethodPut, rulesPath, map[string]any{"allowTagIds": []string{"t-kids"}, "blockTagIds": []string{"t-adult"}})
	if code != http.StatusOK {
		t.Fatalf("PUT allow rule = %d %v", code, body)
	}
	data := body["data"].(map[string]any)
	if len(data["allowTags"].([]any)) != 1 || len(data["blockTags"].([]any)) != 1 {
		t.Fatalf("PUT response = %v", data)
	}
	if got := visible(readerID); got != "b-kids" {
		t.Fatalf("reader with allow rule sees %q", got)
	}
	if code, body := call(ownerCookie, http.MethodGet, rulesPath, nil); code != http.StatusOK ||
		body["data"].(map[string]any)["allowTags"].([]any)[0].(map[string]any)["name"] != "kids" {
		t.Fatalf("GET rules = %d %v", code, body)
	}

	if code, _ := call(ownerCookie, http.MethodPut, rulesPath, map[string]any{"allowTagIds": []string{"t-kids"}, "blockTagIds": []string{"t-kids"}}); code != http.StatusBadRequest {
		t.Fatalf("overlapping rules = %d, want 400", code)
	}
	if code, _ := call(ownerCookie, http.MethodPut, rulesPath, map[string]any{"allowTagIds": []string{"missing"}, "blockTagIds": []string{}}); code != http.StatusBadRequest {
		t.Fatalf("unknown tag = %d, want 400", code)
	}
	if code, _ := call(ownerCookie, http.MethodPut, "/api/settings/admin/users/"+ownerID+"/tag-rules", map[string]any{"allowTagIds": []string{}, "blockTagIds": []string{"t-adult"}}); code != http.StatusConflict {
		t.Fatalf("rules on admin = %d, want 409", code)
	}
	if code, _ := call(ownerCookie, http.MethodGet, "/api/settings/admin/users/missing/tag-rules", nil); code != http.StatusNotFound {
		t.Fatalf("rules for missing user = %d, want 404", code)
	}

	// A tag that a rule uses cannot be deleted, so a restricted reader never
	// silently gains access to the whole library.
	if _, err := opened.DB.ExecContext(ctx, `DELETE FROM tags WHERE id = 't-kids'`); err == nil {
		t.Fatalf("deleting a tag used by a rule succeeded, want a foreign key error")
	}
	if _, err := opened.DB.ExecContext(ctx, `DELETE FROM book_tags WHERE tag_id = 't-kids'`); err != nil {
		t.Fatalf("untag kids book: %v", err)
	}
	if got := visible(readerID); got != "" {
		t.Fatalf("reader after untagging allowed book sees %q", got)
	}
	if got := visible(ownerID); got != "b-adult,b-kids,b-plain" {
		t.Fatalf("owner sees %q", got)
	}
}
