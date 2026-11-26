package collections

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/httpapi"
)

// Queryable is implemented by *sql.DB and *sql.Tx.
type Queryable interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type queryable = Queryable

type collectionRecord struct {
	ID          string
	Name        string
	OwnerUserID string
	IsDefault   bool
	IsPersonal  bool
	CreatedAt   int64
	UpdatedAt   int64
}

func collectionModelState(ctx context.Context, q queryable) (string, error) {
	var val string
	err := q.QueryRowContext(ctx, `SELECT value FROM system_state WHERE key = 'collections-model' LIMIT 1`).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "pending", nil
	}
	if err != nil {
		return "", err
	}
	return val, nil
}

func requireCollectionModel(ctx context.Context, q queryable) error {
	state, err := collectionModelState(ctx, q)
	if err != nil {
		return err
	}
	if state != "exclusive" {
		return httpapi.NewError(http.StatusServiceUnavailable, httpapi.CollectionMigrationRequiredMessage)
	}
	return nil
}

// RequireCollectionModel verifies that collections-model == 'exclusive'.
func RequireCollectionModel(ctx context.Context, q Queryable) error {
	return requireCollectionModel(ctx, q)
}

func lockCollectionChanges(ctx context.Context, q queryable) error {
	_, err := q.ExecContext(ctx, `UPDATE system_state SET value = value WHERE key = 'collections-model'`)
	return err
}

// LockCollectionChanges serializes collection and book ownership mutations.
func LockCollectionChanges(ctx context.Context, q Queryable) error {
	return lockCollectionChanges(ctx, q)
}

func assertCollectionEditor(ctx context.Context, q queryable, userID, collectionID string) error {
	var role string
	err := q.QueryRowContext(ctx, `
		SELECT role FROM collection_members WHERE user_id = ? AND collection_id = ? LIMIT 1
	`, userID, collectionID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && role != "owner" && role != "editor") {
		return httpapi.NewError(http.StatusForbidden, "Owner or editor access to the collection is required")
	}
	return err
}

// AssertCollectionEditor verifies that userID is an owner or editor of collectionID.
func AssertCollectionEditor(ctx context.Context, q Queryable, userID, collectionID string) error {
	return assertCollectionEditor(ctx, q, userID, collectionID)
}

// collectionIsPrivate is used with collections aliased as c. The default can
// enroll new accounts, so it is shared even before another member joins.
const collectionIsPrivate = `c.is_default = 0 AND NOT EXISTS (
	SELECT 1 FROM collection_members other
	WHERE other.collection_id = c.id AND other.user_id <> c.owner_user_id
)`

// AssertCollectionPrivate checks a destination after its edit access has been verified.
func AssertCollectionPrivate(ctx context.Context, q Queryable, userID, collectionID string) error {
	var private bool
	err := q.QueryRowContext(ctx, `
		SELECT `+collectionIsPrivate+` FROM collections c
		WHERE c.id = ? AND c.owner_user_id = ?
	`, collectionID, userID).Scan(&private)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !private) {
		return httpapi.NewError(http.StatusConflict, "Choose a private collection or a different name. To import into a shared collection, select it and confirm.")
	}
	return err
}

// AssertBookEditor mirrors server/utils/collections/model.ts assertBookEditor:
// returns 404 if the book is not visible to userID, 403 if the user lacks owner/editor role,
// and returns the book's collection_id on success.
func AssertBookEditor(ctx context.Context, q Queryable, userID, bookID string) (string, error) {
	var collectionID string
	err := q.QueryRowContext(ctx, `
		SELECT b.collection_id
		FROM books b
		INNER JOIN collection_members cm
			ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id = ?
		LIMIT 1
	`, userID, bookID).Scan(&collectionID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if err != nil {
		return "", err
	}
	if err := assertCollectionEditor(ctx, q, userID, collectionID); err != nil {
		return "", err
	}
	return collectionID, nil
}

// ResolveBookTarget mirrors server/utils/collections/model.ts resolveBookTarget.
// If provided is false, or ids is empty, resolves the default collection.
func ResolveBookTarget(ctx context.Context, q Queryable, userID string, provided bool, ids []string) (string, error) {
	if err := requireCollectionModel(ctx, q); err != nil {
		return "", err
	}
	var unique []string
	if provided {
		seen := make(map[string]struct{}, len(ids))
		for _, raw := range ids {
			trimmed := strings.TrimSpace(raw)
			if trimmed == "" {
				return "", httpapi.NewError(http.StatusBadRequest, "Choose exactly one collection")
			}
			if _, ok := seen[trimmed]; !ok {
				seen[trimmed] = struct{}{}
				unique = append(unique, trimmed)
			}
		}
	}
	if len(unique) > 1 {
		return "", httpapi.NewError(http.StatusBadRequest, "A book belongs to exactly one collection")
	}
	var id string
	if len(unique) == 1 {
		id = unique[0]
	} else {
		err := q.QueryRowContext(ctx, `SELECT id FROM collections WHERE is_default = 1 LIMIT 1`).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			id = ""
		} else if err != nil {
			return "", err
		}
	}
	if id == "" {
		return "", httpapi.NewError(http.StatusConflict, "No default collection is configured. Choose a collection.")
	}
	if err := assertCollectionEditor(ctx, q, userID, id); err != nil {
		return "", err
	}
	return id, nil
}

func assertCollectionAdmin(ctx context.Context, q queryable, userID string) error {
	var role string
	err := q.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ? LIMIT 1`, userID).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && role != "admin" && role != "owner") {
		return httpapi.NewError(http.StatusForbidden, "Administrator access required")
	}
	return err
}

func findCollectionByID(ctx context.Context, q queryable, collectionID string) (*collectionRecord, error) {
	var (
		c          collectionRecord
		isDefault  int64
		isPersonal int64
	)
	err := q.QueryRowContext(ctx, `
		SELECT id, name, owner_user_id, is_default, is_personal, created_at, updated_at
		FROM collections
		WHERE id = ?
		LIMIT 1
	`, collectionID).Scan(&c.ID, &c.Name, &c.OwnerUserID, &isDefault, &isPersonal, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.IsDefault = isDefault != 0
	c.IsPersonal = isPersonal != 0
	return &c, nil
}

func assertCollectionManager(ctx context.Context, q queryable, userID, collectionID string, ownerOnly bool) (*collectionRecord, error) {
	c, err := findCollectionByID(ctx, q, collectionID)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, httpapi.NewError(http.StatusNotFound, "Collection not found")
	}

	var actorRole string
	err = q.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ? LIMIT 1`, userID).Scan(&actorRole)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if actorRole == "admin" || actorRole == "owner" {
		return c, nil
	}
	if ownerOnly {
		if c.OwnerUserID != userID {
			return nil, httpapi.NewError(http.StatusForbidden, "Collection owner access required")
		}
		return c, nil
	}
	if err := assertCollectionEditor(ctx, q, userID, collectionID); err != nil {
		return nil, err
	}
	return c, nil
}

func ChangeDefaultCollection(ctx context.Context, db *sql.DB, userID, collectionID string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(ctx, tx); err != nil {
		return err
	}
	if err := assertCollectionAdmin(ctx, tx, userID); err != nil {
		return err
	}
	if err := requireCollectionModel(ctx, tx); err != nil {
		return err
	}
	target, err := findCollectionByID(ctx, tx, collectionID)
	if err != nil {
		return err
	}
	if target == nil {
		return httpapi.NewError(http.StatusNotFound, "Collection not found")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE collections SET is_default = 0 WHERE is_default = 1`); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE collections SET is_default = 1 WHERE id = ?`, collectionID); err != nil {
		return err
	}
	return tx.Commit()
}

// MoveCollectionBooks atomically moves books to targetID, verifying editor
// permissions on both source and destination collections and updating
// collection_bookshelves revisions.
func MoveCollectionBooks(ctx context.Context, db *sql.DB, userID string, bookIDs []string, targetID string, expectedSourceID string) (int, error) {
	var expected map[string]string
	if expectedSourceID != "" {
		expected = make(map[string]string, len(bookIDs))
		for _, id := range bookIDs {
			expected[id] = expectedSourceID
		}
	}
	return MoveCollectionBooksWithExpected(ctx, db, userID, bookIDs, targetID, expected)
}

// MoveCollectionBooksWithExpected atomically moves books to targetID, checking
// optional per-book expected source collections.
func MoveCollectionBooksWithExpected(ctx context.Context, db *sql.DB, userID string, bookIDs []string, targetID string, expectedSources map[string]string) (int, error) {
	if len(bookIDs) == 0 {
		return 0, httpapi.NewError(http.StatusBadRequest, "Choose books to move")
	}

	uniqueIDs := dedupeStrings(bookIDs)

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(ctx, tx); err != nil {
		return 0, err
	}
	if err := requireCollectionModel(ctx, tx); err != nil {
		return 0, err
	}
	if err := assertCollectionEditor(ctx, tx, userID, targetID); err != nil {
		return 0, err
	}

	// Fetch books visible to userID.
	type bookSourceRow struct {
		ID           string
		CollectionID string
	}
	placeholders := makePlaceholders(len(uniqueIDs))
	args := make([]any, 0, len(uniqueIDs)+1)
	args = append(args, userID)
	for _, id := range uniqueIDs {
		args = append(args, id)
	}

	rows, err := tx.QueryContext(ctx, `
		SELECT b.id, b.collection_id
		FROM books b
		INNER JOIN collection_members cm
			ON cm.collection_id = b.collection_id AND cm.user_id = ?
		WHERE b.id IN (`+placeholders+`)
	`, args...)
	if err != nil {
		return 0, err
	}
	var found []bookSourceRow
	for rows.Next() {
		var r bookSourceRow
		if err := rows.Scan(&r.ID, &r.CollectionID); err != nil {
			_ = rows.Close()
			return 0, err
		}
		found = append(found, r)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	if len(found) != len(uniqueIDs) {
		return 0, httpapi.NewError(http.StatusNotFound, "Book not found")
	}
	if len(expectedSources) > 0 {
		for _, row := range found {
			if row.CollectionID != expectedSources[row.ID] {
				return 0, httpapi.NewError(http.StatusConflict, "The source collection changed. Review the move again.")
			}
		}
	}

	// Verify editor permissions on every source collection and group books by source.
	sourceBooks := make(map[string]map[string]struct{})
	sourceOrder := make([]string, 0)
	for _, row := range found {
		if _, ok := sourceBooks[row.CollectionID]; !ok {
			sourceBooks[row.CollectionID] = make(map[string]struct{})
			sourceOrder = append(sourceOrder, row.CollectionID)
		}
		sourceBooks[row.CollectionID][row.ID] = struct{}{}
	}
	for _, sourceID := range sourceOrder {
		if err := assertCollectionEditor(ctx, tx, userID, sourceID); err != nil {
			return 0, err
		}
	}

	anyChanged := false
	for _, sourceID := range sourceOrder {
		if sourceID == targetID {
			continue
		}
		anyChanged = true
		if err := recordShelfBookMove(ctx, tx, sourceID, sourceBooks[sourceID]); err != nil {
			return 0, err
		}
	}
	if anyChanged {
		if err := recordShelfBookMove(ctx, tx, targetID, map[string]struct{}{}); err != nil {
			return 0, err
		}
	}

	now := time.Now().UTC().Unix()
	updArgs := make([]any, 0, len(found)+3)
	updArgs = append(updArgs, targetID, userID, now)
	for _, row := range found {
		updArgs = append(updArgs, row.ID)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE books
		SET collection_id = ?, added_by_user_id = ?, added_at = ?
		WHERE id IN (`+makePlaceholders(len(found))+`)
	`, updArgs...); err != nil {
		return 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(found), nil
}

func makePlaceholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimRight(strings.Repeat("?,", n), ",")
}

func dedupeStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
