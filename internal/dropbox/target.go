package dropbox

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/httpapi"
	"github.com/lancewilhelm/delb/internal/library"
)

// Target specifies the resolved importing user. Dropbox books go into the
// single shared library; the importing user is recorded as the creator and
// must be an editor or administrator.
type Target struct {
	OwnerUserID string `json:"ownerUserId"`
}

func resolveOwnerUserIDFromSettings(ctx context.Context, db *sql.DB, s Settings) (string, error) {
	if byID := strings.TrimSpace(s.TargetUserID); byID != "" {
		return byID, nil
	}
	if byEmail := strings.TrimSpace(s.TargetUserEmail); byEmail != "" {
		var id string
		err := db.QueryRowContext(ctx, `SELECT id FROM users WHERE email = ? LIMIT 1`, byEmail).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return id, err
	}
	var ownerID string
	err := db.QueryRowContext(ctx, `SELECT id FROM users WHERE role = 'owner' LIMIT 1`).Scan(&ownerID)
	if err == nil && ownerID != "" {
		return ownerID, nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	var firstID string
	err = db.QueryRowContext(ctx, `SELECT id FROM users LIMIT 1`).Scan(&firstID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return firstID, err
}

func resolveDropboxTarget(ctx context.Context, db *sql.DB) (Target, error) {
	root := readGlobalSettingsMap(ctx, db)
	s := parseDropboxSettings(root)

	ownerUserID, err := resolveOwnerUserIDFromSettings(ctx, db, s)
	if err != nil {
		return Target{}, err
	}
	if ownerUserID == "" {
		return Target{}, httpapi.NewError(http.StatusBadRequest, "No users exist to receive dropbox books; create a user or set dropbox.targetUserId")
	}

	if err := library.RequireCatalogEditor(ctx, db, ownerUserID); err != nil {
		return Target{}, httpapi.NewError(http.StatusForbidden, "The Dropbox importing user must be an editor or administrator")
	}
	return Target{OwnerUserID: ownerUserID}, nil
}
