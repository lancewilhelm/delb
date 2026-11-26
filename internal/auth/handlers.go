package auth

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/lancewilhelm/delb/internal/logging"
)

const (
	minPasswordLength = 6
	maxPasswordLength = 128
	maxAuthBodyBytes  = 1 << 20 // 1 MiB
)

type ServiceOptions struct {
	DB             *sql.DB
	Secret         string
	BaseURL        string
	TrustedOrigins []string
	Logger         *slog.Logger
	RateLimit      RateLimitConfig
}

type Service struct {
	store          *Store
	secret         string
	baseURL        string
	trustedOrigins []string
	logger         *slog.Logger
	limiter        *rateLimiter
}

func NewService(opts ServiceOptions) *Service {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		store:          NewStore(opts.DB),
		secret:         opts.Secret,
		baseURL:        strings.TrimRight(opts.BaseURL, "/"),
		trustedOrigins: opts.TrustedOrigins,
		logger:         logger,
		limiter:        newRateLimiter(opts.RateLimit),
	}
}

// RegisterRoutes mounts all /api/auth/* routes onto mux using Go 1.22+ patterns.
func (s *Service) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/user-count", s.handleUserCount)
	mux.HandleFunc("GET /api/auth/get-session", s.handleGetSession)
	mux.HandleFunc("POST /api/auth/sign-in/email", s.handleSignInEmail)
	mux.HandleFunc("POST /api/auth/sign-up/email", s.handleSignUpEmail)
	mux.HandleFunc("POST /api/auth/sign-out", s.handleSignOut)
	mux.HandleFunc("POST /api/auth/change-password", s.handleChangePassword)
	mux.HandleFunc("POST /api/auth/change-email", s.handleChangeEmail)
	mux.HandleFunc("POST /api/auth/update-user", s.handleUpdateUser)

	mux.HandleFunc("GET /api/auth/admin/list-users", s.handleAdminListUsers)
	mux.HandleFunc("POST /api/auth/admin/create-user", s.handleAdminCreateUser)
	mux.HandleFunc("POST /api/auth/admin/remove-user", s.handleAdminRemoveUser)
	mux.HandleFunc("POST /api/auth/admin/set-role", s.handleAdminSetRole)
	mux.HandleFunc("POST /api/auth/admin/ban-user", s.handleAdminBanUser)
	mux.HandleFunc("POST /api/auth/admin/unban-user", s.handleAdminUnbanUser)
	mux.HandleFunc("POST /api/auth/admin/update-user", s.handleAdminUpdateUser)
	mux.HandleFunc("POST /api/auth/admin/set-user-password", s.handleAdminSetUserPassword)

	// Catch-all for unknown /api/auth/* routes so they never leak to upstream.
	mux.HandleFunc("/api/auth/", func(w http.ResponseWriter, r *http.Request) {
		writeAPIError(w, &APIError{
			Status:  http.StatusNotFound,
			Code:    "NOT_FOUND",
			Message: "Auth endpoint not found",
		})
	})
}

func (s *Service) handleUserCount(w http.ResponseWriter, r *http.Request) {
	n, err := s.store.UserCount(r.Context())
	if err != nil {
		s.logger.Error("failed to count users", "error", err)
		writeInternalError(w)
		return
	}
	writeJSON(w, http.StatusOK, n)
}

// Authenticate resolves the delb.session_token cookie from r, validates the
// session against SQLite, performs Better-Auth sliding-window refresh when w is
// non-nil, and returns (nil, nil) when unauthenticated or expired.
func (s *Service) Authenticate(w http.ResponseWriter, r *http.Request) (*SessionWithUser, error) {
	return s.authenticate(w, r, false)
}

func (s *Service) authenticate(w http.ResponseWriter, r *http.Request, disableRefresh bool) (*SessionWithUser, error) {
	token, sawCookie := ReadSessionCookie(r, s.secret)
	if token == "" {
		if sawCookie && w != nil {
			ClearSessionCookie(w, r, s.baseURL)
		}
		return nil, nil
	}

	swu, err := s.store.FindSessionByToken(r.Context(), token)
	if err != nil {
		return nil, err
	}

	now := time.Now().UTC()
	if swu == nil || swu.SessionExpires.Before(now) {
		if w != nil {
			ClearSessionCookie(w, r, s.baseURL)
		}
		if swu != nil {
			_ = s.store.DeleteSession(r.Context(), token)
		}
		return nil, nil
	}

	// Sliding window refresh matching Better Auth (7d expiresIn, 1d updateAge).
	if !disableRefresh && w != nil {
		refreshThreshold := swu.SessionExpires.Add(-time.Duration(SessionExpiresInSecs-SessionUpdateAgeSecs) * time.Second)
		if !now.Before(refreshThreshold) {
			newExpires := now.Unix() + SessionExpiresInSecs
			ok, refreshErr := s.store.RefreshSession(r.Context(), token, newExpires, now.Unix())
			if refreshErr != nil {
				s.logger.Warn("failed to refresh session", "error", refreshErr)
			} else if ok {
				swu.Session.ExpiresAt = formatTimestamp(newExpires)
				swu.Session.UpdatedAt = formatTimestamp(now.Unix())
				SetSessionCookie(w, r, s.baseURL, s.secret, token, SessionExpiresInSecs)
			}
		}
	}

	logging.SetRequestUserID(r.Context(), swu.User.ID)
	return swu, nil
}

func (s *Service) checkRateLimit(w http.ResponseWriter, r *http.Request, bucket string) bool {
	if s.limiter == nil {
		return true
	}
	ip := clientIP(r)
	key := bucket + ":" + ip
	allowed, retryAfter := s.limiter.Allow(key)
	if !allowed {
		s.logger.WarnContext(r.Context(), "auth rate limit exceeded",
			"bucket", bucket,
			"remoteIp", ip,
			"retryAfterSec", retryAfter,
		)
		w.Header().Set("X-Retry-After", strconv.Itoa(retryAfter))
		w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
		writeAPIError(w, &APIError{
			Status:  http.StatusTooManyRequests,
			Code:    "TOO_MANY_REQUESTS",
			Message: "Too many requests. Please try again later.",
		})
		return false
	}
	return true
}

func (s *Service) handleGetSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")

	disableRefresh := r.URL.Query().Get("disableRefresh") == "true"
	swu, err := s.authenticate(w, r, disableRefresh)
	if err != nil {
		s.logger.Error("failed to read session", "error", err)
		writeInternalError(w)
		return
	}
	if swu == nil {
		writeJSON(w, http.StatusOK, nil)
		return
	}

	writeJSON(w, http.StatusOK, SessionPayload{
		Session: swu.Session,
		User:    swu.User,
	})
}

func (s *Service) handleSignInEmail(w http.ResponseWriter, r *http.Request) {
	if !s.checkRateLimit(w, r, "sign-in") {
		return
	}
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}

	var body struct {
		Email       string  `json:"email"`
		Password    string  `json:"password"`
		CallbackURL *string `json:"callbackURL"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}

	email := strings.ToLower(strings.TrimSpace(body.Email))
	if !isValidEmail(email) {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_EMAIL",
			Message: "Invalid email",
		})
		return
	}
	if len(body.Password) == 0 || len(body.Password) > maxPasswordLength {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "PASSWORD_TOO_LONG",
			Message: "Invalid password",
		})
		return
	}

	user, err := s.store.FindUserByEmail(r.Context(), email)
	if err != nil {
		s.logger.Error("sign-in lookup failed", "error", err)
		writeInternalError(w)
		return
	}

	if user == nil {
		// Timing mitigation matching Better Auth.
		_, _ = HashPassword(body.Password)
		s.logger.WarnContext(r.Context(), "sign-in failed", "reason", "unknown_account", "remoteIp", clientIP(r))
		writeAPIError(w, &APIError{
			Status:  http.StatusUnauthorized,
			Code:    "INVALID_EMAIL_OR_PASSWORD",
			Message: "Invalid email or password",
		})
		return
	}

	storedHash, hasAccount, err := s.store.FindCredentialPassword(r.Context(), user.ID)
	if err != nil {
		s.logger.ErrorContext(r.Context(), "sign-in credential lookup failed", "error", err)
		writeInternalError(w)
		return
	}
	if !hasAccount {
		_, _ = HashPassword(body.Password)
		s.logger.WarnContext(r.Context(), "sign-in failed", "reason", "missing_credential", "userId", user.ID, "remoteIp", clientIP(r))
		writeAPIError(w, &APIError{
			Status:  http.StatusUnauthorized,
			Code:    "INVALID_EMAIL_OR_PASSWORD",
			Message: "Invalid email or password",
		})
		return
	}

	matched, err := VerifyPassword(storedHash, body.Password)
	if err != nil || !matched {
		s.logger.WarnContext(r.Context(), "sign-in failed", "reason", "invalid_password", "userId", user.ID, "remoteIp", clientIP(r))
		writeAPIError(w, &APIError{
			Status:  http.StatusUnauthorized,
			Code:    "INVALID_EMAIL_OR_PASSWORD",
			Message: "Invalid email or password",
		})
		return
	}

	if user.Banned {
		if user.BanExpires != nil {
			if exp, parseErr := time.Parse(iso8601Millis, *user.BanExpires); parseErr == nil && exp.Before(time.Now().UTC()) {
				_ = s.store.ClearExpiredBan(r.Context(), user.ID)
				user.Banned = false
				user.BanReason = nil
				user.BanExpires = nil
			}
		}
		if user.Banned {
			s.logger.WarnContext(r.Context(), "sign-in rejected for banned user", "userId", user.ID, "remoteIp", clientIP(r))
			writeAPIError(w, &APIError{
				Status:  http.StatusForbidden,
				Code:    "BANNED_USER",
				Message: bannedUserDefaultMessage,
			})
			return
		}
	}

	sess, err := s.store.CreateSession(r.Context(), user.ID, clientIP(r), r.UserAgent())
	if err != nil {
		s.logger.ErrorContext(r.Context(), "sign-in session creation failed", "error", err)
		writeInternalError(w)
		return
	}

	logging.SetRequestUserID(r.Context(), user.ID)
	s.logger.InfoContext(r.Context(), "user signed in", "userId", user.ID, "role", user.Role, "remoteIp", clientIP(r))

	SetSessionCookie(w, r, s.baseURL, s.secret, sess.Token, SessionExpiresInSecs)

	resp := SignInResponse{
		Redirect: body.CallbackURL != nil && *body.CallbackURL != "",
		Token:    sess.Token,
		URL:      body.CallbackURL,
		User:     *user,
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Service) handleSignUpEmail(w http.ResponseWriter, r *http.Request) {
	if !s.checkRateLimit(w, r, "sign-up") {
		return
	}
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}

	var body struct {
		Name     string  `json:"name"`
		Email    string  `json:"email"`
		Password string  `json:"password"`
		Image    *string `json:"image"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}

	name := strings.TrimSpace(body.Name)
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if name == "" {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_NAME",
			Message: "Name is required",
		})
		return
	}
	if !isValidEmail(email) {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_EMAIL",
			Message: "Invalid email",
		})
		return
	}
	if pwErr := validatePasswordLength(body.Password); pwErr != nil {
		writeAPIError(w, pwErr)
		return
	}

	passwordHash, err := HashPassword(body.Password)
	if err != nil {
		s.logger.Error("password hashing failed", "error", err)
		writeInternalError(w)
		return
	}

	usr, sess, promoted, err := s.store.SignUpWithEmail(r.Context(), SignUpParams{
		Name:         name,
		Email:        email,
		PasswordHash: passwordHash,
		Image:        body.Image,
		IPAddress:    clientIP(r),
		UserAgent:    r.UserAgent(),
	})
	if err != nil {
		s.writeStoreError(w, "sign-up failed", err)
		return
	}

	logging.SetRequestUserID(r.Context(), usr.ID)
	if promoted {
		s.logger.InfoContext(r.Context(), "initial system owner bootstrap completed", "userId", usr.ID)
	} else {
		s.logger.InfoContext(r.Context(), "user registered", "userId", usr.ID, "role", usr.Role)
	}

	SetSessionCookie(w, r, s.baseURL, s.secret, sess.Token, SessionExpiresInSecs)
	writeJSON(w, http.StatusOK, SignUpResponse{
		Token: sess.Token,
		User:  usr,
	})
}

func (s *Service) handleSignOut(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}

	token, _ := ReadSessionCookie(r, s.secret)
	if token != "" {
		if err := s.store.DeleteSession(r.Context(), token); err != nil {
			s.logger.ErrorContext(r.Context(), "failed to delete session during sign-out", "error", err)
		} else {
			s.logger.InfoContext(r.Context(), "user signed out")
		}
	}
	ClearSessionCookie(w, r, s.baseURL)
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Service) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if !s.checkRateLimit(w, r, "change-password") {
		return
	}
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	swu, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	var body struct {
		CurrentPassword     string `json:"currentPassword"`
		NewPassword         string `json:"newPassword"`
		RevokeOtherSessions bool   `json:"revokeOtherSessions"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}

	if len(body.CurrentPassword) == 0 || len(body.CurrentPassword) > maxPasswordLength {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_PASSWORD",
			Message: "Invalid password",
		})
		return
	}
	if pwErr := validatePasswordLength(body.NewPassword); pwErr != nil {
		writeAPIError(w, pwErr)
		return
	}

	storedHash, hasAccount, err := s.store.FindCredentialPassword(r.Context(), swu.User.ID)
	if err != nil {
		s.logger.Error("change-password credential lookup failed", "error", err)
		writeInternalError(w)
		return
	}
	if !hasAccount {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "CREDENTIAL_ACCOUNT_NOT_FOUND",
			Message: "Credential account not found",
		})
		return
	}

	matched, err := VerifyPassword(storedHash, body.CurrentPassword)
	if err != nil || !matched {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_PASSWORD",
			Message: "Invalid password",
		})
		return
	}

	newHash, err := HashPassword(body.NewPassword)
	if err != nil {
		s.logger.Error("change-password hash failed", "error", err)
		writeInternalError(w)
		return
	}

	newToken, updatedUser, err := s.store.ChangePassword(
		r.Context(),
		swu.User.ID,
		swu.Session.Token,
		newHash,
		body.RevokeOtherSessions,
		clientIP(r),
		r.UserAgent(),
	)
	if err != nil {
		s.writeStoreError(w, "change-password failed", err)
		return
	}

	if newToken != nil {
		SetSessionCookie(w, r, s.baseURL, s.secret, *newToken, SessionExpiresInSecs)
	}

	s.logger.InfoContext(r.Context(), "user password changed",
		"userId", swu.User.ID,
		"revokedOtherSessions", body.RevokeOtherSessions,
	)

	writeJSON(w, http.StatusOK, map[string]any{
		"token": newToken,
		"user":  updatedUser,
	})
}

func (s *Service) handleChangeEmail(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	swu, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	var body struct {
		NewEmail    string `json:"newEmail"`
		CallbackURL string `json:"callbackURL"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}

	newEmail := strings.ToLower(strings.TrimSpace(body.NewEmail))
	if !isValidEmail(newEmail) {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_EMAIL",
			Message: "Invalid email",
		})
		return
	}

	updatedUser, err := s.store.ChangeEmail(r.Context(), swu.User.ID, newEmail)
	if err != nil {
		s.writeStoreError(w, "change-email failed", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status": true,
		"user":   updatedUser,
	})
}

func (s *Service) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	swu, ok := s.requireSession(w, r)
	if !ok {
		return
	}

	var raw map[string]json.RawMessage
	if !decodeJSONBody(w, r, &raw) {
		return
	}

	var namePtr *string
	if v, exists := raw["name"]; exists {
		var name string
		if err := json.Unmarshal(v, &name); err != nil {
			writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid name"})
			return
		}
		trimmed := strings.TrimSpace(name)
		if trimmed == "" {
			writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Name cannot be empty"})
			return
		}
		namePtr = &trimmed
	}

	hasImage := false
	var imagePtr *string
	if v, exists := raw["image"]; exists {
		hasImage = true
		if string(v) != "null" {
			var img string
			if err := json.Unmarshal(v, &img); err != nil {
				writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid image"})
				return
			}
			imagePtr = &img
		}
	}

	if err := s.store.UpdateUserProfile(r.Context(), swu.User.ID, namePtr, hasImage, imagePtr); err != nil {
		s.writeStoreError(w, "update-user failed", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]bool{"status": true})
}

func (s *Service) handleAdminListUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireAdminSession(w, r); !ok {
		return
	}

	q := r.URL.Query()
	params := ListUsersQuery{
		SearchValue:    strings.TrimSpace(q.Get("searchValue")),
		SearchField:    strings.TrimSpace(q.Get("searchField")),
		SearchOperator: strings.TrimSpace(q.Get("searchOperator")),
		SortBy:         strings.TrimSpace(q.Get("sortBy")),
		SortDirection:  strings.TrimSpace(q.Get("sortDirection")),
	}
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		if n, err := strconv.Atoi(rawLimit); err == nil && n > 0 {
			params.Limit = &n
		}
	}
	if rawOffset := strings.TrimSpace(q.Get("offset")); rawOffset != "" {
		if n, err := strconv.Atoi(rawOffset); err == nil && n >= 0 {
			params.Offset = &n
		}
	}

	resp, err := s.store.ListUsers(r.Context(), params)
	if err != nil {
		s.logger.Error("admin list-users failed", "error", err)
		writeInternalError(w)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Service) handleAdminCreateUser(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	actor, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		Email    string         `json:"email"`
		Password string         `json:"password"`
		Name     string         `json:"name"`
		Role     any            `json:"role"`
		Data     map[string]any `json:"data"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}

	email := strings.ToLower(strings.TrimSpace(body.Email))
	name := strings.TrimSpace(body.Name)
	if !isValidEmail(email) {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_EMAIL",
			Message: "Invalid email",
		})
		return
	}
	if name == "" {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "INVALID_NAME",
			Message: "Name is required",
		})
		return
	}

	requestedRole := body.Role
	if requestedRole == nil && body.Data != nil {
		requestedRole = body.Data["role"]
	}
	finalRole := "reader"
	if requestedRole != nil {
		parsed, roleErr := parseAllowedAdminAssignableRole(requestedRole)
		if roleErr != nil {
			writeAPIError(w, roleErr)
			return
		}
		finalRole = parsed
	}

	var passwordHash string
	if body.Password != "" {
		if pwErr := validatePasswordLength(body.Password); pwErr != nil {
			writeAPIError(w, pwErr)
			return
		}
		var err error
		passwordHash, err = HashPassword(body.Password)
		if err != nil {
			s.logger.Error("admin create-user hash failed", "error", err)
			writeInternalError(w)
			return
		}
	}

	usr, err := s.store.AdminCreateUser(r.Context(), AdminCreateUserParams{
		Name:         name,
		Email:        email,
		PasswordHash: passwordHash,
		Role:         finalRole,
	})
	if err != nil {
		s.writeStoreError(w, "admin create-user failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin created user",
		"actorUserId", actor.User.ID,
		"targetUserId", usr.ID,
		"role", usr.Role,
	)

	writeJSON(w, http.StatusOK, map[string]any{"user": usr})
}

func (s *Service) handleAdminRemoveUser(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	swu, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		UserID string `json:"userId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "userId is required"})
		return
	}

	if err := s.store.AdminRemoveUser(r.Context(), swu.User.ID, body.UserID); err != nil {
		s.writeStoreError(w, "admin remove-user failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin removed user",
		"actorUserId", swu.User.ID,
		"targetUserId", body.UserID,
	)

	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (s *Service) handleAdminSetRole(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	actor, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		UserID string `json:"userId"`
		Role   any    `json:"role"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeAPIError(w, &APIError{Status: http.StatusForbidden, Message: "Role change target is required."})
		return
	}

	roleStr, roleErr := parseRoleInput(body.Role)
	if roleErr != nil {
		writeAPIError(w, roleErr)
		return
	}

	updated, err := s.store.AdminSetRole(r.Context(), body.UserID, roleStr)
	if err != nil {
		s.writeStoreError(w, "admin set-role failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin updated user role",
		"actorUserId", actor.User.ID,
		"targetUserId", body.UserID,
		"role", roleStr,
	)

	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Service) handleAdminBanUser(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	swu, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		UserID       string `json:"userId"`
		BanReason    string `json:"banReason"`
		BanExpiresIn *int64 `json:"banExpiresIn"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "userId is required"})
		return
	}

	updated, err := s.store.AdminBanUser(r.Context(), swu.User.ID, body.UserID, body.BanReason, body.BanExpiresIn)
	if err != nil {
		s.writeStoreError(w, "admin ban-user failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin banned user",
		"actorUserId", swu.User.ID,
		"targetUserId", body.UserID,
	)

	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Service) handleAdminUnbanUser(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	actor, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		UserID string `json:"userId"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "userId is required"})
		return
	}

	updated, err := s.store.AdminUnbanUser(r.Context(), body.UserID)
	if err != nil {
		s.writeStoreError(w, "admin unban-user failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin unbanned user",
		"actorUserId", actor.User.ID,
		"targetUserId", body.UserID,
	)

	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (s *Service) handleAdminUpdateUser(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	swu, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		UserID string                     `json:"userId"`
		Data   map[string]json.RawMessage `json:"data"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "userId is required"})
		return
	}
	if len(body.Data) == 0 {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "NO_DATA_TO_UPDATE",
			Message: "No data to update",
		})
		return
	}
	if _, hasPassword := body.Data["password"]; hasPassword {
		writeAPIError(w, &APIError{
			Status:  http.StatusBadRequest,
			Code:    "PASSWORD_CANNOT_BE_UPDATED_VIA_UPDATE_USER",
			Message: "Password cannot be updated via updateUser",
		})
		return
	}

	var fields AdminUpdateUserFields
	if raw, ok := body.Data["name"]; ok {
		var name string
		if err := json.Unmarshal(raw, &name); err != nil || strings.TrimSpace(name) == "" {
			writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid name"})
			return
		}
		fields.HasName = true
		fields.Name = strings.TrimSpace(name)
	}
	if raw, ok := body.Data["email"]; ok {
		var email string
		if err := json.Unmarshal(raw, &email); err != nil || !isValidEmail(strings.ToLower(strings.TrimSpace(email))) {
			writeAPIError(w, &APIError{Status: http.StatusBadRequest, Code: "INVALID_EMAIL", Message: "Invalid email"})
			return
		}
		fields.HasEmail = true
		fields.Email = strings.ToLower(strings.TrimSpace(email))
	}
	if raw, ok := body.Data["role"]; ok {
		var roleVal any
		if err := json.Unmarshal(raw, &roleVal); err != nil {
			writeAPIError(w, &APIError{Status: http.StatusBadRequest, Code: "INVALID_ROLE_TYPE", Message: "Invalid role"})
			return
		}
		roleStr, roleErr := parseRoleInput(roleVal)
		if roleErr != nil {
			writeAPIError(w, roleErr)
			return
		}
		fields.HasRole = true
		fields.Role = roleStr
	}
	if raw, ok := body.Data["image"]; ok {
		fields.HasImage = true
		if string(raw) != "null" {
			var img string
			if err := json.Unmarshal(raw, &img); err != nil {
				writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid image"})
				return
			}
			fields.Image = &img
		}
	}
	if raw, ok := body.Data["banned"]; ok {
		var banned bool
		if err := json.Unmarshal(raw, &banned); err != nil {
			writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid banned flag"})
			return
		}
		fields.HasBanned = true
		fields.Banned = banned
	}
	if raw, ok := body.Data["banReason"]; ok {
		fields.HasBanReason = true
		if string(raw) != "null" {
			var reason string
			if err := json.Unmarshal(raw, &reason); err != nil {
				writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid banReason"})
				return
			}
			fields.BanReason = &reason
		}
	}
	if raw, ok := body.Data["banExpires"]; ok {
		fields.HasBanExpires = true
		if string(raw) != "null" {
			var ts int64
			if err := json.Unmarshal(raw, &ts); err == nil {
				fields.BanExpires = &ts
			} else {
				var iso string
				if err := json.Unmarshal(raw, &iso); err != nil {
					writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid banExpires"})
					return
				}
				parsed, err := time.Parse(time.RFC3339, iso)
				if err != nil {
					writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid banExpires"})
					return
				}
				unix := parsed.UTC().Unix()
				fields.BanExpires = &unix
			}
		}
	}

	updated, err := s.store.AdminUpdateUser(r.Context(), swu.User.ID, body.UserID, fields)
	if err != nil {
		s.writeStoreError(w, "admin update-user failed", err)
		return
	}

	// Better Auth /admin/update-user returns the User object directly.
	writeJSON(w, http.StatusOK, updated)
}

func (s *Service) handleAdminSetUserPassword(w http.ResponseWriter, r *http.Request) {
	if csrfErr := ValidateCSRF(r, s.baseURL, s.trustedOrigins); csrfErr != nil {
		writeAPIError(w, csrfErr)
		return
	}
	actor, ok := s.requireAdminSession(w, r)
	if !ok {
		return
	}

	var body struct {
		UserID      string `json:"userId"`
		NewPassword string `json:"newPassword"`
	}
	if !decodeJSONBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.UserID) == "" {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "userId is required"})
		return
	}
	if pwErr := validatePasswordLength(body.NewPassword); pwErr != nil {
		writeAPIError(w, pwErr)
		return
	}

	hash, err := HashPassword(body.NewPassword)
	if err != nil {
		s.logger.Error("admin set-user-password hash failed", "error", err)
		writeInternalError(w)
		return
	}

	if err := s.store.AdminSetUserPassword(r.Context(), body.UserID, hash); err != nil {
		s.writeStoreError(w, "admin set-user-password failed", err)
		return
	}

	s.logger.InfoContext(r.Context(), "admin reset user password",
		"actorUserId", actor.User.ID,
		"targetUserId", body.UserID,
	)

	writeJSON(w, http.StatusOK, map[string]bool{"status": true})
}

func (s *Service) requireSession(w http.ResponseWriter, r *http.Request) (*SessionWithUser, bool) {
	token, _ := ReadSessionCookie(r, s.secret)
	if token == "" {
		writeAPIError(w, &APIError{
			Status:  http.StatusUnauthorized,
			Code:    "UNAUTHORIZED",
			Message: "Unauthorized",
		})
		return nil, false
	}
	swu, err := s.store.FindSessionByToken(r.Context(), token)
	if err != nil {
		s.logger.Error("session lookup failed", "error", err)
		writeInternalError(w)
		return nil, false
	}
	if swu == nil || swu.SessionExpires.Before(time.Now().UTC()) {
		if swu != nil {
			_ = s.store.DeleteSession(r.Context(), token)
		}
		writeAPIError(w, &APIError{
			Status:  http.StatusUnauthorized,
			Code:    "UNAUTHORIZED",
			Message: "Unauthorized",
		})
		return nil, false
	}
	return swu, true
}

func (s *Service) requireAdminSession(w http.ResponseWriter, r *http.Request) (*SessionWithUser, bool) {
	swu, ok := s.requireSession(w, r)
	if !ok {
		return nil, false
	}
	if swu.User.Role != "admin" && swu.User.Role != "owner" {
		writeAPIError(w, &APIError{
			Status:  http.StatusForbidden,
			Code:    "FORBIDDEN",
			Message: "Administrator access required",
		})
		return nil, false
	}
	return swu, true
}

func (s *Service) writeStoreError(w http.ResponseWriter, logMsg string, err error) {
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		writeAPIError(w, apiErr)
		return
	}
	s.logger.Error(logMsg, "error", err)
	writeInternalError(w)
}

func parseRoleInput(raw any) (string, *APIError) {
	var roles []string
	switch v := raw.(type) {
	case string:
		for _, p := range strings.Split(v, ",") {
			if trimmed := strings.TrimSpace(p); trimmed != "" {
				roles = append(roles, trimmed)
			}
		}
	case []any:
		for _, item := range v {
			str, ok := item.(string)
			if !ok {
				return "", &APIError{Status: http.StatusBadRequest, Code: "INVALID_ROLE_TYPE", Message: "Invalid role type"}
			}
			if trimmed := strings.TrimSpace(str); trimmed != "" {
				roles = append(roles, trimmed)
			}
		}
	default:
		return "", &APIError{Status: http.StatusBadRequest, Code: "INVALID_ROLE_TYPE", Message: "Invalid role type"}
	}
	if len(roles) == 0 {
		return "", &APIError{Status: http.StatusBadRequest, Code: "INVALID_ROLE_TYPE", Message: "Role is required"}
	}
	for _, r := range roles {
		if r != "reader" && r != "editor" && r != "admin" && r != "owner" {
			return "", &APIError{
				Status:  http.StatusBadRequest,
				Code:    "YOU_ARE_NOT_ALLOWED_TO_SET_NON_EXISTENT_VALUE",
				Message: "Role does not exist",
			}
		}
	}
	return strings.Join(roles, ","), nil
}

func parseAllowedAdminAssignableRole(raw any) (string, *APIError) {
	roleStr, err := parseRoleInput(raw)
	if err != nil {
		return "", err
	}
	if roleIncludesOwner(roleStr) {
		return "reader", nil
	}
	if roleStr == "admin" || roleStr == "editor" || roleStr == "reader" {
		return roleStr, nil
	}
	return "reader", nil
}

func validatePasswordLength(password string) *APIError {
	if len(password) < minPasswordLength {
		return &APIError{
			Status:  http.StatusBadRequest,
			Code:    "PASSWORD_TOO_SHORT",
			Message: "Password must be at least 6 characters",
		}
	}
	if len(password) > maxPasswordLength {
		return &APIError{
			Status:  http.StatusBadRequest,
			Code:    "PASSWORD_TOO_LONG",
			Message: "Password is too long",
		}
	}
	return nil
}

func isValidEmail(email string) bool {
	if email == "" || len(email) > 320 || strings.ContainsAny(email, " \t\r\n") {
		return false
	}
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email {
		return false
	}
	at := strings.LastIndexByte(email, '@')
	if at <= 0 || at >= len(email)-1 {
		return false
	}
	domain := email[at+1:]
	return strings.Contains(domain, ".") && !strings.HasPrefix(domain, ".") && !strings.HasSuffix(domain, ".")
}

func clientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func decodeJSONBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	limited := io.LimitReader(r.Body, maxAuthBodyBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Failed to read request body"})
		return false
	}
	if len(raw) > maxAuthBodyBytes {
		writeAPIError(w, &APIError{Status: http.StatusRequestEntityTooLarge, Message: "Request body too large"})
		return false
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Request body is required"})
		return false
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		writeAPIError(w, &APIError{Status: http.StatusBadRequest, Message: "Invalid JSON request body"})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeAPIError(w http.ResponseWriter, err *APIError) {
	status := err.Status
	if status == 0 {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, err)
}

func writeInternalError(w http.ResponseWriter) {
	writeAPIError(w, &APIError{
		Status:  http.StatusInternalServerError,
		Code:    "INTERNAL_SERVER_ERROR",
		Message: "Internal server error",
	})
}
