package auth

import "time"

const iso8601Millis = "2006-01-02T15:04:05.000Z"

// APIError represents a Better Auth-compatible JSON error response.
type APIError struct {
	Status  int    `json:"-"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

func (e *APIError) Error() string {
	return e.Message
}

// User matches the Better Auth user JSON wire shape consumed by app/utils/authClient.ts.
type User struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Email         string  `json:"email"`
	EmailVerified bool    `json:"emailVerified"`
	Image         *string `json:"image"`
	CreatedAt     string  `json:"createdAt"`
	UpdatedAt     string  `json:"updatedAt"`
	Role          string  `json:"role"`
	Banned        bool    `json:"banned"`
	BanReason     *string `json:"banReason"`
	BanExpires    *string `json:"banExpires"`
}

// Session matches the Better Auth session JSON wire shape consumed by app/utils/authClient.ts.
type Session struct {
	ID             string  `json:"id"`
	Token          string  `json:"token"`
	UserID         string  `json:"userId"`
	ExpiresAt      string  `json:"expiresAt"`
	CreatedAt      string  `json:"createdAt"`
	UpdatedAt      string  `json:"updatedAt"`
	IPAddress      *string `json:"ipAddress"`
	UserAgent      *string `json:"userAgent"`
	ImpersonatedBy *string `json:"impersonatedBy"`
}

type SessionPayload struct {
	Session Session `json:"session"`
	User    User    `json:"user"`
}

type SignInResponse struct {
	Redirect bool    `json:"redirect"`
	Token    string  `json:"token"`
	URL      *string `json:"url,omitempty"`
	User     User    `json:"user"`
}

type SignUpResponse struct {
	Token string `json:"token"`
	User  User   `json:"user"`
}

type ListUsersResponse struct {
	Users  []User `json:"users"`
	Total  int    `json:"total"`
	Limit  *int   `json:"limit,omitempty"`
	Offset *int   `json:"offset,omitempty"`
}

func formatTimestamp(ts int64) string {
	if ts > 1_000_000_000_000 {
		return time.UnixMilli(ts).UTC().Format(iso8601Millis)
	}
	return time.Unix(ts, 0).UTC().Format(iso8601Millis)
}

func parseUnixTimestamp(ts int64) time.Time {
	if ts > 1_000_000_000_000 {
		return time.UnixMilli(ts).UTC()
	}
	return time.Unix(ts, 0).UTC()
}
