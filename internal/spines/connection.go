package spines

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/lancewilhelm/delb/internal/httpapi"
)

const (
	codexSharedID      = "spine-generation"
	codexDisplayIssuer = "https://auth.openai.com"
	codexClientID      = "app_EMoamEEZ73f0CkXaXp7hrann"
)

type codexTokens struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresAt    int64  `json:"expiresAt"`
}

type codexAttempt struct {
	userID     string
	sessionID  string
	generation string
	deviceID   string
	code       string
	expiresAt  int64
	nextPoll   int64
	interval   int
	busy       bool
}

type ConnectionStatusResult struct {
	Connected         bool `json:"connected"`
	ReconnectRequired bool `json:"reconnectRequired"`
}

type StartConnectionResult struct {
	AttemptID string `json:"attemptId"`
	Code      string `json:"code"`
	URL       string `json:"url"`
	Interval  int    `json:"interval"`
}

type ActiveConnection struct {
	AccessToken string
	Generation  string
}

type CodexManager struct {
	db          *sql.DB
	secret      string
	authBaseURL string
	apiBaseURL  string
	client      *http.Client
	mu          sync.Mutex
	attempts    map[string]*codexAttempt
}

func NewCodexManager(db *sql.DB, secret, authBaseURL, apiBaseURL string, client *http.Client) *CodexManager {
	if authBaseURL == "" {
		authBaseURL = codexDisplayIssuer
	}
	if apiBaseURL == "" {
		apiBaseURL = "https://chatgpt.com"
	}
	if client == nil {
		client = &http.Client{
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("redirects are not allowed")
			},
		}
	}
	return &CodexManager{
		db:          db,
		secret:      secret,
		authBaseURL: strings.TrimRight(authBaseURL, "/"),
		apiBaseURL:  strings.TrimRight(apiBaseURL, "/"),
		client:      client,
		attempts:    make(map[string]*codexAttempt),
	}
}

func (m *CodexManager) encryptionKey() ([]byte, error) {
	if len(m.secret) < 32 {
		return nil, httpapi.NewError(http.StatusServiceUnavailable, "Set a persistent BETTER_AUTH_SECRET of at least 32 characters to connect ChatGPT.")
	}
	h := sha256.New()
	_, _ = h.Write([]byte("delb-codex-image-v1\x00"))
	_, _ = h.Write([]byte(m.secret))
	return h.Sum(nil), nil
}

// encryptTokens matches Node's aes-256-gcm format in server/utils/codex-image/connection.ts:
// base64(iv[12] || authTag[16] || ciphertext) with AAD = "spine-generation".
func (m *CodexManager) encryptTokens(tokens codexTokens) (string, error) {
	key, err := m.encryptionKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}
	plaintext, err := json.Marshal(tokens)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, iv, plaintext, []byte(codexSharedID))
	tagLen := gcm.Overhead()
	ciphertext := sealed[:len(sealed)-tagLen]
	tag := sealed[len(sealed)-tagLen:]

	combined := make([]byte, 0, len(iv)+len(tag)+len(ciphertext))
	combined = append(combined, iv...)
	combined = append(combined, tag...)
	combined = append(combined, ciphertext...)
	return base64.StdEncoding.EncodeToString(combined), nil
}

func (m *CodexManager) decryptTokens(encoded string) (codexTokens, error) {
	key, err := m.encryptionKey()
	if err != nil {
		return codexTokens{}, err
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) < 28 {
		return codexTokens{}, errors.New("Invalid credential")
	}
	iv := raw[:12]
	tag := raw[12:28]
	ciphertext := raw[28:]

	block, err := aes.NewCipher(key)
	if err != nil {
		return codexTokens{}, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return codexTokens{}, err
	}
	sealed := make([]byte, 0, len(ciphertext)+len(tag))
	sealed = append(sealed, ciphertext...)
	sealed = append(sealed, tag...)

	plain, err := gcm.Open(nil, iv, sealed, []byte(codexSharedID))
	if err != nil {
		return codexTokens{}, errors.New("Invalid credential")
	}
	var parsed map[string]any
	if err := json.Unmarshal(plain, &parsed); err != nil || parsed == nil {
		return codexTokens{}, errors.New("Invalid credential")
	}
	at, ok1 := parsed["accessToken"].(string)
	rt, ok2 := parsed["refreshToken"].(string)
	exp, ok3 := parsed["expiresAt"].(float64)
	if !ok1 || !ok2 || !ok3 || math.IsNaN(exp) || math.IsInf(exp, 0) {
		return codexTokens{}, errors.New("Invalid credential")
	}
	return codexTokens{
		AccessToken:  at,
		RefreshToken: rt,
		ExpiresAt:    int64(exp),
	}, nil
}

func parseOAuthTokens(body []byte, existingRefresh string) (codexTokens, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil || raw == nil {
		return codexTokens{}, errors.New("Invalid token response")
	}
	accessToken, ok := raw["access_token"].(string)
	if !ok || accessToken == "" {
		return codexTokens{}, errors.New("Invalid token response")
	}
	refreshToken := existingRefresh
	if rt, ok := raw["refresh_token"].(string); ok && rt != "" {
		refreshToken = rt
	}
	if refreshToken == "" {
		return codexTokens{}, errors.New("Missing refresh token")
	}
	expiresSec := 3600.0
	if expVal, ok := raw["expires_in"].(float64); ok && !math.IsNaN(expVal) && !math.IsInf(expVal, 0) {
		expiresSec = expVal
	}
	if expiresSec < 0 {
		expiresSec = 0
	}
	expiresAt := time.Now().UTC().UnixMilli() + int64(expiresSec*1000)

	// Narrow expiry using JWT exp claim if present.
	if parts := strings.Split(accessToken, "."); len(parts) >= 2 {
		if decoded, err := base64.RawURLEncoding.DecodeString(parts[1]); err == nil {
			var claims map[string]any
			if json.Unmarshal(decoded, &claims) == nil && claims != nil {
				if expClaim, ok := claims["exp"].(float64); ok && !math.IsNaN(expClaim) && !math.IsInf(expClaim, 0) {
					jwtExpMs := int64(expClaim * 1000)
					if jwtExpMs < expiresAt {
						expiresAt = jwtExpMs
					}
				}
			}
		}
	}

	return codexTokens{
		AccessToken:  accessToken,
		RefreshToken: refreshToken,
		ExpiresAt:    expiresAt,
	}, nil
}

func (m *CodexManager) providerPost(ctx context.Context, targetURL string, payload []byte, contentType string) (*http.Response, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, targetURL, bytes.NewReader(payload))
	if err != nil {
		cancel()
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	resp, err := m.client.Do(req)
	if err != nil {
		cancel()
		return nil, err
	}
	// Wrap body so cancel runs when body closes.
	resp.Body = &cancelOnCloseBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

type cancelOnCloseBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelOnCloseBody) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

func (m *CodexManager) ConnectionStatus(ctx context.Context) (ConnectionStatusResult, error) {
	var state string
	err := m.db.QueryRowContext(ctx, `
		SELECT state FROM shared_codex_image_connection WHERE id = ? LIMIT 1
	`, codexSharedID).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return ConnectionStatusResult{Connected: false, ReconnectRequired: false}, nil
	}
	if err != nil {
		return ConnectionStatusResult{}, err
	}
	return ConnectionStatusResult{
		Connected:         state == "connected",
		ReconnectRequired: state != "connected",
	}, nil
}

func (m *CodexManager) Disconnect(ctx context.Context) error {
	m.mu.Lock()
	clear(m.attempts)
	m.mu.Unlock()
	_, err := m.db.ExecContext(ctx, `DELETE FROM shared_codex_image_connection WHERE id = ?`, codexSharedID)
	return err
}

func (m *CodexManager) StartConnection(ctx context.Context, userID, sessionID string, authorize func() error) (*StartConnectionResult, error) {
	if _, err := m.encryptionKey(); err != nil {
		return nil, err
	}
	generation := uuid.NewString()
	if _, err := m.db.ExecContext(ctx, `
		INSERT INTO shared_codex_image_connection (id, generation, state, encrypted_tokens)
		VALUES (?, ?, 'connecting', NULL)
		ON CONFLICT(id) DO UPDATE SET
			generation = excluded.generation,
			state = 'connecting',
			encrypted_tokens = NULL
	`, codexSharedID, generation); err != nil {
		return nil, err
	}

	reqBody, _ := json.Marshal(map[string]string{"client_id": codexClientID})
	resp, err := m.providerPost(ctx, m.authBaseURL+"/api/accounts/deviceauth/usercode", reqBody, "application/json")
	if err != nil {
		return nil, httpapi.NewError(http.StatusBadGateway, "Could not start ChatGPT sign-in. Try again.")
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, httpapi.NewError(http.StatusBadGateway, "Could not start ChatGPT sign-in. Try again.")
	}
	rawBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, httpapi.NewError(http.StatusBadGateway, "ChatGPT returned an invalid sign-in response.")
	}
	var raw map[string]any
	if err := json.Unmarshal(rawBytes, &raw); err != nil || raw == nil {
		return nil, httpapi.NewError(http.StatusBadGateway, "ChatGPT returned an invalid sign-in response.")
	}
	deviceAuthID, ok1 := raw["device_auth_id"].(string)
	userCode, ok2 := raw["user_code"].(string)
	if !ok1 || !ok2 {
		return nil, httpapi.NewError(http.StatusBadGateway, "ChatGPT returned an invalid sign-in response.")
	}

	interval := 5
	if ivRaw, exists := raw["interval"]; exists {
		switch v := ivRaw.(type) {
		case float64:
			if !math.IsNaN(v) && !math.IsInf(v, 0) {
				interval = int(v)
			}
		case string:
			if parsed, perr := strconv.Atoi(strings.TrimSpace(v)); perr == nil {
				interval = parsed
			}
		}
		if interval < 3 {
			interval = 3
		}
		if interval > 60 {
			interval = 60
		}
	}

	if err := authorize(); err != nil {
		return nil, err
	}

	var curGen, curState string
	err = m.db.QueryRowContext(ctx, `
		SELECT generation, state FROM shared_codex_image_connection WHERE id = ? LIMIT 1
	`, codexSharedID).Scan(&curGen, &curState)
	if err != nil || curGen != generation || curState != "connecting" {
		return nil, httpapi.NewError(http.StatusConflict, "ChatGPT connection changed. Start again.")
	}

	nowMs := time.Now().UTC().UnixMilli()
	attemptID := uuid.NewString()
	m.mu.Lock()
	for id, existing := range m.attempts {
		if existing.generation != generation || existing.expiresAt < nowMs {
			delete(m.attempts, id)
		}
	}
	m.attempts[attemptID] = &codexAttempt{
		userID:     userID,
		sessionID:  sessionID,
		generation: generation,
		deviceID:   deviceAuthID,
		code:       userCode,
		expiresAt:  nowMs + 15*60*1000,
		nextPoll:   nowMs + int64(interval)*1000,
		interval:   interval,
		busy:       false,
	}
	m.mu.Unlock()

	return &StartConnectionResult{
		AttemptID: attemptID,
		Code:      userCode,
		URL:       codexDisplayIssuer + "/codex/device",
		Interval:  interval,
	}, nil
}

func (m *CodexManager) PollConnection(ctx context.Context, userID, sessionID, attemptID string, authorize func() error) (bool, error) {
	nowMs := time.Now().UTC().UnixMilli()
	m.mu.Lock()
	attempt, ok := m.attempts[attemptID]
	if !ok || attempt.userID != userID || attempt.sessionID != sessionID || attempt.expiresAt < nowMs {
		m.mu.Unlock()
		return false, httpapi.NewError(http.StatusGone, "Sign-in expired. Start again.")
	}
	if attempt.busy || attempt.nextPoll > nowMs {
		m.mu.Unlock()
		return false, nil
	}
	attempt.busy = true
	attempt.nextPoll = nowMs + int64(attempt.interval)*1000
	deviceID := attempt.deviceID
	code := attempt.code
	generation := attempt.generation
	m.mu.Unlock()

	defer func() {
		m.mu.Lock()
		attempt.busy = false
		m.mu.Unlock()
	}()

	failPoll := func() (bool, error) {
		m.mu.Lock()
		delete(m.attempts, attemptID)
		m.mu.Unlock()
		return false, httpapi.NewError(http.StatusBadGateway, "ChatGPT sign-in could not be completed. Start again.")
	}

	pollPayload, _ := json.Marshal(map[string]string{
		"device_auth_id": deviceID,
		"user_code":      code,
	})
	resp, err := m.providerPost(ctx, m.authBaseURL+"/api/accounts/deviceauth/token", pollPayload, "application/json")
	if err != nil {
		return failPoll()
	}
	respBody, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if readErr != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return failPoll()
	}

	var raw map[string]any
	if err := json.Unmarshal(respBody, &raw); err != nil || raw == nil {
		return failPoll()
	}
	authCode, ok1 := raw["authorization_code"].(string)
	codeVerifier, ok2 := raw["code_verifier"].(string)
	if !ok1 || !ok2 {
		return failPoll()
	}

	m.mu.Lock()
	delete(m.attempts, attemptID)
	m.mu.Unlock()

	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", authCode)
	form.Set("code_verifier", codeVerifier)
	form.Set("redirect_uri", codexDisplayIssuer+"/deviceauth/callback")
	form.Set("client_id", codexClientID)

	exResp, err := m.providerPost(ctx, m.authBaseURL+"/oauth/token", []byte(form.Encode()), "application/x-www-form-urlencoded")
	if err != nil {
		return failPoll()
	}
	exBody, exReadErr := io.ReadAll(io.LimitReader(exResp.Body, 1<<20))
	_ = exResp.Body.Close()
	if exReadErr != nil || exResp.StatusCode < 200 || exResp.StatusCode >= 300 {
		return failPoll()
	}

	tokens, err := parseOAuthTokens(exBody, "")
	if err != nil {
		return failPoll()
	}
	if err := authorize(); err != nil {
		return failPoll()
	}
	encrypted, err := m.encryptTokens(tokens)
	if err != nil {
		return failPoll()
	}
	res, err := m.db.ExecContext(ctx, `
		UPDATE shared_codex_image_connection
		SET state = 'connected', encrypted_tokens = ?
		WHERE id = ? AND generation = ? AND state = 'connecting'
	`, encrypted, codexSharedID, generation)
	if err != nil {
		return failPoll()
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return failPoll()
	}
	return true, nil
}

func (m *CodexManager) GetConnection(ctx context.Context) (*ActiveConnection, error) {
	var (
		generation string
		state      string
		encTokens  sql.NullString
	)
	err := m.db.QueryRowContext(ctx, `
		SELECT generation, state, encrypted_tokens
		FROM shared_codex_image_connection
		WHERE id = ?
		LIMIT 1
	`, codexSharedID).Scan(&generation, &state, &encTokens)
	if errors.Is(err, sql.ErrNoRows) || state != "connected" || !encTokens.Valid || encTokens.String == "" {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, httpapi.NewError(http.StatusUnauthorized, "An administrator must connect or reconnect ChatGPT to generate a spine.")
	}

	tokens, err := m.decryptTokens(encTokens.String)
	if err != nil {
		var httpErr *httpapi.HTTPError
		if errors.As(err, &httpErr) {
			return nil, httpErr
		}
		return nil, httpapi.NewError(http.StatusUnauthorized, "ChatGPT connection could not be read. Reconnect to continue.")
	}

	if tokens.ExpiresAt > time.Now().UTC().UnixMilli()+120_000 {
		return &ActiveConnection{AccessToken: tokens.AccessToken, Generation: generation}, nil
	}

	claimRes, err := m.db.ExecContext(ctx, `
		UPDATE shared_codex_image_connection
		SET state = 'refreshing', encrypted_tokens = NULL
		WHERE id = ? AND generation = ? AND state = 'connected'
	`, codexSharedID, generation)
	if err != nil {
		return nil, err
	}
	if n, _ := claimRes.RowsAffected(); n == 0 {
		return nil, httpapi.NewError(http.StatusConflict, "ChatGPT connection is changing. Try again.")
	}

	renewErr := httpapi.NewError(http.StatusUnauthorized, "ChatGPT connection needs to be renewed. Reconnect to continue.")
	form := url.Values{}
	form.Set("grant_type", "refresh_token")
	form.Set("refresh_token", tokens.RefreshToken)
	form.Set("client_id", codexClientID)

	resp, err := m.providerPost(ctx, m.authBaseURL+"/oauth/token", []byte(form.Encode()), "application/x-www-form-urlencoded")
	if err != nil {
		return nil, renewErr
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	_ = resp.Body.Close()
	if readErr != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, renewErr
	}
	refreshed, err := parseOAuthTokens(body, tokens.RefreshToken)
	if err != nil {
		return nil, renewErr
	}
	encrypted, err := m.encryptTokens(refreshed)
	if err != nil {
		return nil, renewErr
	}
	updRes, err := m.db.ExecContext(ctx, `
		UPDATE shared_codex_image_connection
		SET state = 'connected', encrypted_tokens = ?
		WHERE id = ? AND generation = ? AND state = 'refreshing'
	`, encrypted, codexSharedID, generation)
	if err != nil {
		return nil, renewErr
	}
	if n, _ := updRes.RowsAffected(); n == 0 {
		return nil, renewErr
	}

	return &ActiveConnection{AccessToken: refreshed.AccessToken, Generation: generation}, nil
}

func (m *CodexManager) IsCurrentConnection(ctx context.Context, generation string) (bool, error) {
	var curGen, curState string
	err := m.db.QueryRowContext(ctx, `
		SELECT generation, state FROM shared_codex_image_connection WHERE id = ? LIMIT 1
	`, codexSharedID).Scan(&curGen, &curState)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return curGen == generation && curState == "connected", nil
}
