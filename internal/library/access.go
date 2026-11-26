// Package library holds the access rules for Delb's single shared library.
//
// The server owns every book. Server roles decide who can change the catalog,
// and per-user tag visibility rules decide which books an account can see. The
// visible_books SQL view (migration 0022) applies those rules, so every query
// that lists or loads books joins it on (user_id, book_id).
package library

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// Queryable is implemented by *sql.DB and *sql.Tx.
type Queryable interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// Server roles stored in users.role.
const (
	RoleOwner  = "owner"
	RoleAdmin  = "admin"
	RoleEditor = "editor"
	RoleReader = "reader"
)

// DefaultRole is the role that new accounts receive unless an administrator
// chooses another one.
const DefaultRole = RoleReader

// Tag rule modes stored in user_tag_rules.mode.
const (
	RuleAllow = "allow"
	RuleBlock = "block"
)

// LibraryScopeID is the scope_id of the shared library's bookshelf layout and
// bookshelf picture assets (scope_kind 'library').
const LibraryScopeID = "main"

// EditorRequiredMessage is returned when a reader tries to change the catalog.
const EditorRequiredMessage = "Editor or administrator access is required to change the library"

// VisibleBookFilter is an SQL predicate for a books row aliased as alias. It
// takes one argument: the user ID.
func VisibleBookFilter(alias string) string {
	return `EXISTS (SELECT 1 FROM visible_books vb WHERE vb.book_id = ` + alias + `.id AND vb.user_id = ?)`
}

// IsAdminRole reports whether role manages users, settings, and tag rules.
func IsAdminRole(role string) bool {
	role = strings.TrimSpace(role)
	return role == RoleOwner || role == RoleAdmin
}

// CanEditCatalogRole reports whether role can add, edit, and delete books.
func CanEditCatalogRole(role string) bool {
	return IsAdminRole(role) || strings.TrimSpace(role) == RoleEditor
}

// IsAssignableRole reports whether an administrator can assign role.
func IsAssignableRole(role string) bool {
	switch role {
	case RoleAdmin, RoleEditor, RoleReader:
		return true
	}
	return false
}

// UserRole returns the server role for userID, or "" if the user is missing.
func UserRole(ctx context.Context, q Queryable, userID string) (string, error) {
	var role string
	err := q.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ? LIMIT 1`, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return role, err
}

// CanEditCatalog reports whether userID can change the catalog.
func CanEditCatalog(ctx context.Context, q Queryable, userID string) (bool, error) {
	role, err := UserRole(ctx, q, userID)
	if err != nil {
		return false, err
	}
	return CanEditCatalogRole(role), nil
}

// RequireCatalogEditor returns a 403 error unless userID is an editor or admin.
func RequireCatalogEditor(ctx context.Context, q Queryable, userID string) error {
	ok, err := CanEditCatalog(ctx, q, userID)
	if err != nil {
		return err
	}
	if !ok {
		return httpapi.NewError(http.StatusForbidden, EditorRequiredMessage)
	}
	return nil
}

// RequireAdmin returns a 403 error unless userID is an administrator.
func RequireAdmin(ctx context.Context, q Queryable, userID string) error {
	role, err := UserRole(ctx, q, userID)
	if err != nil {
		return err
	}
	if !IsAdminRole(role) {
		return httpapi.NewError(http.StatusForbidden, "Administrator access required")
	}
	return nil
}

// IsBookVisible reports whether bookID exists and userID can see it.
func IsBookVisible(ctx context.Context, q Queryable, userID, bookID string) (bool, error) {
	var found int
	err := q.QueryRowContext(ctx, `
		SELECT 1 FROM visible_books WHERE user_id = ? AND book_id = ? LIMIT 1
	`, userID, bookID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// AssertBookVisible returns a 404 error unless userID can see bookID.
func AssertBookVisible(ctx context.Context, q Queryable, userID, bookID string) error {
	ok, err := IsBookVisible(ctx, q, userID, bookID)
	if err != nil {
		return err
	}
	if !ok {
		return httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	return nil
}

// AssertBookEditor returns 404 if userID cannot see bookID and 403 if userID
// cannot change the catalog.
func AssertBookEditor(ctx context.Context, q Queryable, userID, bookID string) error {
	if err := AssertBookVisible(ctx, q, userID, bookID); err != nil {
		return err
	}
	return RequireCatalogEditor(ctx, q, userID)
}

// HasTagRules reports whether userID has any tag visibility rules. Rules never
// apply to administrators, so this is false for them.
func HasTagRules(ctx context.Context, q Queryable, userID string) (bool, error) {
	role, err := UserRole(ctx, q, userID)
	if err != nil {
		return false, err
	}
	if IsAdminRole(role) {
		return false, nil
	}
	var found int
	err = q.QueryRowContext(ctx, `SELECT 1 FROM user_tag_rules WHERE user_id = ? LIMIT 1`, userID).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
