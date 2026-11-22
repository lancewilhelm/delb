package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
)

const DefaultMaxBodyBytes int64 = 1 << 20 // 1 MiB

// HTTPError is a structured HTTP error that handlers can return to produce a
// consistent Delb/H3-compatible JSON response.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string {
	return e.Message
}

func NewError(status int, message string) *HTTPError {
	return &HTTPError{Status: status, Message: message}
}

// WriteJSON encodes payload as UTF-8 JSON with the given HTTP status code.
func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

// WriteError writes a JSON error payload matching both Delb's
// `{ success: false, message }` contract and H3's `{ statusCode, statusMessage, message }` shape.
func WriteError(w http.ResponseWriter, status int, message string) {
	if status == 0 {
		status = http.StatusInternalServerError
	}
	WriteJSON(w, status, map[string]any{
		"success":       false,
		"statusCode":    status,
		"statusMessage": message,
		"message":       message,
	})
}

// WriteHTTPError unwraps an *HTTPError and writes its status/message, falling
// back to 500 Internal Server Error for unexpected errors.
func WriteHTTPError(w http.ResponseWriter, err error) bool {
	if err == nil {
		return false
	}
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		WriteError(w, httpErr.Status, httpErr.Message)
		return true
	}
	return false
}

// ReadBodyBounded reads at most maxBytes from r.Body. If the body exceeds
// maxBytes, it returns a 413 *HTTPError.
func ReadBodyBounded(r *http.Request, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	limited := io.LimitReader(r.Body, maxBytes+1)
	raw, err := io.ReadAll(limited)
	if err != nil {
		return nil, NewError(http.StatusBadRequest, "Failed to read request body")
	}
	if int64(len(raw)) > maxBytes {
		return nil, NewError(http.StatusRequestEntityTooLarge, "Request body too large")
	}
	return raw, nil
}

// DecodeJSON reads a bounded JSON body into dst. If the body is empty or
// whitespace-only and allowEmpty is true, it leaves dst untouched and returns nil.
func DecodeJSON(r *http.Request, dst any, maxBytes int64, allowEmpty bool) error {
	raw, err := ReadBodyBounded(r, maxBytes)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		if allowEmpty {
			return nil
		}
		return NewError(http.StatusBadRequest, "Request body is required")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return NewError(http.StatusBadRequest, "Invalid JSON request body")
	}
	return nil
}
