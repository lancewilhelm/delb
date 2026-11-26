package dropbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/lancewilhelm/delb/internal/library"
	"github.com/lancewilhelm/delb/internal/storage"
)

const invalidClaimTargetMsg = "Dropbox claim has no valid retained importing user. Review the file and retry it explicitly."

func finishCommittedDropboxClaim(input, destination string, removeDecision func() error) error {
	same, err := storage.SameFileContents(input, destination)
	if err != nil || !same {
		return fmt.Errorf("Dropbox committed copy cannot be verified: %s", input)
	}
	if err := os.Remove(input); err != nil {
		return err
	}
	return removeDecision()
}

func retainDropboxClaimTarget(ctx context.Context, q library.Queryable, operationID string, target Target) (Target, error) {
	encoded, err := json.Marshal(target)
	if err != nil {
		return Target{}, err
	}
	if _, err := q.ExecContext(ctx, `
		INSERT INTO system_state (key, value)
		VALUES (?, ?)
		ON CONFLICT DO NOTHING
	`, "dropbox-claim:"+operationID, string(encoded)); err != nil {
		return Target{}, err
	}
	return readDropboxClaimTarget(ctx, q, operationID)
}

func readDropboxClaimTarget(ctx context.Context, q library.Queryable, operationID string) (Target, error) {
	var raw string
	err := q.QueryRowContext(ctx, `SELECT value FROM system_state WHERE key = ? LIMIT 1`, "dropbox-claim:"+operationID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return Target{}, errors.New(invalidClaimTargetMsg)
	}
	if err != nil {
		return Target{}, err
	}
	var parsed struct {
		OwnerUserID *string `json:"ownerUserId"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return Target{}, errors.New(invalidClaimTargetMsg)
	}
	if parsed.OwnerUserID == nil || strings.TrimSpace(*parsed.OwnerUserID) == "" {
		return Target{}, errors.New(invalidClaimTargetMsg)
	}
	return Target{OwnerUserID: *parsed.OwnerUserID}, nil
}

func removeDropboxClaimTarget(ctx context.Context, q library.Queryable, operationID string) error {
	_, err := q.ExecContext(ctx, `DELETE FROM system_state WHERE key = ?`, "dropbox-claim:"+operationID)
	return err
}
