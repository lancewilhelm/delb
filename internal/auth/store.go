package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	bannedUserDefaultMessage = "You have been banned from this application. Please contact support if you believe this is an error."
)

type queryable interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

func (s *Store) UserCount(ctx context.Context) (int, error) {
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return 0, fmt.Errorf("count users: %w", err)
	}
	return n, nil
}

func allowRegistrationQ(ctx context.Context, q queryable) (bool, error) {
	var raw string
	err := q.QueryRowContext(ctx, `SELECT settings FROM global_settings LIMIT 1`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, fmt.Errorf("read global_settings: %w", err)
	}
	var parsed struct {
		AllowRegistration *bool `json:"allowRegistration"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return true, nil
	}
	if parsed.AllowRegistration == nil {
		return true, nil
	}
	return *parsed.AllowRegistration, nil
}

func (s *Store) FindUserByID(ctx context.Context, id string) (*User, error) {
	return findUserByIDQ(ctx, s.db, id)
}

func findUserByIDQ(ctx context.Context, q queryable, id string) (*User, error) {
	row := q.QueryRowContext(ctx, `
		SELECT id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires
		FROM users
		WHERE id = ?
		LIMIT 1
	`, id)
	return scanUser(row)
}

func (s *Store) FindUserByEmail(ctx context.Context, email string) (*User, error) {
	return findUserByEmailQ(ctx, s.db, strings.ToLower(strings.TrimSpace(email)))
}

func findUserByEmailQ(ctx context.Context, q queryable, email string) (*User, error) {
	row := q.QueryRowContext(ctx, `
		SELECT id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires
		FROM users
		WHERE lower(email) = lower(?)
		LIMIT 1
	`, email)
	return scanUser(row)
}

func (s *Store) FindCredentialPassword(ctx context.Context, userID string) (string, bool, error) {
	var pw sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT password FROM accounts
		WHERE user_id = ? AND provider_id = 'credential' AND account_id = ?
		LIMIT 1
	`, userID, userID).Scan(&pw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("find credential account: %w", err)
	}
	if !pw.Valid || pw.String == "" {
		return "", false, nil
	}
	return pw.String, true, nil
}

type SessionWithUser struct {
	Session        Session
	SessionExpires time.Time
	User           User
	UserBanExpires *time.Time
}

func (s *Store) FindSessionByToken(ctx context.Context, token string) (*SessionWithUser, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT
			s.id, s.token, s.user_id, s.expires_at, s.created_at, s.updated_at,
			s.ip_address, s.user_agent, s.impersonated_by,
			u.id, u.name, u.email, u.email_verified, u.image, u.created_at, u.updated_at,
			u.role, u.banned, u.ban_reason, u.ban_expires
		FROM sessions s
		INNER JOIN users u ON u.id = s.user_id
		WHERE s.token = ?
		LIMIT 1
	`, token)

	var (
		sess             Session
		sessExpiresAt    int64
		sessCreatedAt    int64
		sessUpdatedAt    int64
		sessIP           sql.NullString
		sessUA           sql.NullString
		sessImpersonated sql.NullString

		usr              User
		usrEmailVerified int64
		usrImage         sql.NullString
		usrCreatedAt     int64
		usrUpdatedAt     int64
		usrBanned        sql.NullInt64
		usrBanReason     sql.NullString
		usrBanExpires    sql.NullInt64
	)

	err := row.Scan(
		&sess.ID, &sess.Token, &sess.UserID, &sessExpiresAt, &sessCreatedAt, &sessUpdatedAt,
		&sessIP, &sessUA, &sessImpersonated,
		&usr.ID, &usr.Name, &usr.Email, &usrEmailVerified, &usrImage, &usrCreatedAt, &usrUpdatedAt,
		&usr.Role, &usrBanned, &usrBanReason, &usrBanExpires,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find session by token: %w", err)
	}

	sess.ExpiresAt = formatTimestamp(sessExpiresAt)
	sess.CreatedAt = formatTimestamp(sessCreatedAt)
	sess.UpdatedAt = formatTimestamp(sessUpdatedAt)
	if sessIP.Valid {
		v := sessIP.String
		sess.IPAddress = &v
	}
	if sessUA.Valid {
		v := sessUA.String
		sess.UserAgent = &v
	}
	if sessImpersonated.Valid {
		v := sessImpersonated.String
		sess.ImpersonatedBy = &v
	}

	usr.EmailVerified = usrEmailVerified != 0
	if usrImage.Valid {
		v := usrImage.String
		usr.Image = &v
	}
	usr.CreatedAt = formatTimestamp(usrCreatedAt)
	usr.UpdatedAt = formatTimestamp(usrUpdatedAt)
	usr.Banned = usrBanned.Valid && usrBanned.Int64 != 0
	if usrBanReason.Valid {
		v := usrBanReason.String
		usr.BanReason = &v
	}
	var banExpTime *time.Time
	if usrBanExpires.Valid {
		formatted := formatTimestamp(usrBanExpires.Int64)
		usr.BanExpires = &formatted
		t := parseUnixTimestamp(usrBanExpires.Int64)
		banExpTime = &t
	}

	return &SessionWithUser{
		Session:        sess,
		SessionExpires: parseUnixTimestamp(sessExpiresAt),
		User:           usr,
		UserBanExpires: banExpTime,
	}, nil
}

func (s *Store) CreateSession(ctx context.Context, userID, ipAddress, userAgent string) (Session, error) {
	return createSessionQ(ctx, s.db, userID, ipAddress, userAgent)
}

func createSessionQ(ctx context.Context, q queryable, userID, ipAddress, userAgent string) (Session, error) {
	id, err := generateRandomID(32)
	if err != nil {
		return Session{}, err
	}
	token, err := generateRandomID(32)
	if err != nil {
		return Session{}, err
	}
	now := time.Now().UTC().Unix()
	expiresAt := now + SessionExpiresInSecs

	var ipPtr, uaPtr any
	var ipOut, uaOut *string
	if ipAddress != "" {
		ipPtr = ipAddress
		v := ipAddress
		ipOut = &v
	}
	if userAgent != "" {
		uaPtr = userAgent
		v := userAgent
		uaOut = &v
	}

	_, err = q.ExecContext(ctx, `
		INSERT INTO sessions (id, expires_at, token, created_at, updated_at, ip_address, user_agent, user_id, impersonated_by)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
	`, id, expiresAt, token, now, now, ipPtr, uaPtr, userID)
	if err != nil {
		return Session{}, fmt.Errorf("insert session: %w", err)
	}

	return Session{
		ID:        id,
		Token:     token,
		UserID:    userID,
		ExpiresAt: formatTimestamp(expiresAt),
		CreatedAt: formatTimestamp(now),
		UpdatedAt: formatTimestamp(now),
		IPAddress: ipOut,
		UserAgent: uaOut,
	}, nil
}

func (s *Store) RefreshSession(ctx context.Context, token string, newExpiresAt, now int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `
		UPDATE sessions SET expires_at = ?, updated_at = ? WHERE token = ?
	`, newExpiresAt, now, token)
	if err != nil {
		return false, fmt.Errorf("refresh session: %w", err)
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) DeleteSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE token = ?`, token)
	return err
}

func (s *Store) ClearExpiredBan(ctx context.Context, userID string) error {
	now := time.Now().UTC().Unix()
	_, err := s.db.ExecContext(ctx, `
		UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL, updated_at = ?
		WHERE id = ?
	`, now, userID)
	return err
}

type SignUpParams struct {
	Name         string
	Email        string
	PasswordHash string
	Image        *string
	IPAddress    string
	UserAgent    string
}

// SignUpWithEmail atomically creates a user, credential account, claims owner
// bootstrap if first user, and creates a session. New accounts are readers.
func (s *Store) SignUpWithEmail(ctx context.Context, p SignUpParams) (User, Session, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, Session{}, false, fmt.Errorf("begin sign-up transaction: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	var userCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil {
		return User{}, Session{}, false, fmt.Errorf("count users: %w", err)
	}
	isFirst := userCount == 0

	if !isFirst {
		allowed, err := allowRegistrationQ(ctx, tx)
		if err != nil {
			return User{}, Session{}, false, err
		}
		if !allowed {
			return User{}, Session{}, false, &APIError{
				Status:  http.StatusUnauthorized,
				Code:    "REGISTRATION_CLOSED",
				Message: "Registration is closed.",
			}
		}
	}

	email := strings.ToLower(strings.TrimSpace(p.Email))
	existing, err := findUserByEmailQ(ctx, tx, email)
	if err != nil {
		return User{}, Session{}, false, err
	}
	if existing != nil {
		return User{}, Session{}, false, &APIError{
			Status:  http.StatusUnprocessableEntity,
			Code:    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
			Message: "User already exists. Use another email.",
		}
	}

	userID, err := generateRandomID(32)
	if err != nil {
		return User{}, Session{}, false, err
	}
	accountID, err := generateRandomID(32)
	if err != nil {
		return User{}, Session{}, false, err
	}
	now := time.Now().UTC().Unix()

	var imgArg any
	if p.Image != nil {
		imgArg = *p.Image
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires)
		VALUES (?, ?, ?, 0, ?, ?, ?, 'reader', 0, NULL, NULL)
	`, userID, p.Name, email, imgArg, now, now); err != nil {
		if isUniqueConstraintError(err) {
			return User{}, Session{}, false, &APIError{
				Status:  http.StatusUnprocessableEntity,
				Code:    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
				Message: "User already exists. Use another email.",
			}
		}
		return User{}, Session{}, false, fmt.Errorf("insert user: %w", err)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
		VALUES (?, ?, 'credential', ?, ?, ?, ?)
	`, accountID, userID, userID, p.PasswordHash, now, now); err != nil {
		return User{}, Session{}, false, fmt.Errorf("insert credential account: %w", err)
	}

	promoted, err := claimBootstrapOwnerTx(ctx, tx, userID, now)
	if err != nil {
		return User{}, Session{}, false, err
	}

	sess, err := createSessionQ(ctx, tx, userID, p.IPAddress, p.UserAgent)
	if err != nil {
		return User{}, Session{}, false, err
	}

	usr, err := findUserByIDQ(ctx, tx, userID)
	if err != nil || usr == nil {
		return User{}, Session{}, false, fmt.Errorf("reload created user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return User{}, Session{}, false, fmt.Errorf("commit sign-up: %w", err)
	}
	return *usr, sess, promoted, nil
}

type AdminCreateUserParams struct {
	Name         string
	Email        string
	PasswordHash string
	Role         string
	Image        *string
}

func (s *Store) AdminCreateUser(ctx context.Context, p AdminCreateUserParams) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, fmt.Errorf("begin admin create user: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	var userCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&userCount); err != nil {
		return User{}, err
	}

	email := strings.ToLower(strings.TrimSpace(p.Email))
	existing, err := findUserByEmailQ(ctx, tx, email)
	if err != nil {
		return User{}, err
	}
	if existing != nil {
		return User{}, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
			Message: "User already exists. Use another email.",
		}
	}

	role := "reader"
	if p.Role == "admin" || p.Role == "editor" || p.Role == "reader" {
		role = p.Role
	}

	userID, err := generateRandomID(32)
	if err != nil {
		return User{}, err
	}
	now := time.Now().UTC().Unix()

	var imgArg any
	if p.Image != nil {
		imgArg = *p.Image
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires)
		VALUES (?, ?, ?, 0, ?, ?, ?, ?, 0, NULL, NULL)
	`, userID, p.Name, email, imgArg, now, now, role); err != nil {
		if isUniqueConstraintError(err) {
			return User{}, &APIError{
				Status:  http.StatusBadRequest,
				Code:    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
				Message: "User already exists. Use another email.",
			}
		}
		return User{}, fmt.Errorf("insert user: %w", err)
	}

	if p.PasswordHash != "" {
		accountID, err := generateRandomID(32)
		if err != nil {
			return User{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
			VALUES (?, ?, 'credential', ?, ?, ?, ?)
		`, accountID, userID, userID, p.PasswordHash, now, now); err != nil {
			return User{}, fmt.Errorf("insert credential account: %w", err)
		}
	}

	if _, err := claimBootstrapOwnerTx(ctx, tx, userID, now); err != nil {
		return User{}, err
	}

	usr, err := findUserByIDQ(ctx, tx, userID)
	if err != nil || usr == nil {
		return User{}, fmt.Errorf("reload created user: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return User{}, fmt.Errorf("commit admin create user: %w", err)
	}
	return *usr, nil
}

// claimBootstrapOwnerTx mirrors server/utils/security/bootstrap.ts:
// atomically claims 'owner-bootstrap' in system_state, promotes the first user
// to 'owner' if no owner exists yet.
func claimBootstrapOwnerTx(ctx context.Context, tx *sql.Tx, userID string, now int64) (bool, error) {
	res, err := tx.ExecContext(ctx, `
		INSERT OR IGNORE INTO system_state (key, value) VALUES ('owner-bootstrap', 'complete')
	`)
	if err != nil {
		return false, fmt.Errorf("claim owner-bootstrap: %w", err)
	}
	claimedRows, _ := res.RowsAffected()

	promoted := false
	if claimedRows > 0 {
		var existingOwnerID string
		err := tx.QueryRowContext(ctx, `SELECT id FROM users WHERE role = 'owner' LIMIT 1`).Scan(&existingOwnerID)
		if errors.Is(err, sql.ErrNoRows) {
			updRes, err := tx.ExecContext(ctx, `UPDATE users SET role = 'owner' WHERE id = ?`, userID)
			if err != nil {
				return false, fmt.Errorf("promote bootstrap owner: %w", err)
			}
			if n, _ := updRes.RowsAffected(); n == 0 {
				return false, fmt.Errorf("bootstrap user not found")
			}
			promoted = true
		} else if err != nil {
			return false, fmt.Errorf("check existing owner: %w", err)
		}
	}

	return promoted, nil
}

func (s *Store) ChangePassword(ctx context.Context, userID, currentToken, newHash string, revokeOthers bool, ipAddress, userAgent string) (*string, User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, User{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	now := time.Now().UTC().Unix()
	res, err := tx.ExecContext(ctx, `
		UPDATE accounts SET password = ?, updated_at = ?
		WHERE user_id = ? AND provider_id = 'credential' AND account_id = ?
	`, newHash, now, userID, userID)
	if err != nil {
		return nil, User{}, fmt.Errorf("update password: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, User{}, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "CREDENTIAL_ACCOUNT_NOT_FOUND",
			Message: "Credential account not found",
		}
	}

	var rotatedToken *string
	if revokeOthers {
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID); err != nil {
			return nil, User{}, fmt.Errorf("revoke sessions: %w", err)
		}
		newSess, err := createSessionQ(ctx, tx, userID, ipAddress, userAgent)
		if err != nil {
			return nil, User{}, err
		}
		t := newSess.Token
		rotatedToken = &t
	}

	usr, err := findUserByIDQ(ctx, tx, userID)
	if err != nil || usr == nil {
		return nil, User{}, fmt.Errorf("reload user after password change: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, User{}, err
	}
	return rotatedToken, *usr, nil
}

func (s *Store) ChangeEmail(ctx context.Context, userID, newEmail string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	normalized := strings.ToLower(strings.TrimSpace(newEmail))
	existing, err := findUserByEmailQ(ctx, tx, normalized)
	if err != nil {
		return User{}, err
	}
	if existing != nil && existing.ID != userID {
		return User{}, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "COULDNT_UPDATE_YOUR_EMAIL",
			Message: "Email already in use",
		}
	}

	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(ctx, `
		UPDATE users SET email = ?, email_verified = 0, updated_at = ? WHERE id = ?
	`, normalized, now, userID); err != nil {
		if isUniqueConstraintError(err) {
			return User{}, &APIError{
				Status:  http.StatusBadRequest,
				Code:    "COULDNT_UPDATE_YOUR_EMAIL",
				Message: "Email already in use",
			}
		}
		return User{}, fmt.Errorf("update email: %w", err)
	}

	usr, err := findUserByIDQ(ctx, tx, userID)
	if err != nil || usr == nil {
		return User{}, fmt.Errorf("reload user after email change: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return *usr, nil
}

func (s *Store) UpdateUserProfile(ctx context.Context, userID string, name *string, hasImage bool, image *string) error {
	now := time.Now().UTC().Unix()
	var sets []string
	var args []any
	if name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *name)
	}
	if hasImage {
		sets = append(sets, "image = ?")
		if image == nil {
			args = append(args, nil)
		} else {
			args = append(args, *image)
		}
	}
	if len(sets) == 0 {
		return nil
	}
	sets = append(sets, "updated_at = ?")
	args = append(args, now, userID)

	_, err := s.db.ExecContext(ctx, `UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...)
	return err
}

type ListUsersQuery struct {
	Limit          *int
	Offset         *int
	SearchValue    string
	SearchField    string
	SearchOperator string
	SortBy         string
	SortDirection  string
}

func (s *Store) ListUsers(ctx context.Context, q ListUsersQuery) (ListUsersResponse, error) {
	var whereClause string
	var args []any

	if q.SearchValue != "" {
		col := "email"
		if q.SearchField == "name" {
			col = "name"
		}
		pattern := "%" + q.SearchValue + "%"
		switch q.SearchOperator {
		case "starts_with":
			pattern = q.SearchValue + "%"
		case "ends_with":
			pattern = "%" + q.SearchValue
		}
		whereClause = " WHERE lower(" + col + ") LIKE lower(?)"
		args = append(args, pattern)
	}

	var total int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`+whereClause, args...).Scan(&total); err != nil {
		return ListUsersResponse{}, fmt.Errorf("count users: %w", err)
	}

	orderCol := "created_at"
	switch q.SortBy {
	case "name":
		orderCol = "name"
	case "email":
		orderCol = "email"
	case "role":
		orderCol = "role"
	case "updatedAt", "updated_at":
		orderCol = "updated_at"
	case "createdAt", "created_at":
		orderCol = "created_at"
	}
	orderDir := "DESC"
	if strings.EqualFold(q.SortDirection, "asc") {
		orderDir = "ASC"
	}

	querySQL := `
		SELECT id, name, email, email_verified, image, created_at, updated_at, role, banned, ban_reason, ban_expires
		FROM users` + whereClause + ` ORDER BY ` + orderCol + ` ` + orderDir

	queryArgs := append([]any{}, args...)
	if q.Limit != nil && *q.Limit > 0 {
		querySQL += " LIMIT ?"
		queryArgs = append(queryArgs, *q.Limit)
		if q.Offset != nil && *q.Offset > 0 {
			querySQL += " OFFSET ?"
			queryArgs = append(queryArgs, *q.Offset)
		}
	} else if q.Offset != nil && *q.Offset > 0 {
		querySQL += " LIMIT -1 OFFSET ?"
		queryArgs = append(queryArgs, *q.Offset)
	}

	rows, err := s.db.QueryContext(ctx, querySQL, queryArgs...)
	if err != nil {
		return ListUsersResponse{}, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	users := []User{}
	for rows.Next() {
		u, err := scanUserRows(rows)
		if err != nil {
			return ListUsersResponse{}, err
		}
		users = append(users, u)
	}
	if err := rows.Err(); err != nil {
		return ListUsersResponse{}, err
	}

	return ListUsersResponse{
		Users:  users,
		Total:  total,
		Limit:  q.Limit,
		Offset: q.Offset,
	}, nil
}

// GuardUserDeletion enforces server/utils/auth.ts guardUserDeletion:
//   - System owner -> 403 Forbidden ("The system owner cannot be removed")
func guardUserDeletionQ(ctx context.Context, q queryable, userID string) error {
	var role string
	err := q.QueryRowContext(ctx, `SELECT role FROM users WHERE id = ? LIMIT 1`, userID).Scan(&role)
	if err == nil && role == "owner" {
		return &APIError{
			Status:  http.StatusForbidden,
			Message: "The system owner cannot be removed",
		}
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("check user role before deletion: %w", err)
	}

	return nil
}

func (s *Store) AdminRemoveUser(ctx context.Context, actorID, targetUserID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if err := guardUserDeletionQ(ctx, tx, targetUserID); err != nil {
		return err
	}
	if targetUserID == actorID {
		return &APIError{
			Status:  http.StatusBadRequest,
			Code:    "YOU_CANNOT_REMOVE_YOURSELF",
			Message: "You cannot remove yourself",
		}
	}
	target, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil {
		return err
	}
	if target == nil {
		return &APIError{
			Status:  http.StatusNotFound,
			Code:    "USER_NOT_FOUND",
			Message: "User not found",
		}
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, targetUserID); err != nil {
		return fmt.Errorf("delete user sessions: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, targetUserID); err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	return tx.Commit()
}

func (s *Store) AdminSetRole(ctx context.Context, targetUserID, newRole string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	target, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil {
		return User{}, err
	}
	if target == nil {
		return User{}, &APIError{
			Status:  http.StatusNotFound,
			Code:    "USER_NOT_FOUND",
			Message: "User not found",
		}
	}
	if target.Role == "owner" || roleIncludesOwner(newRole) {
		return User{}, &APIError{
			Status:  http.StatusForbidden,
			Message: "The system owner role cannot be changed.",
		}
	}

	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(ctx, `UPDATE users SET role = ?, updated_at = ? WHERE id = ?`, newRole, now, targetUserID); err != nil {
		return User{}, fmt.Errorf("update user role: %w", err)
	}
	updated, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil || updated == nil {
		return User{}, fmt.Errorf("reload user after set-role: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return *updated, nil
}

func (s *Store) AdminBanUser(ctx context.Context, actorID, targetUserID, reason string, banExpiresIn *int64) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	target, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil {
		return User{}, err
	}
	if target == nil {
		return User{}, &APIError{
			Status:  http.StatusNotFound,
			Code:    "USER_NOT_FOUND",
			Message: "User not found",
		}
	}
	if targetUserID == actorID {
		return User{}, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "YOU_CANNOT_BAN_YOURSELF",
			Message: "You cannot ban yourself",
		}
	}
	if target.Role == "owner" {
		return User{}, &APIError{
			Status:  http.StatusForbidden,
			Message: "The system owner cannot be banned.",
		}
	}

	now := time.Now().UTC().Unix()
	if strings.TrimSpace(reason) == "" {
		reason = "No reason"
	}
	var expiresArg any
	if banExpiresIn != nil && *banExpiresIn > 0 {
		expiresArg = now + *banExpiresIn
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE users SET banned = 1, ban_reason = ?, ban_expires = ?, updated_at = ? WHERE id = ?
	`, reason, expiresArg, now, targetUserID); err != nil {
		return User{}, fmt.Errorf("ban user: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, targetUserID); err != nil {
		return User{}, fmt.Errorf("delete banned user sessions: %w", err)
	}

	updated, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil || updated == nil {
		return User{}, fmt.Errorf("reload banned user: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return *updated, nil
}

func (s *Store) AdminUnbanUser(ctx context.Context, targetUserID string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	target, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil {
		return User{}, err
	}
	if target == nil {
		return User{}, &APIError{
			Status:  http.StatusNotFound,
			Code:    "USER_NOT_FOUND",
			Message: "User not found",
		}
	}

	now := time.Now().UTC().Unix()
	if _, err := tx.ExecContext(ctx, `
		UPDATE users SET banned = 0, ban_reason = NULL, ban_expires = NULL, updated_at = ? WHERE id = ?
	`, now, targetUserID); err != nil {
		return User{}, fmt.Errorf("unban user: %w", err)
	}

	updated, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil || updated == nil {
		return User{}, fmt.Errorf("reload unbanned user: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return *updated, nil
}

type AdminUpdateUserFields struct {
	HasName       bool
	Name          string
	HasEmail      bool
	Email         string
	HasRole       bool
	Role          string
	HasImage      bool
	Image         *string
	HasBanned     bool
	Banned        bool
	HasBanReason  bool
	BanReason     *string
	HasBanExpires bool
	BanExpires    *int64
}

func (s *Store) AdminUpdateUser(ctx context.Context, actorID, targetUserID string, f AdminUpdateUserFields) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	target, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil {
		return User{}, err
	}
	if target == nil {
		return User{}, &APIError{
			Status:  http.StatusNotFound,
			Code:    "USER_NOT_FOUND",
			Message: "User not found",
		}
	}

	if f.HasRole && (target.Role == "owner" || roleIncludesOwner(f.Role)) {
		return User{}, &APIError{
			Status:  http.StatusForbidden,
			Message: "The system owner role cannot be changed.",
		}
	}
	if f.HasBanned && f.Banned {
		if targetUserID == actorID {
			return User{}, &APIError{
				Status:  http.StatusBadRequest,
				Code:    "YOU_CANNOT_BAN_YOURSELF",
				Message: "You cannot ban yourself",
			}
		}
		if target.Role == "owner" {
			return User{}, &APIError{
				Status:  http.StatusForbidden,
				Message: "The system owner cannot be banned.",
			}
		}
	}

	var sets []string
	var args []any

	if f.HasName {
		sets = append(sets, "name = ?")
		args = append(args, f.Name)
	}
	if f.HasEmail {
		normalized := strings.ToLower(strings.TrimSpace(f.Email))
		existing, err := findUserByEmailQ(ctx, tx, normalized)
		if err != nil {
			return User{}, err
		}
		if existing != nil && existing.ID != targetUserID {
			return User{}, &APIError{
				Status:  http.StatusBadRequest,
				Code:    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
				Message: "User already exists. Use another email.",
			}
		}
		sets = append(sets, "email = ?")
		args = append(args, normalized)
	}
	if f.HasRole {
		sets = append(sets, "role = ?")
		args = append(args, f.Role)
	}
	if f.HasImage {
		sets = append(sets, "image = ?")
		if f.Image == nil {
			args = append(args, nil)
		} else {
			args = append(args, *f.Image)
		}
	}
	if f.HasBanned {
		sets = append(sets, "banned = ?")
		if f.Banned {
			args = append(args, 1)
		} else {
			args = append(args, 0)
		}
	}
	if f.HasBanReason {
		sets = append(sets, "ban_reason = ?")
		if f.BanReason == nil {
			args = append(args, nil)
		} else {
			args = append(args, *f.BanReason)
		}
	}
	if f.HasBanExpires {
		sets = append(sets, "ban_expires = ?")
		if f.BanExpires == nil {
			args = append(args, nil)
		} else {
			args = append(args, *f.BanExpires)
		}
	}

	if len(sets) == 0 {
		return User{}, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "NO_DATA_TO_UPDATE",
			Message: "No data to update",
		}
	}

	now := time.Now().UTC().Unix()
	sets = append(sets, "updated_at = ?")
	args = append(args, now, targetUserID)

	if _, err := tx.ExecContext(ctx, `UPDATE users SET `+strings.Join(sets, ", ")+` WHERE id = ?`, args...); err != nil {
		if isUniqueConstraintError(err) {
			return User{}, &APIError{
				Status:  http.StatusBadRequest,
				Code:    "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
				Message: "User already exists. Use another email.",
			}
		}
		return User{}, fmt.Errorf("admin update user: %w", err)
	}

	if f.HasBanned && f.Banned {
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, targetUserID); err != nil {
			return User{}, fmt.Errorf("delete banned user sessions: %w", err)
		}
	}

	updated, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil || updated == nil {
		return User{}, fmt.Errorf("reload user after admin update: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return *updated, nil
}

func (s *Store) AdminSetUserPassword(ctx context.Context, targetUserID, newHash string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	target, err := findUserByIDQ(ctx, tx, targetUserID)
	if err != nil {
		return err
	}
	if target == nil {
		return &APIError{
			Status:  http.StatusNotFound,
			Code:    "USER_NOT_FOUND",
			Message: "User not found",
		}
	}

	now := time.Now().UTC().Unix()
	res, err := tx.ExecContext(ctx, `
		UPDATE accounts SET password = ?, updated_at = ?
		WHERE user_id = ? AND provider_id = 'credential' AND account_id = ?
	`, newHash, now, targetUserID, targetUserID)
	if err != nil {
		return fmt.Errorf("update user password: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		accountID, err := generateRandomID(32)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
			VALUES (?, ?, 'credential', ?, ?, ?, ?)
		`, accountID, targetUserID, targetUserID, newHash, now, now); err != nil {
			return fmt.Errorf("create credential account: %w", err)
		}
	}

	return tx.Commit()
}

func scanUser(row *sql.Row) (*User, error) {
	var (
		u             User
		emailVerified int64
		image         sql.NullString
		createdAt     int64
		updatedAt     int64
		banned        sql.NullInt64
		banReason     sql.NullString
		banExpires    sql.NullInt64
	)
	err := row.Scan(
		&u.ID, &u.Name, &u.Email, &emailVerified, &image,
		&createdAt, &updatedAt, &u.Role, &banned, &banReason, &banExpires,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	u.EmailVerified = emailVerified != 0
	if image.Valid {
		v := image.String
		u.Image = &v
	}
	u.CreatedAt = formatTimestamp(createdAt)
	u.UpdatedAt = formatTimestamp(updatedAt)
	u.Banned = banned.Valid && banned.Int64 != 0
	if banReason.Valid {
		v := banReason.String
		u.BanReason = &v
	}
	if banExpires.Valid {
		v := formatTimestamp(banExpires.Int64)
		u.BanExpires = &v
	}
	return &u, nil
}

func scanUserRows(rows *sql.Rows) (User, error) {
	var (
		u             User
		emailVerified int64
		image         sql.NullString
		createdAt     int64
		updatedAt     int64
		banned        sql.NullInt64
		banReason     sql.NullString
		banExpires    sql.NullInt64
	)
	if err := rows.Scan(
		&u.ID, &u.Name, &u.Email, &emailVerified, &image,
		&createdAt, &updatedAt, &u.Role, &banned, &banReason, &banExpires,
	); err != nil {
		return User{}, err
	}
	u.EmailVerified = emailVerified != 0
	if image.Valid {
		v := image.String
		u.Image = &v
	}
	u.CreatedAt = formatTimestamp(createdAt)
	u.UpdatedAt = formatTimestamp(updatedAt)
	u.Banned = banned.Valid && banned.Int64 != 0
	if banReason.Valid {
		v := banReason.String
		u.BanReason = &v
	}
	if banExpires.Valid {
		v := formatTimestamp(banExpires.Int64)
		u.BanExpires = &v
	}
	return u, nil
}

func roleIncludesOwner(role string) bool {
	for _, part := range strings.Split(role, ",") {
		if strings.TrimSpace(part) == "owner" {
			return true
		}
	}
	return false
}

func isUniqueConstraintError(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "UNIQUE constraint failed") || strings.Contains(msg, "constraint failed")
}

// generateRandomID generates a Better Auth style URL-safe alphanumeric ID/token.
func generateRandomID(length int) (string, error) {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	raw := make([]byte, length)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate random id: %w", err)
	}
	out := make([]byte, length)
	for i, b := range raw {
		out[i] = alphabet[int(b)%len(alphabet)]
	}
	return string(out), nil
}

func newUUIDv4() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}
