package collections

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/auth"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	iso8601Millis     = "2006-01-02T15:04:05.000Z"
	maxBulkBookSelect = 10000
)

type ServiceOptions struct {
	DB          *sql.DB
	AuthService *auth.Service
	LibraryDir  string
	Logger      *slog.Logger
}

type Service struct {
	db         *sql.DB
	auth       *auth.Service
	libraryDir string
	logger     *slog.Logger
}

func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	libraryDir := opts.LibraryDir
	if libraryDir == "" {
		libraryDir = "library"
	}
	return &Service{
		db:         opts.DB,
		auth:       opts.AuthService,
		libraryDir: libraryDir,
		logger:     logger,
	}
}

// RegisterRoutes mounts the Phase 2A Collections and Collection Migration
// endpoints onto mux. Note that /api/collections/{id}/bookshelf is intentionally
// NOT registered here so it falls through to the Nitro upstream proxy until Phase 2C.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/collections", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleListCollections))
	mux.HandleFunc("POST /api/collections", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleCreateCollection))
	mux.HandleFunc("PUT /api/collections/{id}", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleUpdateCollection))
	mux.HandleFunc("DELETE /api/collections/{id}", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleDeleteCollection))

	mux.HandleFunc("GET /api/collections/{id}/members", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleListMembers))
	mux.HandleFunc("PUT /api/collections/{id}/members", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleUpsertMember))
	mux.HandleFunc("DELETE /api/collections/{id}/members/{userId}", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleRemoveMember))
	mux.HandleFunc("POST /api/collections/{id}/leave", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleLeaveCollection))
	mux.HandleFunc("POST /api/collections/{id}/transfer-ownership", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleTransferOwnership))
	mux.HandleFunc("POST /api/collections/{id}/books/bulk", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleBulkMoveBooks))

	mux.HandleFunc("GET /api/settings/admin/collections", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleAdminListCollections))
	mux.HandleFunc("PUT /api/settings/admin/collections/default", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleAdminSetDefault))
	mux.HandleFunc("GET /api/settings/admin/collections-migration", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleGetMigration))
	mux.HandleFunc("POST /api/settings/admin/collections-migration", httpapi.RequireSessionFunc(s.auth, s.logger, s.handleApplyMigration))
}

func (s *Service) handleListCollections(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User

	type item struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		OwnerUserID string `json:"ownerUserId"`
		IsDefault   bool   `json:"isDefault"`
		Role        string `json:"role"`
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT c.id, c.name, c.owner_user_id, c.is_default, cm.role
		FROM collection_members cm
		INNER JOIN collections c ON c.id = cm.collection_id
		WHERE cm.user_id = ?
	`, actor.ID)
	if err != nil {
		s.writeErr(w, "GET /api/collections failed", err)
		return
	}
	defer func() { _ = rows.Close() }()

	out := make([]item, 0)
	for rows.Next() {
		var (
			it        item
			isDefault int64
		)
		if err := rows.Scan(&it.ID, &it.Name, &it.OwnerUserID, &isDefault, &it.Role); err != nil {
			s.writeErr(w, "GET /api/collections scan failed", err)
			return
		}
		it.IsDefault = isDefault != 0
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		s.writeErr(w, "GET /api/collections rows error", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"collections": out,
		},
	})
}

func (s *Service) handleCreateCollection(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User

	var body struct {
		Name json.RawMessage `json:"name"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	name, err := parseCollectionName(body.Name)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "POST /api/collections begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "POST /api/collections lock failed", err)
		return
	}

	var existingID string
	err = tx.QueryRowContext(r.Context(), `
		SELECT id FROM collections WHERE owner_user_id = ? AND name = ? LIMIT 1
	`, actor.ID, name).Scan(&existingID)
	if err == nil {
		if err := tx.Commit(); err != nil {
			s.writeErr(w, "POST /api/collections commit failed", err)
			return
		}
		httpapi.WriteJSON(w, http.StatusOK, map[string]any{
			"success": true,
			"data": map[string]any{
				"collection": map[string]any{"id": existingID, "name": name},
				"created":    false,
			},
		})
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		s.writeErr(w, "POST /api/collections lookup failed", err)
		return
	}

	id := uuid.NewString()
	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO collections (id, name, owner_user_id, is_personal, is_default, created_at, updated_at)
		VALUES (?, ?, ?, 0, 0, ?, ?)
	`, id, name, actor.ID, now, now); err != nil {
		s.writeErr(w, "POST /api/collections insert failed", err)
		return
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "POST /api/collections commit failed", err)
		return
	}

	ts := time.Unix(now, 0).UTC().Format(iso8601Millis)
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"collection": map[string]any{
				"id":          id,
				"name":        name,
				"ownerUserId": actor.ID,
				"isDefault":   false,
				"isPersonal":  false,
				"createdAt":   ts,
				"updatedAt":   ts,
			},
			"created": true,
		},
	})
}

func (s *Service) handleUpdateCollection(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}

	var body struct {
		Name json.RawMessage `json:"name"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	name, err := parseCollectionName(body.Name)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id} begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "PUT /api/collections/{id} lock failed", err)
		return
	}
	if _, err := assertCollectionManager(r.Context(), tx, actor.ID, id, false); err != nil {
		s.writeErr(w, "PUT /api/collections/{id} authorize failed", err)
		return
	}
	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE collections SET name = ?, updated_at = ? WHERE id = ?
	`, name, now, id); err != nil {
		s.writeErr(w, "PUT /api/collections/{id} update failed", err)
		return
	}
	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/collections/{id} commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"collection": map[string]any{"id": id, "name": name},
		},
	})
}

func (s *Service) handleDeleteCollection(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}

	var body struct {
		ConfirmationName json.RawMessage `json:"confirmationName"`
		DeleteBooks      json.RawMessage `json:"deleteBooks"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var confirmationName string
	var deleteBooks bool
	if len(body.ConfirmationName) == 0 || string(body.ConfirmationName) == "null" ||
		json.Unmarshal(body.ConfirmationName, &confirmationName) != nil ||
		json.Unmarshal(body.DeleteBooks, &deleteBooks) != nil || !deleteBooks {
		httpapi.WriteError(w, http.StatusBadRequest, "Confirm deletion of the collection and its books with the collection name")
		return
	}

	res, err := DeleteCollection(r.Context(), DeleteCollectionOptions{
		DB:               s.db,
		LibraryRoot:      s.libraryDir,
		UserID:           actor.ID,
		CollectionID:     id,
		ConfirmationName: confirmationName,
	})
	if err != nil {
		s.writeErr(w, "DELETE /api/collections/{id} failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "collection deleted",
		"actorUserId", actor.ID,
		"collectionId", id,
		"deletedBooks", res.DeletedBooks,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"deleted":      true,
			"id":           id,
			"deletedBooks": res.DeletedBooks,
		},
	})
}

func (s *Service) handleListMembers(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}
	if _, err := assertCollectionManager(r.Context(), s.db, actor.ID, id, false); err != nil {
		s.writeErr(w, "GET /api/collections/{id}/members authorize failed", err)
		return
	}

	type member struct {
		UserID string `json:"userId"`
		Email  string `json:"email"`
		Role   string `json:"role"`
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT u.id, u.email, cm.role
		FROM collection_members cm
		INNER JOIN users u ON u.id = cm.user_id
		WHERE cm.collection_id = ?
	`, id)
	if err != nil {
		s.writeErr(w, "GET /api/collections/{id}/members query failed", err)
		return
	}
	defer func() { _ = rows.Close() }()

	members := make([]member, 0)
	for rows.Next() {
		var m member
		if err := rows.Scan(&m.UserID, &m.Email, &m.Role); err != nil {
			s.writeErr(w, "GET /api/collections/{id}/members scan failed", err)
			return
		}
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		s.writeErr(w, "GET /api/collections/{id}/members rows err", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"members": members,
		},
	})
}

func (s *Service) handleUpsertMember(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}

	var body struct {
		Email json.RawMessage `json:"email"`
		Role  json.RawMessage `json:"role"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	email, err := parseMemberEmail(body.Email)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var role string
	if len(body.Role) == 0 || json.Unmarshal(body.Role, &role) != nil || (role != "editor" && role != "viewer") {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose editor or viewer")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/members begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/members lock failed", err)
		return
	}
	collection, err := assertCollectionManager(r.Context(), tx, actor.ID, id, false)
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/members authorize failed", err)
		return
	}

	var targetID string
	err = tx.QueryRowContext(r.Context(), `SELECT id FROM users WHERE email = ? LIMIT 1`, email).Scan(&targetID)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "User not found")
		return
	}
	if err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/members user lookup failed", err)
		return
	}

	if targetID == actor.ID {
		httpapi.WriteError(w, http.StatusBadRequest, "You cannot change your own role")
		return
	}
	if targetID == collection.OwnerUserID {
		httpapi.WriteError(w, http.StatusBadRequest, "Use ownership transfer to change the owner")
		return
	}

	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO collection_members (collection_id, user_id, role, created_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(collection_id, user_id) DO UPDATE SET role = excluded.role
	`, id, targetID, role, now); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/members upsert failed", err)
		return
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "PUT /api/collections/{id}/members commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"member": map[string]string{
				"userId": targetID,
				"role":   role,
			},
		},
	})
}

func (s *Service) handleRemoveMember(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	targetID := r.PathValue("userId")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}
	if targetID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "User id is required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "DELETE /api/collections/{id}/members/{userId} begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "DELETE /api/collections/{id}/members/{userId} lock failed", err)
		return
	}
	collection, err := assertCollectionManager(r.Context(), tx, actor.ID, id, false)
	if err != nil {
		s.writeErr(w, "DELETE /api/collections/{id}/members/{userId} authorize failed", err)
		return
	}
	if targetID == collection.OwnerUserID {
		httpapi.WriteError(w, http.StatusBadRequest, "Transfer ownership before removing the owner")
		return
	}
	if targetID == actor.ID {
		httpapi.WriteError(w, http.StatusBadRequest, "Use Leave collection to remove your own membership")
		return
	}

	res, err := tx.ExecContext(r.Context(), `
		DELETE FROM collection_members WHERE collection_id = ? AND user_id = ?
	`, id, targetID)
	if err != nil {
		s.writeErr(w, "DELETE /api/collections/{id}/members/{userId} delete failed", err)
		return
	}
	n, _ := res.RowsAffected()

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "DELETE /api/collections/{id}/members/{userId} commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]bool{
			"removed": n > 0,
		},
	})
}

func (s *Service) handleLeaveCollection(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "POST /api/collections/{id}/leave begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/leave lock failed", err)
		return
	}
	collection, err := findCollectionByID(r.Context(), tx, id)
	if err != nil {
		s.writeErr(w, "POST /api/collections/{id}/leave lookup failed", err)
		return
	}
	if collection == nil {
		httpapi.WriteError(w, http.StatusNotFound, "Collection not found")
		return
	}
	if collection.OwnerUserID == actor.ID {
		httpapi.WriteError(w, http.StatusBadRequest, "Transfer ownership before leaving this collection")
		return
	}

	res, err := tx.ExecContext(r.Context(), `
		DELETE FROM collection_members WHERE collection_id = ? AND user_id = ?
	`, id, actor.ID)
	if err != nil {
		s.writeErr(w, "POST /api/collections/{id}/leave delete failed", err)
		return
	}
	n, _ := res.RowsAffected()

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/leave commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]bool{
			"left": n > 0,
		},
	})
}

func (s *Service) handleTransferOwnership(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	id := r.PathValue("id")
	if id == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}

	var body struct {
		Email json.RawMessage `json:"email"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	email, err := parseMemberEmail(body.Email)
	if err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		s.writeErr(w, "POST /api/collections/{id}/transfer-ownership begin tx failed", err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if err := lockCollectionChanges(r.Context(), tx); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/transfer-ownership lock failed", err)
		return
	}
	if _, err := assertCollectionManager(r.Context(), tx, actor.ID, id, true); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/transfer-ownership authorize failed", err)
		return
	}

	var targetID string
	err = tx.QueryRowContext(r.Context(), `SELECT id FROM users WHERE email = ? LIMIT 1`, email).Scan(&targetID)
	if errors.Is(err, sql.ErrNoRows) {
		httpapi.WriteError(w, http.StatusNotFound, "User not found")
		return
	}
	if err != nil {
		s.writeErr(w, "POST /api/collections/{id}/transfer-ownership user lookup failed", err)
		return
	}

	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE collections SET owner_user_id = ?, updated_at = ? WHERE id = ?
	`, targetID, now, id); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/transfer-ownership update failed", err)
		return
	}

	if err := tx.Commit(); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/transfer-ownership commit failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]string{
			"ownerUserId": targetID,
		},
	})
}

func (s *Service) handleBulkMoveBooks(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	sourceID := r.PathValue("id")
	if sourceID == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Collection id is required")
		return
	}

	var body struct {
		BookIDs            json.RawMessage `json:"bookIds"`
		AllInCollection    json.RawMessage `json:"allInCollection"`
		ExcludedBookIDs    json.RawMessage `json:"excludedBookIds"`
		TargetCollectionID json.RawMessage `json:"targetCollectionId"`
		Confirmed          json.RawMessage `json:"confirmed"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}

	var targetCollectionID string
	var confirmed bool
	if len(body.TargetCollectionID) == 0 || string(body.TargetCollectionID) == "null" ||
		json.Unmarshal(body.TargetCollectionID, &targetCollectionID) != nil ||
		json.Unmarshal(body.Confirmed, &confirmed) != nil || !confirmed {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose one destination and confirm the source collection access change")
		return
	}

	if err := assertCollectionEditor(r.Context(), s.db, actor.ID, sourceID); err != nil {
		s.writeErr(w, "POST /api/collections/{id}/books/bulk source auth failed", err)
		return
	}

	var excluded []string
	if len(body.ExcludedBookIDs) > 0 && strings.TrimSpace(string(body.ExcludedBookIDs)) != "null" {
		var err error
		excluded, err = parseBookIDArray(body.ExcludedBookIDs)
		if err != nil {
			httpapi.WriteHTTPError(w, err)
			return
		}
	}

	var allInCollection bool
	if len(body.AllInCollection) > 0 {
		_ = json.Unmarshal(body.AllInCollection, &allInCollection)
	}

	var selected []string
	hasSelected := false
	if !allInCollection {
		var err error
		selected, err = parseBookIDArray(body.BookIDs)
		if err != nil {
			httpapi.WriteHTTPError(w, err)
			return
		}
		hasSelected = true
	}

	var bookIDs []string
	if hasSelected && len(selected) == 0 {
		// Empty selection matches 0 rows, which then fails in MoveCollectionBooks with 400.
		bookIDs = nil
	} else {
		where := []string{"collection_id = ?"}
		args := []any{sourceID}
		if hasSelected {
			where = append(where, "id IN ("+makePlaceholders(len(selected))+")")
			for _, id := range selected {
				args = append(args, id)
			}
		}
		if len(excluded) > 0 {
			where = append(where, "id NOT IN ("+makePlaceholders(len(excluded))+")")
			for _, id := range excluded {
				args = append(args, id)
			}
		}
		rows, err := s.db.QueryContext(r.Context(), `
			SELECT id FROM books WHERE `+strings.Join(where, " AND "), args...)
		if err != nil {
			s.writeErr(w, "POST /api/collections/{id}/books/bulk select failed", err)
			return
		}
		for rows.Next() {
			var bid string
			if err := rows.Scan(&bid); err != nil {
				_ = rows.Close()
				s.writeErr(w, "POST /api/collections/{id}/books/bulk scan failed", err)
				return
			}
			bookIDs = append(bookIDs, bid)
		}
		if err := rows.Close(); err != nil {
			s.writeErr(w, "POST /api/collections/{id}/books/bulk close failed", err)
			return
		}
		if err := rows.Err(); err != nil {
			s.writeErr(w, "POST /api/collections/{id}/books/bulk rows err", err)
			return
		}
		if hasSelected && len(bookIDs) != len(selected) {
			httpapi.WriteError(w, http.StatusConflict, "The source selection changed. Review it again.")
			return
		}
	}

	moved, err := MoveCollectionBooks(r.Context(), s.db, actor.ID, bookIDs, targetCollectionID, sourceID)
	if err != nil {
		s.writeErr(w, "POST /api/collections/{id}/books/bulk move failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]int{
			"moved": moved,
		},
	})
}

func (s *Service) handleAdminListCollections(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	if err := assertCollectionAdmin(r.Context(), s.db, actor.ID); err != nil {
		s.writeErr(w, "GET /api/settings/admin/collections auth failed", err)
		return
	}

	type adminCollection struct {
		ID            string  `json:"id"`
		Name          string  `json:"name"`
		OwnerUserID   string  `json:"ownerUserId"`
		OwnerEmail    string  `json:"ownerEmail"`
		IsDefault     bool    `json:"isDefault"`
		Role          *string `json:"role"`
		BookCount     int     `json:"bookCount"`
		IsPersonal    bool    `json:"isPersonal"`
		CanAdminister bool    `json:"canAdminister"`
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT c.id, c.name, c.owner_user_id, u.email, c.is_default, cm.role,
			(SELECT count(*) FROM books b WHERE b.collection_id = c.id) AS bookCount
		FROM collections c
		JOIN users u ON u.id = c.owner_user_id
		LEFT JOIN collection_members cm ON cm.collection_id = c.id AND cm.user_id = ?
		ORDER BY c.is_default DESC, c.name, c.id
	`, actor.ID)
	if err != nil {
		s.writeErr(w, "GET /api/settings/admin/collections query failed", err)
		return
	}
	defer func() { _ = rows.Close() }()

	out := make([]adminCollection, 0)
	for rows.Next() {
		var (
			item      adminCollection
			isDefault int64
			role      sql.NullString
		)
		if err := rows.Scan(
			&item.ID,
			&item.Name,
			&item.OwnerUserID,
			&item.OwnerEmail,
			&isDefault,
			&role,
			&item.BookCount,
		); err != nil {
			s.writeErr(w, "GET /api/settings/admin/collections scan failed", err)
			return
		}
		item.IsDefault = isDefault != 0
		if role.Valid {
			v := role.String
			item.Role = &v
		}
		item.IsPersonal = false
		item.CanAdminister = true
		out = append(out, item)
	}
	if err := rows.Err(); err != nil {
		s.writeErr(w, "GET /api/settings/admin/collections rows err", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data": map[string]any{
			"collections": out,
		},
	})
}

func (s *Service) handleAdminSetDefault(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User

	var body struct {
		CollectionID json.RawMessage `json:"collectionId"`
	}
	if err := httpapi.DecodeJSON(r, &body, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	var collectionID string
	if len(body.CollectionID) == 0 || string(body.CollectionID) == "null" ||
		json.Unmarshal(body.CollectionID, &collectionID) != nil || strings.TrimSpace(collectionID) == "" {
		httpapi.WriteError(w, http.StatusBadRequest, "Choose a collection")
		return
	}

	if err := ChangeDefaultCollection(r.Context(), s.db, actor.ID, collectionID); err != nil {
		s.writeErr(w, "PUT /api/settings/admin/collections/default failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin updated default collection",
		"actorUserId", actor.ID,
		"collectionId", collectionID,
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Service) handleGetMigration(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	if err := assertCollectionAdmin(r.Context(), s.db, actor.ID); err != nil {
		s.writeErr(w, "GET /api/settings/admin/collections-migration auth failed", err)
		return
	}

	preview, err := PreviewCollectionMigration(r.Context(), s.db)
	if err != nil {
		s.writeErr(w, "GET /api/settings/admin/collections-migration failed", err)
		return
	}

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    preview,
	})
}

func (s *Service) handleApplyMigration(w http.ResponseWriter, r *http.Request) {
	actor := httpapi.SessionFromContext(r.Context()).User
	if err := assertCollectionAdmin(r.Context(), s.db, actor.ID); err != nil {
		s.writeErr(w, "POST /api/settings/admin/collections-migration auth failed", err)
		return
	}

	var fields map[string]json.RawMessage
	if err := httpapi.DecodeJSON(r, &fields, httpapi.DefaultMaxBodyBytes, true); err != nil {
		httpapi.WriteHTTPError(w, err)
		return
	}
	if fields == nil {
		httpapi.WriteError(w, http.StatusBadRequest, "Preview the migration and confirm a database and library backup first")
		return
	}

	var (
		fingerprint     string
		rawChoices      []json.RawMessage
		backupConfirmed bool
	)
	if json.Unmarshal(fields["fingerprint"], &fingerprint) != nil ||
		json.Unmarshal(fields["choices"], &rawChoices) != nil ||
		rawChoices == nil ||
		json.Unmarshal(fields["backupConfirmed"], &backupConfirmed) != nil ||
		!backupConfirmed {
		httpapi.WriteError(w, http.StatusBadRequest, "Preview the migration and confirm a database and library backup first")
		return
	}

	choices := make([]MigrationChoice, 0, len(rawChoices))
	for _, rc := range rawChoices {
		var cm map[string]json.RawMessage
		if json.Unmarshal(rc, &cm) != nil || cm == nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid migration choice")
			return
		}
		var bid, cid string
		if json.Unmarshal(cm["bookId"], &bid) != nil || json.Unmarshal(cm["collectionId"], &cid) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid migration choice")
			return
		}
		choices = append(choices, MigrationChoice{BookID: bid, CollectionID: cid})
	}

	var dropboxTargetID *string
	if rawDT, exists := fields["dropboxTargetId"]; exists {
		var dt string
		if string(rawDT) == "null" || json.Unmarshal(rawDT, &dt) != nil {
			httpapi.WriteError(w, http.StatusBadRequest, "Invalid Dropbox destination")
			return
		}
		dropboxTargetID = &dt
	}

	result, err := ApplyCollectionMigration(r.Context(), s.db, s.libraryDir, ApplyMigrationInput{
		Fingerprint:     fingerprint,
		Choices:         choices,
		BackupConfirmed: true,
		DropboxTargetID: dropboxTargetID,
	})
	if err != nil {
		s.writeErr(w, "POST /api/settings/admin/collections-migration failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin applied exclusive collections migration",
		"actorUserId", actor.ID,
		"choices", len(choices),
	)

	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    result,
	})
}

func (s *Service) writeErr(w http.ResponseWriter, logMsg string, err error) {
	if httpapi.WriteHTTPError(w, err) {
		return
	}
	s.logger.Error(logMsg, "error", err)
	httpapi.WriteError(w, http.StatusInternalServerError, "Internal Server Error")
}

func parseCollectionName(raw json.RawMessage) (string, error) {
	var name string
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &name) != nil {
		return "", httpapi.NewError(http.StatusBadRequest, "Enter a collection name of 1 to 120 characters")
	}
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || len(utf16.Encode([]rune(trimmed))) > 120 {
		return "", httpapi.NewError(http.StatusBadRequest, "Enter a collection name of 1 to 120 characters")
	}
	return trimmed, nil
}

func parseMemberEmail(raw json.RawMessage) (string, error) {
	var email string
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &email) != nil {
		return "", httpapi.NewError(http.StatusBadRequest, "An existing user email is required")
	}
	trimmed := strings.ToLower(strings.TrimSpace(email))
	if trimmed == "" {
		return "", httpapi.NewError(http.StatusBadRequest, "An existing user email is required")
	}
	return trimmed, nil
}

func parseBookIDArray(raw json.RawMessage) ([]string, error) {
	var items []json.RawMessage
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, &items) != nil || items == nil || len(items) > maxBulkBookSelect {
		return nil, httpapi.NewError(http.StatusBadRequest, "Invalid book selection")
	}
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, it := range items {
		var s string
		if string(it) == "null" || json.Unmarshal(it, &s) != nil {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid book selection")
		}
		trimmed := strings.TrimSpace(s)
		if trimmed == "" {
			return nil, httpapi.NewError(http.StatusBadRequest, "Invalid book selection")
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		out = append(out, trimmed)
	}
	return out, nil
}
