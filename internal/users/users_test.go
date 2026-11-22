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
	// User owning a collection cannot be deleted -> 409
	if _, err := opened.DB.ExecContext(ctx, `
		INSERT INTO collections (id, name, owner_user_id, is_personal, is_default, created_at, updated_at)
		VALUES ('owned-col', 'Owned', ?, 0, 0, 0, 0)
	`, memberID); err != nil {
		t.Fatalf("insert owned collection: %v", err)
	}
	if code := del(ownerCookie, map[string]any{"id": memberID}); code != http.StatusConflict {
		t.Fatalf("delete user with owned collection = %d, want 409", code)
	}
	// Remove owned collection, now delete succeeds -> 200
	if _, err := opened.DB.ExecContext(ctx, `DELETE FROM collections WHERE id = 'owned-col'`); err != nil {
		t.Fatalf("delete owned collection: %v", err)
	}
	if code := del(ownerCookie, map[string]any{"id": memberID}); code != http.StatusOK {
		t.Fatalf("delete user = %d, want 200", code)
	}
	// Deleting nonexistent user -> 404
	if code := del(ownerCookie, map[string]any{"id": memberID}); code != http.StatusNotFound {
		t.Fatalf("delete missing user = %d, want 404", code)
	}
}
