package auth

import (
	"math"
	"sync"
	"time"
)

// RateLimitConfig configures fixed-window per-IP rate limiting on sensitive
// auth mutation endpoints (sign-in, sign-up, change-password).
type RateLimitConfig struct {
	Window      time.Duration
	MaxRequests int
	Disabled    bool
}

const (
	defaultRateLimitWindow = 10 * time.Second
	defaultRateLimitMax    = 30
)

type rateLimitBucket struct {
	count   int
	resetAt time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	window  time.Duration
	maxReqs int
	buckets map[string]*rateLimitBucket
	now     func() time.Time
	ops     int
}

func newRateLimiter(cfg RateLimitConfig) *rateLimiter {
	if cfg.Disabled {
		return nil
	}
	window := cfg.Window
	if window <= 0 {
		window = defaultRateLimitWindow
	}
	maxReqs := cfg.MaxRequests
	if maxReqs <= 0 {
		maxReqs = defaultRateLimitMax
	}
	return &rateLimiter{
		window:  window,
		maxReqs: maxReqs,
		buckets: make(map[string]*rateLimitBucket),
		now:     time.Now,
	}
}

// Allow checks whether key may perform a request right now.
// When denied, retryAfterSeconds is a positive integer bounded to >= 1.
func (rl *rateLimiter) Allow(key string) (allowed bool, retryAfterSeconds int) {
	if rl == nil {
		return true, 0
	}
	now := rl.now()

	rl.mu.Lock()
	defer rl.mu.Unlock()

	rl.ops++
	if rl.ops%256 == 0 {
		for k, b := range rl.buckets {
			if !now.Before(b.resetAt) {
				delete(rl.buckets, k)
			}
		}
	}

	b, ok := rl.buckets[key]
	if !ok || !now.Before(b.resetAt) {
		rl.buckets[key] = &rateLimitBucket{
			count:   1,
			resetAt: now.Add(rl.window),
		}
		return true, 0
	}

	if b.count >= rl.maxReqs {
		rem := b.resetAt.Sub(now)
		secs := int(math.Ceil(rem.Seconds()))
		if secs < 1 {
			secs = 1
		}
		return false, secs
	}

	b.count++
	return true, 0
}
