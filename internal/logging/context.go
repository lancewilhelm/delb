package logging

import (
	"context"
	"sync"
)

type requestContextKey struct{}

type requestContext struct {
	requestID string

	mu     sync.RWMutex
	userID string
}

// WithRequestID attaches a correlation request ID (and mutable request metadata
// slot) to ctx so all downstream loggers automatically include requestId.
func WithRequestID(ctx context.Context, requestID string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	rc := &requestContext{requestID: requestID}
	return context.WithValue(ctx, requestContextKey{}, rc)
}

// RequestIDFromContext returns the correlation request ID attached to ctx, or "".
func RequestIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	rc, ok := ctx.Value(requestContextKey{}).(*requestContext)
	if !ok || rc == nil {
		return ""
	}
	return rc.requestID
}

// SetRequestUserID records the authenticated user ID on the request metadata
// attached to ctx so outer HTTP access logging middleware can include it.
func SetRequestUserID(ctx context.Context, userID string) {
	if ctx == nil || userID == "" {
		return
	}
	rc, ok := ctx.Value(requestContextKey{}).(*requestContext)
	if !ok || rc == nil {
		return
	}
	rc.mu.Lock()
	rc.userID = userID
	rc.mu.Unlock()
}

// RequestUserIDFromContext returns the authenticated user ID recorded for ctx, or "".
func RequestUserIDFromContext(ctx context.Context) string {
	if ctx == nil {
		return ""
	}
	rc, ok := ctx.Value(requestContextKey{}).(*requestContext)
	if !ok || rc == nil {
		return ""
	}
	rc.mu.RLock()
	id := rc.userID
	rc.mu.RUnlock()
	return id
}
