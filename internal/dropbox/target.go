package dropbox

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/lancewilhelm/delb/internal/collections"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

// Target specifies the resolved importing user and exclusive destination collection.
type Target struct {
	OwnerUserID   string   `json:"ownerUserId"`
	CollectionIDs []string `json:"collectionIds"`
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

	seen := make(map[string]struct{})
	var requested []string
	addID := func(raw string) {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			return
		}
		if _, ok := seen[trimmed]; !ok {
			seen[trimmed] = struct{}{}
			requested = append(requested, trimmed)
		}
	}
	addID(s.TargetCollectionID)
	for _, id := range s.AdditionalCollectionIDs {
		addID(id)
	}

	collectionID, err := collections.ResolveBookTarget(ctx, db, ownerUserID, len(requested) > 0, requested)
	if err != nil {
		return Target{}, err
	}
	return Target{
		OwnerUserID:   ownerUserID,
		CollectionIDs: []string{collectionID},
	}, nil
}
