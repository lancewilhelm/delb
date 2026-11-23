package logging

import "sync"

// RingBuffer is a bounded, thread-safe circular buffer of structured log entries.
type RingBuffer struct {
	mu       sync.RWMutex
	entries  []Entry
	capacity int
	start    int
	count    int
}

// NewRingBuffer creates a ring buffer with the given capacity.
func NewRingBuffer(capacity int) *RingBuffer {
	if capacity <= 0 {
		capacity = DefaultMemoryCapacity
	}
	return &RingBuffer{
		entries:  make([]Entry, capacity),
		capacity: capacity,
	}
}

// Append adds an entry, overwriting the oldest entry when full.
func (r *RingBuffer) Append(entry Entry) {
	r.mu.Lock()
	if r.count < r.capacity {
		idx := (r.start + r.count) % r.capacity
		r.entries[idx] = entry
		r.count++
	} else {
		r.entries[r.start] = entry
		r.start = (r.start + 1) % r.capacity
	}
	r.mu.Unlock()
}

// Snapshot returns a chronological copy of all buffered entries.
func (r *RingBuffer) Snapshot() []Entry {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if r.count == 0 {
		return []Entry{}
	}
	out := make([]Entry, r.count)
	for i := 0; i < r.count; i++ {
		out[i] = r.entries[(r.start+i)%r.capacity]
	}
	return out
}

// Len returns the number of entries currently stored.
func (r *RingBuffer) Len() int {
	r.mu.RLock()
	n := r.count
	r.mu.RUnlock()
	return n
}

// Capacity returns the maximum number of entries retained in memory.
func (r *RingBuffer) Capacity() int {
	return r.capacity
}
